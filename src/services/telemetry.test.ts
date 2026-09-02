// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeTelemetryEndpoint, Telemetry } from './telemetry';

class FakeRequest {
  static instances: FakeRequest[] = [];
  status = 204;
  timeout = 0;
  method = '';
  url = '';
  body = '';
  headers: Record<string, string> = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

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
    this.onload?.();
  }
}

afterEach(() => {
  Telemetry.stopForTests();
  FakeRequest.instances = [];
  vi.unstubAllGlobals();
});

describe('telemetry endpoint', () => {
  it('accepts a bare Pi address and supplies the receiver port and path', () => {
    expect(normalizeTelemetryEndpoint('192.168.1.50'))
      .toBe('http://192.168.1.50:4318/api/v1/events');
    expect(normalizeTelemetryEndpoint('http://pi.local:9000/'))
      .toBe('http://pi.local:9000/api/v1/events');
  });

  it('posts a connection-test event and strips sensitive values', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeRequest);
    await Telemetry.test('192.168.1.50');

    const request = FakeRequest.instances[0];
    const payload = JSON.parse(request.body) as {
      events: { event: string; message: string }[];
    };
    expect(request.method).toBe('POST');
    expect(request.url).toBe('http://192.168.1.50:4318/api/v1/events');
    expect(request.headers['Content-Type']).toBe('text/plain;charset=UTF-8');
    expect(payload.events[0].event).toBe('telemetry.connection.test');

    Telemetry.configure({ enabled: true, endpoint: '192.168.1.50' });
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
