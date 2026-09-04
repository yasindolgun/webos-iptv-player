// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLunaAvailable, lunaRequest } from './luna';

interface BridgeCall {
  uri: string;
  payload: string;
}

function installBridge(options: {
  callError?: Error;
  constructorError?: Error;
} = {}): {
  calls: BridgeCall[];
  callbacks: Array<(message: string) => void>;
  cancelCount: () => number;
} {
  const calls: BridgeCall[] = [];
  const callbacks: Array<(message: string) => void> = [];
  let cancellations = 0;

  class FakePalmServiceBridge {
    onservicecallback: ((message: string) => void) | null = null;

    constructor() {
      if (options.constructorError) throw options.constructorError;
    }

    call(uri: string, payload: string): void {
      calls.push({ uri, payload });
      if (this.onservicecallback) callbacks.push(this.onservicecallback);
      if (options.callError) throw options.callError;
    }

    cancel(): void {
      cancellations++;
    }
  }

  Object.defineProperty(window, 'PalmServiceBridge', {
    configurable: true,
    value: FakePalmServiceBridge,
  });
  return {
    calls,
    callbacks,
    cancelCount: () => cancellations,
  };
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'PalmServiceBridge');
});

describe('Luna request transport', () => {
  it('reports whether PalmServiceBridge is available', () => {
    expect(isLunaAvailable()).toBe(false);
    installBridge();
    expect(isLunaAvailable()).toBe(true);
  });

  it('joins the service URI and method with one slash', () => {
    const bridge = installBridge();
    const handle = lunaRequest('luna://com.foo/', { method: 'start' });

    expect(bridge.calls[0].uri).toBe('luna://com.foo/start');
    handle.cancel();
  });

  it('keeps a complete method URI unchanged when method is omitted', () => {
    const bridge = installBridge();
    const handle = lunaRequest('luna://com.foo/read');

    expect(bridge.calls[0].uri).toBe('luna://com.foo/read');
    handle.cancel();
  });

  it('copies parameters safely and adds the subscription flag', () => {
    const bridge = installBridge();
    const handle = lunaRequest('luna://com.foo', {
      method: 'watch',
      subscribe: true,
      parameters: { hasOwnProperty: 'value', x: 1 },
    });

    expect(JSON.parse(bridge.calls[0].payload)).toEqual({
      hasOwnProperty: 'value',
      x: 1,
      subscribe: true,
    });
    handle.cancel();
  });

  it('honors subscribe from parameters and excludes inherited values', () => {
    const bridge = installBridge();
    const inherited = { hidden: true };
    const parameters = Object.create(inherited) as Record<string, unknown>;
    parameters.visible = true;
    parameters.subscribe = true;
    const handle = lunaRequest('luna://com.foo', {
      method: 'watch',
      parameters,
    });

    expect(JSON.parse(bridge.calls[0].payload)).toEqual({
      visible: true,
      subscribe: true,
    });
    bridge.callbacks[0]('{"returnValue":true}');
    expect(bridge.cancelCount()).toBe(0);
    handle.cancel();
  });

  it('dispatches success and completion then releases one-shot requests', () => {
    const bridge = installBridge();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    const onComplete = vi.fn();
    const response = { returnValue: true, value: 1 };
    lunaRequest('luna://com.foo', {
      method: 'read',
      onSuccess,
      onFailure,
      onComplete,
    });

    bridge.callbacks[0](JSON.stringify(response));

    expect(onSuccess).toHaveBeenCalledWith(response);
    expect(onFailure).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(response);
    expect(bridge.cancelCount()).toBe(1);
  });

  it('routes malformed responses to failure and releases the bridge', () => {
    const bridge = installBridge();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    const onComplete = vi.fn();
    lunaRequest('luna://com.foo', {
      method: 'read',
      onSuccess,
      onFailure,
      onComplete,
    });

    bridge.callbacks[0]('not json');

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      returnValue: false,
      errorCode: -1,
    }));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      returnValue: false,
    }));
    expect(bridge.cancelCount()).toBe(1);
  });

  it('routes explicit failures while treating errorCode zero as success', () => {
    const bridge = installBridge();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    lunaRequest('luna://com.foo', { onSuccess, onFailure });
    bridge.callbacks[0]('{"returnValue":false,"errorText":"failed"}');
    expect(onFailure).toHaveBeenCalledWith({
      returnValue: false,
      errorText: 'failed',
    });

    lunaRequest('luna://com.foo', { onSuccess, onFailure });
    bridge.callbacks[1]('{"returnValue":true,"errorCode":0}');
    expect(onSuccess).toHaveBeenCalledWith({
      returnValue: true,
      errorCode: 0,
    });
  });

  it.each(['"unexpected"', 'null', '1', '[]'])(
    'treats valid non-record JSON %s as a malformed response',
    (message) => {
      const bridge = installBridge();
      const onFailure = vi.fn();
      lunaRequest('luna://com.foo', { onFailure });

      bridge.callbacks[0](message);

      expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
        returnValue: false,
        errorCode: -1,
      }));
      expect(bridge.cancelCount()).toBe(1);
    },
  );

  it.each([
    '{"returnValue":"true"}',
    '{"errorCode":"1"}',
    '{"errorText":false}',
  ])('rejects invalid Luna control fields in %s', (message) => {
    const bridge = installBridge();
    const onFailure = vi.fn();
    lunaRequest('luna://com.foo', { onFailure });

    bridge.callbacks[0](message);

    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      returnValue: false,
      errorCode: -1,
    }));
    expect(bridge.cancelCount()).toBe(1);
  });

  it('times out and releases an unanswered one-shot request exactly once', () => {
    vi.useFakeTimers();
    const bridge = installBridge();
    const onFailure = vi.fn();
    const onComplete = vi.fn();
    lunaRequest('luna://com.foo', {
      timeoutMs: 50,
      onFailure,
      onComplete,
    });
    const lateCallback = bridge.callbacks[0];

    vi.advanceTimersByTime(50);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      errorText: 'Luna request timed out after 50ms',
    }));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(bridge.cancelCount()).toBe(1);

    lateCallback('{"returnValue":true}');
    vi.advanceTimersByTime(50);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(bridge.cancelCount()).toBe(1);
  });

  it('bounds the initial response wait without expiring a live subscription', () => {
    vi.useFakeTimers();
    const bridge = installBridge();
    const firstFailure = vi.fn();
    lunaRequest('luna://com.foo', {
      subscribe: true,
      timeoutMs: 50,
      onFailure: firstFailure,
    });
    vi.advanceTimersByTime(50);
    expect(firstFailure).toHaveBeenCalledOnce();
    expect(bridge.cancelCount()).toBe(1);

    const onSuccess = vi.fn();
    const handle = lunaRequest('luna://com.foo', {
      subscribe: true,
      timeoutMs: 50,
      onSuccess,
    });
    bridge.callbacks[1]('{"subscribed":true}');
    vi.advanceTimersByTime(500);
    bridge.callbacks[1]('{"value":1}');
    expect(onSuccess).toHaveBeenCalledTimes(2);
    expect(bridge.cancelCount()).toBe(1);
    handle.cancel();
    expect(bridge.cancelCount()).toBe(2);
  });

  it('does not arm a timeout after a synchronous subscription acknowledgement', () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const onSuccess = vi.fn();
    class SynchronousPalmServiceBridge {
      onservicecallback: ((message: string) => void) | null = null;

      call(): void {
        this.onservicecallback?.('{"subscribed":true}');
      }

      cancel(): void {
        cancel();
        this.onservicecallback = null;
      }
    }
    Object.defineProperty(window, 'PalmServiceBridge', {
      configurable: true,
      value: SynchronousPalmServiceBridge,
    });

    const handle = lunaRequest('luna://com.foo', {
      subscribe: true,
      timeoutMs: 50,
      onSuccess,
    });
    vi.advanceTimersByTime(500);

    expect(onSuccess).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    handle.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('treats a subscription failure as terminal', () => {
    const bridge = installBridge();
    const onFailure = vi.fn();
    const onComplete = vi.fn();
    lunaRequest('luna://com.foo', {
      subscribe: true,
      onFailure,
      onComplete,
    });
    const callback = bridge.callbacks[0];

    callback('{"returnValue":false,"errorCode":1}');
    callback('{"returnValue":true}');

    expect(onFailure).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(bridge.cancelCount()).toBe(1);
  });

  it('keeps subscriptions alive until cancel and ignores late callbacks', () => {
    const bridge = installBridge();
    const onSuccess = vi.fn();
    const onComplete = vi.fn();
    const handle = lunaRequest('luna://com.foo', {
      method: 'watch',
      subscribe: true,
      onSuccess,
      onComplete,
    });
    const callback = bridge.callbacks[0];

    callback('{"returnValue":true,"value":1}');
    callback('{"returnValue":true,"value":2}');
    expect(onSuccess).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(bridge.cancelCount()).toBe(0);

    handle.cancel();
    handle.cancel();
    callback('{"returnValue":true,"value":3}');
    expect(bridge.cancelCount()).toBe(1);
    expect(onSuccess).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it('isolates simultaneous requests and makes pre-response cancel final', () => {
    const bridge = installBridge();
    const firstSuccess = vi.fn();
    const secondSuccess = vi.fn();
    const first = lunaRequest('luna://com.foo', { onSuccess: firstSuccess });
    lunaRequest('luna://com.foo', { onSuccess: secondSuccess });

    first.cancel();
    bridge.callbacks[0]('{"returnValue":true,"request":1}');
    bridge.callbacks[1]('{"returnValue":true,"request":2}');

    expect(firstSuccess).not.toHaveBeenCalled();
    expect(secondSuccess).toHaveBeenCalledWith({
      returnValue: true,
      request: 2,
    });
    expect(bridge.cancelCount()).toBe(2);
  });

  it('releases one-shot requests even when a consumer callback throws', () => {
    const bridge = installBridge();
    lunaRequest('luna://com.foo', {
      onSuccess: () => {
        throw new Error('consumer failed');
      },
    });

    expect(() => {
      bridge.callbacks[0]('{"returnValue":true}');
    }).toThrow('consumer failed');
    expect(bridge.cancelCount()).toBe(1);
  });

  it('releases failed requests even when the failure callback throws', () => {
    const bridge = installBridge();
    lunaRequest('luna://com.foo', {
      onFailure: () => {
        throw new Error('failure handler failed');
      },
    });

    expect(() => {
      bridge.callbacks[0]('{"returnValue":false}');
    }).toThrow('failure handler failed');
    expect(bridge.cancelCount()).toBe(1);
  });

  it('reports unavailable, construction, call, and serialization failures', () => {
    const unavailableFailure = vi.fn();
    lunaRequest('luna://com.foo', { onFailure: unavailableFailure });
    expect(unavailableFailure).toHaveBeenCalledWith(expect.objectContaining({
      errorText: 'PalmServiceBridge unavailable',
    }));

    const constructorBridge = installBridge({
      constructorError: new Error('constructor failed'),
    });
    const constructorFailure = vi.fn();
    lunaRequest('luna://com.foo', { onFailure: constructorFailure });
    expect(constructorFailure).toHaveBeenCalledWith(expect.objectContaining({
      errorText: 'constructor failed',
    }));
    expect(constructorBridge.cancelCount()).toBe(0);

    const callBridge = installBridge({ callError: new Error('call failed') });
    const callFailure = vi.fn();
    lunaRequest('luna://com.foo', { onFailure: callFailure });
    expect(callFailure).toHaveBeenCalledWith(expect.objectContaining({
      errorText: 'call failed',
    }));
    expect(callBridge.cancelCount()).toBe(1);

    const serializationBridge = installBridge();
    const parameters: Record<string, unknown> = {};
    parameters.self = parameters;
    const serializationFailure = vi.fn();
    lunaRequest('luna://com.foo', {
      parameters,
      onFailure: serializationFailure,
    });
    expect(serializationFailure).toHaveBeenCalledWith(expect.objectContaining({
      returnValue: false,
      errorCode: -1,
    }));
    expect(serializationBridge.cancelCount()).toBe(1);
  });
});
