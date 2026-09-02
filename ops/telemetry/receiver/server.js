'use strict';

const http = require('http');

const PORT = 4318;
const LOKI_URL = process.env.LOKI_URL || 'http://loki:3100/loki/api/v1/push';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES) || 256 * 1024;
const MAX_EVENTS = 100;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function send(res, status, body) {
  cors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function safeLabel(value, fallback) {
  const clean = safeString(value, 100).replace(/[^a-zA-Z0-9._-]/g, '_');
  return clean || fallback;
}

function validateEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const timestamp = Number(value.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const level = ['debug', 'info', 'warn', 'error'].includes(value.level)
    ? value.level
    : 'info';
  return {
    timestamp: Math.round(timestamp),
    level,
    event: safeLabel(value.event, 'unknown'),
    tag: safeLabel(value.tag, 'Unknown'),
    message: safeString(value.message, 2000),
    appVersion: safeLabel(value.appVersion, 'unknown'),
    deviceId: safeLabel(value.deviceId, 'unknown'),
    sessionId: safeString(value.sessionId, 100),
  };
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

async function pushToLoki(events) {
  const response = await fetch(LOKI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(lokiPayload(events)),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`loki_http_${response.status}`);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    send(res, 200, { status: 'ok' });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/api/v1/events') {
    send(res, 404, { error: 'not_found' });
    return;
  }

  try {
    const payload = JSON.parse(await readBody(req));
    if (payload.version !== 1 || !Array.isArray(payload.events)
        || payload.events.length < 1 || payload.events.length > MAX_EVENTS) {
      send(res, 400, { error: 'invalid_payload' });
      return;
    }
    const events = payload.events.map(validateEvent);
    if (events.some(event => event === null)) {
      send(res, 400, { error: 'invalid_event' });
      return;
    }
    await pushToLoki(events);
    res.statusCode = 204;
    cors(res);
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[receiver] ingest failed:', message);
    if (!res.headersSent) send(res, message === 'payload_too_large' ? 413 : 503, {
      error: message === 'payload_too_large' ? message : 'ingest_unavailable',
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[receiver] listening on port ${PORT}`);
});
