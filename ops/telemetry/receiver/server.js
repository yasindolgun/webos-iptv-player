'use strict';

const http = require('http');

const DEFAULT_PORT = 4318;
const DEFAULT_LOKI_URL = 'http://loki:3100/loki/api/v1/push';
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_EVENTS = 100;
const UPSTREAM_TIMEOUT_MS = 5000;

class RequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

class UpstreamError extends Error {
  constructor(status) {
    super(`loki_http_${status}`);
    this.status = status;
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function send(res, status, body) {
  cors(res);
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        settled = true;
        chunks.length = 0;
        reject(new RequestError(413, 'payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function safeString(value, max) {
  return value.slice(0, max);
}

function safeLabel(value, fallback) {
  const clean = safeString(value, 100).replace(/[^a-zA-Z0-9._-]/g, '_');
  return clean || fallback;
}

function validateEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)
      || value.timestamp <= 0) return null;
  if (!['debug', 'info', 'warn', 'error'].includes(value.level)) return null;
  if (typeof value.event !== 'string' || value.event.length < 1) return null;
  if (typeof value.tag !== 'string' || value.tag.length < 1) return null;
  if (typeof value.message !== 'string' || typeof value.appVersion !== 'string'
      || value.appVersion.length < 1 || typeof value.deviceId !== 'string'
      || value.deviceId.length < 1 || typeof value.sessionId !== 'string') return null;
  return {
    timestamp: Math.round(value.timestamp),
    level: value.level,
    event: safeLabel(value.event, 'unknown'),
    tag: safeLabel(value.tag, 'Unknown'),
    message: safeString(value.message, 2000),
    appVersion: safeLabel(value.appVersion, 'unknown'),
    deviceId: safeLabel(value.deviceId, 'unknown'),
    sessionId: safeString(value.sessionId, 100),
  };
}

function validatePayload(value, maxEvents) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== 1 || !Array.isArray(value.events)
      || value.events.length < 1 || value.events.length > maxEvents) {
    throw new RequestError(400, 'invalid_payload');
  }
  const events = value.events.map(validateEvent);
  if (events.some(event => event === null)) {
    throw new RequestError(400, 'invalid_event');
  }
  return events;
}

function lokiPayload(events) {
  const streams = new Map();
  for (const event of events) {
    const stream = {
      app: 'webos-iptv-player',
      version: event.appVersion,
      level: event.level,
      event: event.event,
      device: event.deviceId,
    };
    const key = JSON.stringify(stream);
    let entry = streams.get(key);
    if (!entry) {
      entry = { stream, values: [] };
      streams.set(key, entry);
    }
    entry.values.push([
      `${event.timestamp}000000`,
      JSON.stringify(event),
    ]);
  }
  return {
    streams: Array.from(streams.values()),
  };
}

function defaultReadyUrl(lokiUrl) {
  const url = new URL(lokiUrl);
  url.pathname = '/ready';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function timedFetch(fetchImpl, url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function createReceiverServer(options = {}) {
  const lokiUrl = options.lokiUrl || DEFAULT_LOKI_URL;
  const lokiReadyUrl = options.lokiReadyUrl || defaultReadyUrl(lokiUrl);
  const maxBodyBytes = options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;
  const maxEvents = options.maxEvents || DEFAULT_MAX_EVENTS;
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const ingest = {
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: '',
  };

  async function pushToLoki(events) {
    const response = await timedFetch(fetchImpl, lokiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lokiPayload(events)),
    });
    if (!response.ok) throw new UpstreamError(response.status);
  }

  async function readiness(res) {
    try {
      const response = await timedFetch(fetchImpl, lokiReadyUrl, { method: 'GET' });
      if (!response.ok) throw new Error(`loki_ready_http_${response.status}`);
      if (ingest.lastError) {
        send(res, 503, {
          status: 'unavailable',
          check: 'readiness',
          dependencies: { loki: 'ready' },
          ingest,
        });
        return;
      }
      send(res, 200, {
        status: 'ok',
        check: 'readiness',
        dependencies: { loki: 'ready' },
        ingest,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(res, 503, {
        status: 'unavailable',
        check: 'readiness',
        dependencies: { loki: 'unavailable' },
        error: message,
        ingest,
      });
    }
  }

  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      cors(res);
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      send(res, 200, { status: 'ok', check: 'liveness' });
      return;
    }
    if (req.method === 'GET' && req.url === '/ready') {
      await readiness(res);
      return;
    }
    if (req.method !== 'POST' || req.url !== '/api/v1/events') {
      send(res, 404, { error: 'not_found' });
      return;
    }

    try {
      const body = await readBody(req, maxBodyBytes);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new RequestError(400, 'invalid_json');
      }
      const events = validatePayload(payload, maxEvents);
      await pushToLoki(events);
      ingest.lastSuccessAt = new Date().toISOString();
      ingest.lastFailureAt = null;
      ingest.lastError = '';
      res.statusCode = 204;
      cors(res);
      res.end();
    } catch (error) {
      if (error instanceof RequestError) {
        send(res, error.status, { error: error.code });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      ingest.lastFailureAt = new Date().toISOString();
      ingest.lastError = message;
      logger.error('[receiver] ingest failed:', message);
      if (error instanceof UpstreamError && error.status >= 400
          && error.status < 500 && error.status !== 408 && error.status !== 429) {
        send(res, 422, { error: 'ingest_rejected' });
        return;
      }
      res.setHeader('Retry-After', '10');
      send(res, 503, { error: 'ingest_unavailable' });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const server = createReceiverServer({
    lokiUrl: process.env.LOKI_URL,
    lokiReadyUrl: process.env.LOKI_READY_URL,
    maxBodyBytes: Number(process.env.MAX_BODY_BYTES) || DEFAULT_MAX_BODY_BYTES,
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[receiver] listening on port ${port}`);
  });
}

module.exports = {
  createReceiverServer,
  lokiPayload,
  validateEvent,
};
