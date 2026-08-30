import type * as http from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { startServerMock } = vi.hoisted(() => ({ startServerMock: vi.fn() }));

vi.mock('./server', () => ({ startServer: startServerMock }));

import { registerLanService } from './service';

type Message = {
  respond: ReturnType<typeof vi.fn>;
  isSubscription?: boolean;
  on?: ReturnType<typeof vi.fn>;
};

type Handler = (message: Message) => void;

interface ServerResult {
  server: http.Server;
  port: number;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeServer(): { server: http.Server; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn((callback?: (error?: Error) => void) => callback?.());
  return { server: { close } as unknown as http.Server, close };
}

function message(subscription = false): Message {
  return {
    respond: vi.fn(),
    isSubscription: subscription,
    on: vi.fn(),
  };
}

function lunaHarness(create = vi.fn()): {
  handlers: Record<string, Handler>;
  create: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  service: Parameters<typeof registerLanService>[0];
} {
  const handlers: Record<string, Handler> = {};
  const complete = vi.fn();
  const service = {
    register(method: string, handler: Handler): void {
      handlers[method] = handler;
    },
    activityManager: { create, complete },
  } as Parameters<typeof registerLanService>[0];
  return { handlers, create, complete, service };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  startServerMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('registerLanService', () => {
  it('cancels an in-flight bind when stop arrives', async () => {
    const binding = deferred<ServerResult>();
    const stale = fakeServer();
    startServerMock.mockReturnValueOnce(binding.promise);
    const luna = lunaHarness();
    registerLanService(luna.service, 'uploads');
    const pendingStart = message();

    luna.handlers.start(pendingStart);
    const stopped = message();
    luna.handlers.stop(stopped);

    expect(pendingStart.respond).toHaveBeenCalledWith({
      running: false,
      error: 'Service stopped',
    });
    expect(stopped.respond).toHaveBeenCalledWith({
      stopped: false,
      droppedSubscribers: 0,
    });

    binding.resolve({ server: stale.server, port: 101 });
    await flushPromises();

    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(luna.create).not.toHaveBeenCalled();
    const heartbeat = message();
    luna.handlers.heartbeat(heartbeat);
    expect(heartbeat.respond).toHaveBeenCalledWith({ running: false, port: null });
  });

  it('rebinds after stop without letting the stale bind replace it', async () => {
    const firstBind = deferred<ServerResult>();
    const secondBind = deferred<ServerResult>();
    const stale = fakeServer();
    const active = fakeServer();
    startServerMock
      .mockReturnValueOnce(firstBind.promise)
      .mockReturnValueOnce(secondBind.promise);
    const luna = lunaHarness();
    registerLanService(luna.service, 'uploads');

    luna.handlers.stop(message());
    const restarted = message();
    luna.handlers.start(restarted);
    expect(startServerMock).toHaveBeenCalledTimes(2);

    secondBind.resolve({ server: active.server, port: 202 });
    await flushPromises();
    firstBind.resolve({ server: stale.server, port: 101 });
    await flushPromises();

    expect(restarted.respond).toHaveBeenCalledWith({ running: true, port: 202 });
    expect(luna.create).toHaveBeenCalledTimes(1);
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(active.close).not.toHaveBeenCalled();
  });

  it('closes the listener and fails pending starts when keepAlive creation throws', async () => {
    const binding = deferred<ServerResult>();
    const bound = fakeServer();
    startServerMock.mockReturnValueOnce(binding.promise);
    const create = vi.fn(() => { throw new Error('activity unavailable'); });
    const luna = lunaHarness(create);
    registerLanService(luna.service, 'uploads');
    const pendingStart = message();
    luna.handlers.start(pendingStart);

    binding.resolve({ server: bound.server, port: 303 });
    await flushPromises();

    expect(bound.close).toHaveBeenCalledTimes(1);
    expect(pendingStart.respond).toHaveBeenCalledWith({
      running: false,
      error: 'activity unavailable',
    });
    const heartbeat = message();
    luna.handlers.heartbeat(heartbeat);
    expect(heartbeat.respond).toHaveBeenCalledWith({ running: false, port: null });
  });

  it('broadcasts only to subscribed messages and removes them on cancel', () => {
    const binding = deferred<ServerResult>();
    startServerMock.mockReturnValueOnce(binding.promise);
    const luna = lunaHarness();
    registerLanService(luna.service, 'uploads');
    const notSubscribed = message();
    const subscribed = message(true);

    luna.handlers.serviceEvents(notSubscribed);
    luna.handlers.serviceEvents(subscribed);
    const broadcast = startServerMock.mock.calls[0][2] as (event: string) => void;
    broadcast('uploads-changed');

    expect(notSubscribed.respond).toHaveBeenCalledTimes(1);
    expect(subscribed.respond).toHaveBeenLastCalledWith({ event: 'uploads-changed' });
    const cancel = subscribed.on!.mock.calls[0][1] as () => void;
    cancel();
    broadcast('setup-changed');
    expect(subscribed.respond).toHaveBeenCalledTimes(2);
  });
});
