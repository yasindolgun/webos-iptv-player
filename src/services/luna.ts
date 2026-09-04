export interface LunaResponse {
  returnValue?: boolean;
  errorCode?: number;
  errorText?: string;
}

export interface LunaRequestOptions<T extends LunaResponse = LunaResponse> {
  method?: string;
  parameters?: Record<string, unknown>;
  subscribe?: boolean;
  timeoutMs?: number;
  onSuccess?: (response: T) => void;
  onFailure?: (response: T) => void;
  onComplete?: (response: T) => void;
}

export interface LunaRequestHandle {
  cancel(): void;
}

interface PalmServiceBridgeInstance {
  onservicecallback: ((message: string) => void) | null;
  call(uri: string, payload: string): void;
  cancel(): void;
}

type PalmServiceBridgeConstructor = new () => PalmServiceBridgeInstance;

const activeRequests: LunaRequestHandle[] = [];

function bridgeConstructor(): PalmServiceBridgeConstructor | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as {
    PalmServiceBridge?: PalmServiceBridgeConstructor;
  }).PalmServiceBridge;
  return typeof candidate === 'function' ? candidate : null;
}

export function isLunaAvailable(): boolean {
  return bridgeConstructor() !== null;
}

function removeActiveRequest(request: LunaRequestHandle): void {
  const index = activeRequests.indexOf(request);
  if (index !== -1) activeRequests.splice(index, 1);
}

function failureResponse(error: unknown, fallback: string): LunaResponse {
  const message = error && typeof error === 'object' && 'message' in error
    ? String((error as { message?: unknown }).message)
    : fallback;
  return {
    returnValue: false,
    errorCode: -1,
    errorText: message,
  };
}

function isFailure(response: LunaResponse): boolean {
  return response.returnValue === false ||
    (typeof response.errorCode === 'number' && response.errorCode !== 0);
}

function parseResponse(message: string): LunaResponse {
  const parsed: unknown = JSON.parse(message);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Luna response');
  }
  const response = parsed as Record<string, unknown>;
  if (response.returnValue !== undefined && typeof response.returnValue !== 'boolean') {
    throw new Error('Invalid Luna returnValue');
  }
  if (response.errorCode !== undefined && typeof response.errorCode !== 'number') {
    throw new Error('Invalid Luna errorCode');
  }
  if (response.errorText !== undefined && typeof response.errorText !== 'string') {
    throw new Error('Invalid Luna errorText');
  }
  return response as LunaResponse;
}

export function lunaRequest<T extends LunaResponse = LunaResponse>(
  uri: string,
  options: LunaRequestOptions<T> = {},
): LunaRequestHandle {
  const parameters = options.parameters ?? {};
  const subscribe = options.subscribe === true || parameters.subscribe === true;
  const onSuccess = options.onSuccess ?? (() => {});
  const onFailure = options.onFailure ?? (() => {});
  const onComplete = options.onComplete ?? (() => {});
  let bridge: PalmServiceBridgeInstance | null = null;
  let cancelled = false;
  let initialResponseReceived = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const request: LunaRequestHandle = {
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      if (timeout !== null) {
        clearTimeout(timeout);
        timeout = null;
      }
      removeActiveRequest(request);
      if (!bridge) return;
      bridge.onservicecallback = null;
      try {
        bridge.cancel();
      } catch {
        // Cancellation is best-effort after the request has left our control.
      }
      bridge = null;
    },
  };
  activeRequests.push(request);

  const completeTerminal = (
    response: LunaResponse,
    callback: (value: T) => void,
  ): void => {
    request.cancel();
    try {
      callback(response as T);
    } finally {
      onComplete(response as T);
    }
  };

  const completeFailure = (response: LunaResponse): void => {
    completeTerminal(response, onFailure);
  };

  const Bridge = bridgeConstructor();
  if (!Bridge) {
    completeFailure(failureResponse(null, 'PalmServiceBridge unavailable'));
    return request;
  }

  try {
    bridge = new Bridge();
  } catch (error) {
    completeFailure(failureResponse(error, 'PalmServiceBridge unavailable'));
    return request;
  }

  bridge.onservicecallback = (message: string): void => {
    if (cancelled) return;
    initialResponseReceived = true;

    let response: LunaResponse;
    try {
      response = parseResponse(message);
    } catch (error) {
      response = failureResponse(error, 'Invalid Luna response');
    }

    if (isFailure(response)) {
      completeFailure(response);
      return;
    }
    if (!subscribe) {
      completeTerminal(response, onSuccess);
      return;
    }
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
    try {
      onSuccess(response as T);
    } finally {
      onComplete(response as T);
    }
  };

  const payload: Record<string, unknown> = {};
  for (const key in parameters) {
    if (Object.prototype.hasOwnProperty.call(parameters, key)) {
      payload[key] = parameters[key];
    }
  }
  if (subscribe) payload.subscribe = true;

  const base = uri.charAt(uri.length - 1) === '/' ? uri.slice(0, -1) : uri;
  const requestUri = base + (options.method ? '/' + options.method : '');
  try {
    bridge.call(requestUri, JSON.stringify(payload));
  } catch (error) {
    completeFailure(failureResponse(error, 'PalmServiceBridge call failed'));
    return request;
  }

  if (!cancelled && !initialResponseReceived
      && typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
    timeout = setTimeout(() => {
      completeFailure(failureResponse(
        null,
        `Luna request timed out after ${String(options.timeoutMs)}ms`,
      ));
    }, options.timeoutMs);
  }

  return request;
}
