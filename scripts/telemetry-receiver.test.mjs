import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createReceiverServer } = require('../ops/telemetry/receiver/server.js');

const openServers = [];

async function listen(server) {
  openServers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function event(overrides = {}) {
  return {
    timestamp: Date.now(),
    level: 'info',
    event: 'telemetry.connection.test',
    tag: 'Telemetry',
    message: '["Connection test"]',
    appVersion: '0.0.0-test',
    deviceId: 'tv-test',
    sessionId: 's-test',
    ...overrides,
  };
}

function receiver(options = {}) {
  return createReceiverServer({
    fetchImpl: vi.fn(async () => new Response(null, { status: 204 })),
    logger: { error: vi.fn() },
    ...options,
  });
}

async function post(url, value) {
  return fetch(`${url}/api/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => new Promise(resolve => {
    server.close(resolve);
  })));
});

describe('telemetry receiver HTTP contract', () => {
  it('stores a valid packet in Loki before acknowledging it', async () => {
    let stored;
    const fetchImpl = vi.fn(async (_url, init) => {
      stored = JSON.parse(init.body);
      return new Response(null, { status: 204 });
    });
    const url = await listen(receiver({ fetchImpl }));

    const response = await post(url, { version: 1, events: [event()] });

    expect(response.status).toBe(204);
    expect(stored.streams).toHaveLength(1);
    expect(stored.streams[0].stream.event).toBe('telemetry.connection.test');
    expect(JSON.parse(stored.streams[0].values[0][1]).sessionId).toBe('s-test');
  });

  it.each([
    ['malformed JSON', '{', 'invalid_json'],
    ['null payload', 'null', 'invalid_payload'],
    ['array payload', '[]', 'invalid_payload'],
    ['wrong version', { version: 2, events: [event()] }, 'invalid_payload'],
    ['empty events', { version: 1, events: [] }, 'invalid_payload'],
    ['wrong event field type', {
      version: 1,
      events: [event({ timestamp: '1' })],
    }, 'invalid_event'],
    ['unknown level', {
      version: 1,
      events: [event({ level: 'fatal' })],
    }, 'invalid_event'],
  ])('returns 400 for %s without contacting storage', async (_name, body, code) => {
    const fetchImpl = vi.fn();
    const url = await listen(receiver({ fetchImpl }));

    const response = await post(url, body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: code });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns a real 413 response without forwarding an oversized body', async () => {
    const fetchImpl = vi.fn();
    const url = await listen(receiver({ fetchImpl, maxBodyBytes: 64 }));

    const response = await post(url, 'x'.repeat(65));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'payload_too_large' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps liveness independent and exposes write failures through readiness', async () => {
    let pushFails = false;
    const fetchImpl = vi.fn(async (target, init) => {
      if (init.method === 'GET') return new Response('ready', { status: 200 });
      if (pushFails) return new Response('storage unavailable', { status: 500 });
      return new Response(null, { status: 204 });
    });
    const url = await listen(receiver({ fetchImpl }));

    let response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ check: 'liveness' });
    response = await fetch(`${url}/ready`);
    expect(response.status).toBe(200);

    pushFails = true;
    response = await post(url, { version: 1, events: [event()] });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('10');
    response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    response = await fetch(`${url}/ready`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      check: 'readiness',
      dependencies: { loki: 'ready' },
      ingest: { lastError: 'loki_http_500' },
    });

    pushFails = false;
    response = await post(url, { version: 1, events: [event()] });
    expect(response.status).toBe(204);
    response = await fetch(`${url}/ready`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ingest: { lastFailureAt: null, lastError: '' },
    });
  });

  it('does not classify a permanent Loki rejection as retryable', async () => {
    const fetchImpl = vi.fn(async () => new Response('rejected', { status: 400 }));
    const url = await listen(receiver({ fetchImpl }));

    const response = await post(url, { version: 1, events: [event()] });

    expect(response.status).toBe(422);
    expect(response.headers.get('retry-after')).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: 'ingest_rejected' });
  });

  it('reports Loki unavailability only on the readiness endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response('not ready', { status: 503 }));
    const url = await listen(receiver({ fetchImpl }));

    const live = await fetch(`${url}/health`);
    const ready = await fetch(`${url}/ready`);

    expect(live.status).toBe(200);
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toMatchObject({
      check: 'readiness',
      dependencies: { loki: 'unavailable' },
    });
  });
});

describe('telemetry stack provisioning', () => {
  it('keeps durable volumes, retention, and provisioned resources wired', async () => {
    const [compose, loki, datasource, provider] = await Promise.all([
      readFile('ops/telemetry/docker-compose.yml', 'utf8'),
      readFile('ops/telemetry/loki-config.yml', 'utf8'),
      readFile('ops/telemetry/grafana/provisioning/datasources/loki.yml', 'utf8'),
      readFile('ops/telemetry/grafana/provisioning/dashboards/iptv.yml', 'utf8'),
    ]);

    expect(compose).toContain('loki-data:/loki');
    expect(compose).toContain('grafana-data:/var/lib/grafana');
    expect(loki).toContain('retention_period: 720h');
    expect(datasource).toContain('uid: iptv-loki');
    expect(datasource).toContain('url: http://loki:3100');
    expect(provider).toContain('path: /etc/grafana/dashboards');
  });

  it('separates stall incidents, recovery attempts, and foreground lag', async () => {
    const dashboard = JSON.parse(await readFile(
      'ops/telemetry/grafana/dashboards/iptv-overview.json', 'utf8'));
    const panels = new Map(dashboard.panels.map(panel => [panel.title, panel]));

    expect(panels.get('Playback stall incidents in 24 hours')
      .targets[0].expr).toContain('event="playback.stall.detected"');
    expect(panels.get('Stall reload attempts in 24 hours')
      .targets[0].expr).toContain('event="playback.stall.reload"');
    expect(panels.get('Foreground UI lag events in 24 hours')
      .targets[0].expr).toContain('event="performance.event_loop_lag"');
  });
});
