import { CONFIG } from '../config';

export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TelemetryConfig {
  enabled: boolean;
  endpoint: string;
}

interface TelemetryEvent {
  timestamp: number;
  level: TelemetryLevel;
  event: string;
  tag: string;
  message: string;
  appVersion: string;
  deviceId: string;
  sessionId: string;
}

const ENABLED_KEY = `${CONFIG.STORAGE_PREFIX}telemetry_enabled`;
const ENDPOINT_KEY = `${CONFIG.STORAGE_PREFIX}telemetry_endpoint`;
const DEVICE_KEY = `${CONFIG.STORAGE_PREFIX}telemetry_device_id`;
const ACTIVE_SESSION_KEY = `${CONFIG.STORAGE_PREFIX}telemetry_active_session`;
const BATCH_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const MAX_QUEUE = 100;
const MAX_BATCH = 25;

let config = readConfig();
let queue: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let started = false;
let sending = false;
let lastHeartbeatAt = Date.now();

const sessionId = randomId('s');
const deviceId = readDeviceId();

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readConfig(): TelemetryConfig {
  try {
    const enabled = JSON.parse(localStorage.getItem(ENABLED_KEY) ?? 'false') === true;
    const endpoint = JSON.parse(localStorage.getItem(ENDPOINT_KEY) ?? '""');
    return {
      enabled,
      endpoint: typeof endpoint === 'string' ? normalizeTelemetryEndpoint(endpoint) : '',
    };
  } catch {
    return { enabled: false, endpoint: '' };
  }
}

function readDeviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    if (stored) {
      const value = JSON.parse(stored);
      if (typeof value === 'string' && value.length <= 80) return value;
    }
    const value = randomId('tv');
    localStorage.setItem(DEVICE_KEY, JSON.stringify(value));
    return value;
  } catch {
    return randomId('tv');
  }
}

export function normalizeTelemetryEndpoint(value: string): string {
  let endpoint = value.trim();
  if (!endpoint) return '';
  if (!/^https?:\/\//i.test(endpoint)) endpoint = `http://${endpoint}`;
  endpoint = endpoint.replace(/\/+$/, '');
  const authorityStart = endpoint.indexOf('://') + 3;
  const pathStart = endpoint.indexOf('/', authorityStart);
  const authority = pathStart < 0
    ? endpoint.slice(authorityStart)
    : endpoint.slice(authorityStart, pathStart);
  if (!/:\d+$/.test(authority)) {
    endpoint = pathStart < 0
      ? `${endpoint}:4318`
      : `${endpoint.slice(0, pathStart)}:4318${endpoint.slice(pathStart)}`;
  }
  if (!/\/api\/v1\/events$/i.test(endpoint)) endpoint += '/api/v1/events';
  return endpoint;
}

function eventName(args: unknown[], tag: string, level: TelemetryLevel): string {
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    const match = arg.match(/(?:^|\s)event=([a-z0-9._-]+)/i);
    if (match) return match[1].toLowerCase();
  }
  return `${tag.toLowerCase()}.${level}`;
}

function scrubString(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/(password|passwd|token|api[_-]?key|username)=\S+/gi, '$1=<redacted>')
    .slice(0, 500);
}

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message), stack: scrubString(value.stack ?? '') };
  }
  if (depth >= 2 || typeof value !== 'object' || !value) return String(value).slice(0, 100);
  if (Array.isArray(value)) return value.slice(0, 10).map(item => scrub(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, 20)) {
    if (/password|passwd|token|api.?key|username|url/i.test(key)) {
      result[key] = '<redacted>';
    } else {
      result[key] = scrub((value as Record<string, unknown>)[key], depth + 1);
    }
  }
  return result;
}

function message(args: unknown[]): string {
  try {
    return JSON.stringify(args.map(arg => scrub(arg))).slice(0, 2000);
  } catch {
    return '[unserializable]';
  }
}

function makeEvent(
  level: TelemetryLevel,
  tag: string,
  args: unknown[],
  forcedEvent?: string,
): TelemetryEvent {
  return {
    timestamp: Date.now(),
    level,
    event: forcedEvent ?? eventName(args, tag, level),
    tag,
    message: message(args),
    appVersion: CONFIG.VERSION,
    deviceId,
    sessionId,
  };
}

function post(endpoint: string, events: TelemetryEvent[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', endpoint, true);
    request.timeout = 5000;
    // text/plain is a CORS-simple request and avoids a preflight on old webOS.
    request.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`Telemetry server returned HTTP ${request.status}`));
    };
    request.onerror = () => reject(new Error('Telemetry server is unreachable'));
    request.ontimeout = () => reject(new Error('Telemetry request timed out'));
    request.send(JSON.stringify({ version: 1, events }));
  });
}

function scheduleFlush(): void {
  if (flushTimer !== null || sending || !config.enabled || !config.endpoint) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, BATCH_MS);
}

async function flush(): Promise<void> {
  if (sending || !config.enabled || !config.endpoint || !queue.length) return;
  sending = true;
  const batch = queue.splice(0, MAX_BATCH);
  try {
    await post(config.endpoint, batch);
  } catch {
    queue = batch.concat(queue).slice(-MAX_QUEUE);
  } finally {
    sending = false;
    if (queue.length) scheduleFlush();
  }
}

export const Telemetry = {
  getConfig(): TelemetryConfig {
    return { ...config };
  },

  configure(next: TelemetryConfig): void {
    const wasEnabled = config.enabled && !!config.endpoint;
    config = {
      enabled: next.enabled,
      endpoint: normalizeTelemetryEndpoint(next.endpoint),
    };
    if (!config.enabled) queue = [];
    if (started && config.enabled && config.endpoint) {
      if (!wasEnabled) this.capture('info', 'Telemetry', ['Diagnostics enabled'], 'telemetry.enabled');
      scheduleFlush();
    }
  },

  start(): void {
    if (started) return;
    started = true;
    let previousSession = '';
    try {
      previousSession = localStorage.getItem(ACTIVE_SESSION_KEY) ?? '';
      localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
    } catch { /* ignore */ }
    if (previousSession) {
      this.capture('warn', 'Telemetry', ['Previous session did not close cleanly'],
        'session.previous_unclean');
    }
    this.capture('info', 'Telemetry', ['Session started', {
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    }], 'session.start');
    lastHeartbeatAt = Date.now();
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const lagMs = Math.max(0, now - lastHeartbeatAt - HEARTBEAT_MS);
      lastHeartbeatAt = now;
      if (!document.hidden && lagMs >= 2000) {
        this.capture('warn', 'Telemetry', [{ lagMs }], 'performance.event_loop_lag');
      }
      this.capture('info', 'Telemetry', [{ lagMs }], 'session.heartbeat');
    }, HEARTBEAT_MS);
    window.addEventListener('pagehide', () => {
      this.capture('info', 'Telemetry', ['Session ended'], 'session.end');
      try { localStorage.removeItem(ACTIVE_SESSION_KEY); } catch { /* ignore */ }
      void flush();
    });
  },

  capture(
    level: TelemetryLevel,
    tag: string,
    args: unknown[],
    forcedEvent?: string,
  ): void {
    if (!config.enabled || !config.endpoint) return;
    if (!forcedEvent && level === 'debug') return;
    if (!forcedEvent && level === 'info'
        && !args.some(arg => typeof arg === 'string' && /(?:^|\s)event=/i.test(arg))) return;
    queue.push(makeEvent(level, tag, args, forcedEvent));
    if (queue.length > MAX_QUEUE) queue.shift();
    if (queue.length >= MAX_BATCH) void flush();
    else scheduleFlush();
  },

  async test(endpoint: string): Promise<void> {
    const normalized = normalizeTelemetryEndpoint(endpoint);
    if (!normalized) throw new Error('Telemetry server address is empty');
    await post(normalized, [makeEvent(
      'info',
      'Telemetry',
      ['Connection test'],
      'telemetry.connection.test',
    )]);
  },

  stopForTests(): void {
    if (flushTimer !== null) clearTimeout(flushTimer);
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    flushTimer = null;
    heartbeatTimer = null;
    queue = [];
    sending = false;
    started = false;
  },
};
