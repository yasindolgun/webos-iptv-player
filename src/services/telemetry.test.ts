// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeTelemetryEndpoint, Telemetry } from './telemetry';

class FakeRequest {
  static instances: FakeRequest[] = [];
  static automatic = true;
  status = 204;
  timeout = 0;
  method = '';
  url = '';
  body = '';
  headers: Record<string, string> = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;

  constructor() {
    FakeRequest.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: string): void {
    this.body = body;
    if (FakeRequest.automatic) this.onload?.();
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.stubGlobal('XMLHttpRequest', FakeRequest);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});

afterEach(() => {
  Telemetry.stopForTests();
  FakeRequest.instances = [];
  FakeRequest.automatic = true;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('telemetry endpoint', () => {
  it('accepts a bare Pi address and supplies the receiver port and path', () => {
    expect(normalizeTelemetryEndpoint('host'))
      .toBe('http://host:4318/api/v1/events');
    expect(normalizeTelemetryEndpoint('http://host:9000/'))
      .toBe('http://host:9000/api/v1/events');
  });

  it('posts a connection-test event and strips sensitive values', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeRequest);
    await Telemetry.test('host');

    const request = FakeRequest.instances[0];
    const payload = JSON.parse(request.body) as {
      events: { event: string; message: string }[];
    };
    expect(request.method).toBe('POST');
    expect(request.url).toBe('http://host:4318/api/v1/events');
    expect(request.headers['Content-Type']).toBe('text/plain;charset=UTF-8');
    expect(payload.events[0].event).toBe('telemetry.connection.test');

    Telemetry.configure({ enabled: true, endpoint: 'host' });
    for (let index = 0; index < 25; index++) {
      Telemetry.capture('error', 'Player', [
        'event=playback.video.error',
        'http://host/live/user/password/1',
        { token: 'secret', readyState: 2 },
      ]);
    }
    await vi.waitFor(() => expect(FakeRequest.instances).toHaveLength(2));
    expect(FakeRequest.instances[1].body).not.toContain('secret');
    expect(FakeRequest.instances[1].body).not.toContain('password/1');
  });
});

function capture(count = 1, marker = 'current'): void {
  for (let index = 0; index < count; index++) {
    Telemetry.capture('warn', 'Player', [marker, { index }]);
  }
}

function events(request: FakeRequest): { event: string; message: string }[] {
  return JSON.parse(request.body).events;
}

function delivered(): { event: string; message: string }[] {
  return FakeRequest.instances.reduce<{ event: string; message: string }[]>(
    (all, request) => all.concat(events(request)), []);
}

describe('telemetry masking', () => {
  it.each([
    { password: 'synthetic-secret', code: 42 },
    '{"password":"synthetic-secret","code":42}',
    '{"nested":{"apiKey":"synthetic-secret"},"code":42}',
    JSON.stringify(JSON.stringify({ username: 'synthetic-secret', code: 42 })),
    new Error('{"token":"synthetic-secret","code":42}'),
    'failed: {"password":"synthetic-secret","code":42}',
    'code=42 failed: {"pass\\u0077ord":"synthetic-secret"}\n at handler',
    'code=42 failed: {"password":"synthetic-secret with spaces',
    'password="synthetic-secret with spaces" code=42',
    'authorization=Bearer synthetic-secret code=42',
    'http://host/a?token=synthetic-secret code=42',
    [[[{ password: 'synthetic-secret' }]], { code: 42 }],
  ])('scrubs sensitive values in the final HTTP body (%#)', async value => {
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    for (let index = 0; index < 25; index++) Telemetry.capture('error', 'Player', [value]);
    await Promise.resolve();
    const body = FakeRequest.instances[0].body;
    expect(body).not.toContain('synthetic-secret');
    expect(body).toContain('42');
  });

  it('never stringifies deep objects, arrays, or circular references without scrubbing', () => {
    const circular: Record<string, unknown> = { password: 'synthetic-secret' };
    circular.self = circular;
    const error = new Error('token=synthetic-secret');
    error.name = 'password=synthetic-secret';
    const value = { a: { b: { c: [
      'http://host/synthetic-secret',
      { toString: () => 'synthetic-secret' },
    ] } } };
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    for (let index = 0; index < 25; index++) {
      Telemetry.capture('warn', 'Player', [value, circular, error]);
    }
    expect(FakeRequest.instances[0].body).not.toContain('synthetic-secret');
  });
});

describe('telemetry delivery ownership', () => {
  it.each(['error', 'timeout', 'success'] as const)('ignores old %s after disable and re-enable', async result => {
    FakeRequest.automatic = false;
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    capture(25, 'old-generation');
    const old = FakeRequest.instances[0];
    Telemetry.configure({ enabled: false, endpoint: '' });
    expect(old.aborted).toBe(true);
    Telemetry.configure({ enabled: true, endpoint: 'host:9000' });
    capture(25, 'new-generation');
    const current = FakeRequest.instances[1];
    if (result === 'error') old.onerror?.();
    else if (result === 'timeout') old.ontimeout?.();
    else old.onload?.();
    await Promise.resolve();
    capture(25, 'new-tail');
    expect(FakeRequest.instances).toHaveLength(2);
    current.onload?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeRequest.instances).toHaveLength(3);
    for (const request of FakeRequest.instances.slice(1)) {
      expect(request.url).toBe('http://host:9000/api/v1/events');
      expect(request.body).not.toContain('old-generation');
    }
  });

  it('drops pending records when the enabled endpoint changes', async () => {
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    capture(24, 'old-generation');
    Telemetry.configure({ enabled: true, endpoint: 'host:9000' });
    capture(1, 'new-generation');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeRequest.instances).toHaveLength(1);
    expect(FakeRequest.instances[0].body).not.toContain('old-generation');
  });

  it('preserves queued events when equivalent settings are saved', async () => {
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    capture();
    Telemetry.configure({ enabled: true, endpoint: 'http://host:4318/api/v1/events' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeRequest.instances).toHaveLength(1);
  });

  it('rejects invalid configuration without changing the active destination', () => {
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    expect(() => Telemetry.configure({ enabled: true, endpoint: '' })).toThrow();
    expect(Telemetry.getConfig()).toEqual({ enabled: true, endpoint: 'http://host:4318/api/v1/events' });
  });

  it('cancels pending work through rapid toggles', async () => {
    for (let index = 0; index < 10; index++) {
      Telemetry.configure({ enabled: true, endpoint: 'host' });
      capture();
      Telemetry.configure({ enabled: false, endpoint: '' });
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeRequest.instances).toHaveLength(0);
  });

  it.each([400, 401, 403, 404, 413, 422])('drops permanently rejected HTTP %i batches', async status => {
    FakeRequest.automatic = false;
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    capture(25, 'rejected');
    FakeRequest.instances[0].status = status;
    FakeRequest.instances[0].onload?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeRequest.instances).toHaveLength(1);
    capture(1, 'fresh');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeRequest.instances[1].body).not.toContain('rejected');
  });

  it.each([0, 408, 429, 500, 503, 'timeout', 'error'])('retries transient %s failures with bounded buffering', async status => {
    FakeRequest.automatic = false;
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    capture(25, 'retry');
    const request = FakeRequest.instances[0];
    if (status === 'timeout') request.ontimeout?.();
    else if (status === 'error') request.onerror?.();
    else {
      request.status = status as number;
      request.onload?.();
    }
    await vi.advanceTimersByTimeAsync(9999);
    expect(FakeRequest.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeRequest.instances).toHaveLength(2);
    expect(events(FakeRequest.instances[1])).toHaveLength(25);
    expect(FakeRequest.instances[1].body).toContain('retry');
  });

  it('does not let incoming events bypass the retry delay or grow the queue', async () => {
    FakeRequest.automatic = false;
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    capture(25, 'oldest');
    FakeRequest.instances[0].onerror?.();
    await Promise.resolve();
    capture(150, 'newest');
    expect(FakeRequest.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeRequest.instances).toHaveLength(2);
    expect(FakeRequest.instances[1].body).not.toContain('oldest');
    FakeRequest.automatic = true;
    FakeRequest.instances[1].onload?.();
    await Telemetry.end();
    expect(delivered().filter(event => event.event === 'player.warn')).toHaveLength(125);
  });
});

describe('telemetry lifecycle', () => {
  it('does not interpret suspension as foreground event-loop lag', async () => {
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    Telemetry.start();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(delivered().filter(event => event.event === 'session.heartbeat')).toHaveLength(0);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(delivered().some(event => event.event === 'performance.event_loop_lag')).toBe(false);
    expect(delivered().filter(event => event.event === 'session.heartbeat')).toHaveLength(1);
    expect(delivered().some(event => event.event === 'session.resume')).toBe(true);
  });

  it('still records a two-second foreground timer delay', async () => {
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    Telemetry.start();
    vi.setSystemTime(Date.now() + 2000);
    await vi.advanceTimersByTimeAsync(40_000);
    const lag = delivered().find(event => event.event === 'performance.event_loop_lag');
    expect(lag?.message).toContain('2000');
  });

  it('starts monitoring only when enabled and clears markers when disabled', async () => {
    localStorage.setItem('iptv_telemetry_active_session', 'old-session');
    Telemetry.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeRequest.instances).toHaveLength(0);
    expect(localStorage.getItem('iptv_telemetry_active_session')).toBeNull();
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    expect(localStorage.getItem('iptv_telemetry_active_session')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(delivered().map(event => event.event)).toEqual(['session.start']);
    Telemetry.configure({ enabled: false, endpoint: 'host' });
    expect(localStorage.getItem('iptv_telemetry_active_session')).toBeNull();
    const count = FakeRequest.instances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeRequest.instances).toHaveLength(count);
  });

  it('reports an absent previous close marker as an unknown cause', async () => {
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    localStorage.setItem('iptv_telemetry_active_session', 'old-session');
    Telemetry.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(delivered()[0].event).toBe('session.previous_unclean');
    expect(delivered()[0].message).toContain('cause unknown');
  });

  it.each([0, 24, 25, 100])('drains %i events and the end marker on explicit close', async count => {
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    capture(count);
    const closing = Telemetry.end();
    expect(Telemetry.end()).toBe(closing);
    await closing;
    const all = delivered();
    expect(all).toHaveLength(count + 1);
    expect(all[all.length - 1].event).toBe('session.end');
    for (const request of FakeRequest.instances) expect(events(request).length).toBeLessThanOrEqual(25);
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(delivered()).toHaveLength(count + 1);
  });

  it('bounds shutdown with an in-flight request and full queue to one second', async () => {
    FakeRequest.automatic = false;
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    Telemetry.start();
    capture(150);
    let closed = false;
    const closing = Telemetry.end().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(FakeRequest.instances[0].aborted).toBe(true);
    expect(localStorage.getItem('iptv_telemetry_active_session')).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeRequest.instances).toHaveLength(1);
  });

  it('continues closing after an offline batch without retrying it', async () => {
    FakeRequest.automatic = false;
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    capture(25, 'failed-batch');
    const closing = Telemetry.end();
    FakeRequest.automatic = true;
    FakeRequest.instances[0].onerror?.();
    await closing;
    expect(FakeRequest.instances).toHaveLength(2);
    expect(events(FakeRequest.instances[1]).map(event => event.event)).toEqual(['session.end']);
  });

  it('sends one tail beacon including the end marker even with an active request', async () => {
    const beacon = vi.fn((_url: string, _body: string) => true);
    vi.stubGlobal('navigator', { userAgent: 'test', sendBeacon: beacon });
    FakeRequest.automatic = false;
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    Telemetry.start();
    capture(150);
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(beacon).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(beacon.mock.calls[0][1] as string);
    expect(payload.events).toHaveLength(25);
    expect(payload.events[24].event).toBe('session.end');
    expect(FakeRequest.instances[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeRequest.instances).toHaveLength(1);
  });

  it('uses bounded XHR when beacon is unavailable', () => {
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    Telemetry.start();
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(FakeRequest.instances).toHaveLength(1);
    expect(FakeRequest.instances[0].timeout).toBe(5000);
    expect(delivered().some(event => event.event === 'session.end')).toBe(true);
  });

  it('keeps a Unicode-heavy tail under the beacon byte budget', () => {
    const beacon = vi.fn((_url: string, _body: string) => true);
    vi.stubGlobal('navigator', { userAgent: 'test', sendBeacon: beacon });
    FakeRequest.automatic = false;
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    Telemetry.start();
    for (let index = 0; index < 150; index++) {
      Telemetry.capture('warn', 'Player', Array(4).fill('文'.repeat(500)));
    }
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    const body = beacon.mock.calls[0][1];
    expect(new Blob([body]).size).toBeLessThanOrEqual(60 * 1024);
    const tail = JSON.parse(body).events;
    expect(tail.length).toBeLessThan(25);
    expect(tail[tail.length - 1].event).toBe('session.end');
  });

  it.each([false, 'throw'])('falls back if beacon returns %s', failure => {
    vi.stubGlobal('navigator', { userAgent: 'test', sendBeacon: () => {
      if (failure === 'throw') throw new Error('unavailable');
      return false;
    } });
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    Telemetry.start();
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(FakeRequest.instances).toHaveLength(1);
    expect(delivered().some(event => event.event === 'session.end')).toBe(true);
  });

  it('keeps the active marker across a persisted page hide and resumes monitoring', async () => {
    const beacon = vi.fn();
    vi.stubGlobal('navigator', { userAgent: 'test', sendBeacon: beacon });
    Telemetry.configure({ enabled: true, endpoint: 'host' });
    Telemetry.start();
    const marker = localStorage.getItem('iptv_telemetry_active_session');
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(localStorage.getItem('iptv_telemetry_active_session')).toBe(marker);
    expect(beacon).not.toHaveBeenCalled();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(delivered().some(event => event.event === 'performance.event_loop_lag')).toBe(false);
    expect(delivered().some(event => event.event === 'session.heartbeat')).toBe(true);
  });
});
