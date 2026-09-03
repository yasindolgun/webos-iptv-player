import { CONFIG } from '../config';
import { normalizeTelemetryEndpoint, readTelemetryConfig, validateTelemetryConfig, type TelemetryConfig } from './telemetry-config';

export { normalizeTelemetryEndpoint, type TelemetryConfig } from './telemetry-config';

export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error';

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

const DEVICE_KEY = `${CONFIG.STORAGE_PREFIX}telemetry_device_id`;
const ACTIVE_SESSION_KEY = `${CONFIG.STORAGE_PREFIX}telemetry_active_session`;
const BATCH_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const MAX_QUEUE = 100;
const MAX_BATCH = 25;
const SHUTDOWN_MS = 1000;

let config = readTelemetryConfig();
let queue: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let started = false;
let sending: { done: Promise<void>; abort: () => void } | null = null;
let generation = 0;
let retryAt = 0;
let ending = false;
let endPromise: Promise<void> | null = null;
let lastHeartbeatAt = Date.now();

const sessionId = randomId('s');
const deviceId = readDeviceId();

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

function eventName(args: unknown[], tag: string, level: TelemetryLevel): string {
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    const match = arg.match(/(?:^|\s)event=([a-z0-9._-]+)/i);
    if (match) return match[1].toLowerCase();
  }
  return `${tag.toLowerCase()}.${level}`;
}

function scrubString(value: string, depth = 0): string {
  const text = value.slice(0, 16_000);
  const jsonStart = /^\s*"/.test(text) ? 0 : text.search(/[\[{]/);
  if (jsonStart >= 0) {
    if (depth >= 4) return '<truncated>';
    const prefix = jsonStart ? scrubString(text.slice(0, jsonStart), depth + 1) : '';
    try {
      return (prefix + JSON.stringify(scrub(JSON.parse(text.slice(jsonStart)), depth + 1))).slice(0, 500);
    } catch {
      // Incomplete JSON can hide escaped keys and values from text-only masking.
      return `${prefix}<structured data omitted>`;
    }
  }
  return text
    .replace(/https?:(?:\\?\/){2}\S+/gi, '<url>')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 <redacted>')
    .replace(/(cookie\s*[:=]\s*)[^\r\n]*/gi, '$1<redacted>')
    .replace(/((?:["']?)(?:password|passwd|token|api[_-]?key|username|authorization|cookie|url)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[\[{][\s\S]*|[^\s,;}\]]+)/gi, '$1<redacted>')
    .slice(0, 500);
}

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value, depth);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value instanceof Error) {
    return { name: scrubString(value.name), message: scrubString(value.message), stack: scrubString(value.stack ?? '') };
  }
  if (depth >= 4 || typeof value !== 'object' || !value) return '<truncated>';
  if (Array.isArray(value)) return value.slice(0, 10).map(item => scrub(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, 20)) {
    const safeKey = scrubString(key);
    if (/password|passwd|token|api.?key|username|url|authorization|cookie/i.test(key)) {
      result[safeKey] = '<redacted>';
    } else {
      result[safeKey] = scrub((value as Record<string, unknown>)[key], depth + 1);
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

class DeliveryError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
  }
}

function post(endpoint: string, events: TelemetryEvent[]): { done: Promise<void>; abort: () => void } {
  const request = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    request.open('POST', endpoint, true);
    request.timeout = 5000;
    // text/plain is a CORS-simple request and avoids a preflight on old webOS.
    request.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new DeliveryError(`Telemetry server returned HTTP ${request.status}`,
        request.status === 0 || request.status === 408 || request.status === 429 || request.status >= 500));
    };
    request.onerror = () => reject(new Error('Telemetry server is unreachable'));
    request.ontimeout = () => reject(new Error('Telemetry request timed out'));
    request.onabort = () => reject(new Error('Telemetry request cancelled'));
    request.send(JSON.stringify({ version: 1, events }));
  });
  return { done, abort: () => request.abort() };
}

function scheduleFlush(): void {
  if (flushTimer !== null || sending || ending || !config.enabled || !config.endpoint) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, Math.max(BATCH_MS, retryAt - Date.now()));
}

async function flush(): Promise<void> {
  if (sending || !config.enabled || !config.endpoint || !queue.length) return;
  if (!ending && Date.now() < retryAt) {
    scheduleFlush();
    return;
  }
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  retryAt = 0;
  const owner = generation;
  const batch = queue.splice(0, MAX_BATCH);
  const request = post(config.endpoint, batch);
  sending = request;
  try {
    await request.done;
  } catch (error) {
    if (owner === generation && !ending
        && (!(error instanceof DeliveryError) || error.retryable)) {
      queue = batch.concat(queue).slice(-MAX_QUEUE);
      retryAt = Date.now() + BATCH_MS;
    }
  } finally {
    if (owner === generation) {
      sending = null;
      if (queue.length) scheduleFlush();
    }
  }
}

function clearDelivery(): void {
  generation++;
  retryAt = 0;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  queue = [];
  const previous = sending;
  sending = null;
  previous?.abort();
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat(): void {
  stopHeartbeat();
  lastHeartbeatAt = Date.now();
  if (document.hidden || ending || !config.enabled || !config.endpoint) return;
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const lagMs = Math.max(0, now - lastHeartbeatAt - HEARTBEAT_MS);
    lastHeartbeatAt = now;
    if (document.hidden) return;
    if (lagMs >= 2000) {
      Telemetry.capture('warn', 'Telemetry', [{ lagMs }], 'performance.event_loop_lag');
    }
    Telemetry.capture('info', 'Telemetry', [{ lagMs }], 'session.heartbeat');
  }, HEARTBEAT_MS);
}

function markActive(): void {
  try { localStorage.setItem(ACTIVE_SESSION_KEY, sessionId); } catch { /* ignore */ }
}

function markClosed(): void {
  try { localStorage.removeItem(ACTIVE_SESSION_KEY); } catch { /* ignore */ }
}

function beginSession(): void {
  let previousSession = '';
  try { previousSession = localStorage.getItem(ACTIVE_SESSION_KEY) ?? ''; } catch { /* ignore */ }
  markActive();
  if (previousSession && previousSession !== sessionId) {
    Telemetry.capture('warn', 'Telemetry', ['Previous session has no local close marker; cause unknown'],
      'session.previous_unclean');
  }
  Telemetry.capture('info', 'Telemetry', ['Session started', {
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  }], 'session.start');
  startHeartbeat();
}

function onVisibilityChange(): void {
  if (!started || ending || !config.enabled || !config.endpoint) return;
  startHeartbeat();
  Telemetry.capture('info', 'Telemetry', [], document.hidden ? 'session.suspend' : 'session.resume');
  if (document.hidden) void flush();
}

function onPageHide(event: PageTransitionEvent): void {
  if (event.persisted) {
    stopHeartbeat();
    return;
  }
  if (ending) return;
  ending = true;
  stopHeartbeat();
  markClosed();
  const endpoint = config.endpoint;
  const tail = queue.slice(-(MAX_BATCH - 1));
  tail.push(makeEvent('info', 'Telemetry', ['Page closed; delivery is best effort'], 'session.end'));
  clearDelivery();
  if (!config.enabled || !endpoint) return;
  while (new Blob([JSON.stringify({ version: 1, events: tail })]).size > 60 * 1024) tail.shift();
  // One small tail packet fits the unload budget; beacon acceptance is not delivery proof.
  try {
    const body = JSON.stringify({ version: 1, events: tail });
    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(endpoint, body)) return;
  } catch { /* use the bounded XHR fallback */ }
  sending = post(endpoint, tail);
  void sending.done.catch(() => {});
}

function onPageShow(event: PageTransitionEvent): void {
  if (event.persisted && started && !ending) startHeartbeat();
}

export const Telemetry = {
  getConfig(): TelemetryConfig {
    return { ...config };
  },

  configure(next: TelemetryConfig): void {
    const validated = validateTelemetryConfig(next);
    if (config.enabled === validated.enabled && config.endpoint === validated.endpoint) return;
    clearDelivery();
    stopHeartbeat();
    config = validated;
    markClosed();
    if (started && config.enabled && config.endpoint && !ending) beginSession();
  },

  start(): void {
    if (started) return;
    started = true;
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    if (config.enabled && config.endpoint) beginSession();
    else markClosed();
  },

  end(): Promise<void> {
    if (endPromise) return endPromise;
    if (ending) return Promise.resolve();
    ending = true;
    stopHeartbeat();
    markClosed();
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    if (config.enabled && config.endpoint) {
      queue.push(makeEvent('info', 'Telemetry', ['Local close requested'], 'session.end'));
      queue = queue.slice(-MAX_QUEUE);
    }
    const owner = generation;
    endPromise = new Promise(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        if (owner === generation) clearDelivery();
        resolve();
      };
      const deadline = setTimeout(finish, SHUTDOWN_MS);
      const drain = async () => {
        if (sending) await sending.done.catch(() => {});
        while (!finished && owner === generation && config.enabled && config.endpoint && queue.length) {
          await flush();
        }
        finish();
      };
      void drain();
    });
    return endPromise;
  },

  capture(
    level: TelemetryLevel,
    tag: string,
    args: unknown[],
    forcedEvent?: string,
  ): void {
    if (ending || !config.enabled || !config.endpoint) return;
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
    if (!normalized) throw new Error('Invalid telemetry server address');
    await post(normalized, [makeEvent(
      'info',
      'Telemetry',
      ['Connection test'],
      'telemetry.connection.test',
    )]).done;
  },

  stopForTests(): void {
    clearDelivery();
    stopHeartbeat();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    config = { enabled: false, endpoint: '' };
    ending = false;
    endPromise = null;
    started = false;
  },
};
