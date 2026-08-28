import { describe, expect, it, vi } from 'vitest';
import { exposeWorkerTasks, WorkerRpcClient } from './worker-rpc';

interface TestTasks {
  add: {
    request: { left: number; right: number };
    response: number;
  };
  fail: {
    request: undefined;
    response: never;
  };
}

class LinkedEndpoint {
  peer: LinkedEndpoint | null = null;
  terminated = false;
  private messageListener: ((event: MessageEvent<unknown>) => void) | null = null;
  private errorListener: ((event: ErrorEvent) => void) | null = null;
  private messageErrorListener: (() => void) | null = null;
  lastTransfer: Transferable[] | undefined;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.lastTransfer = transfer;
    queueMicrotask(() => {
      this.peer?.messageListener?.({ data: message } as MessageEvent<unknown>);
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  emitError(message: string): void {
    this.errorListener?.({ message } as ErrorEvent);
  }

  emitMessageError(): void {
    this.messageErrorListener?.();
  }

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: ((event: MessageEvent<unknown>) => void)
      | ((event: ErrorEvent) => void)
      | (() => void),
  ): void {
    if (type === 'message') {
      this.messageListener = listener as (event: MessageEvent<unknown>) => void;
    } else if (type === 'error') {
      this.errorListener = listener as (event: ErrorEvent) => void;
    } else {
      this.messageErrorListener = listener as () => void;
    }
  }
}

function linkedEndpoints(): [LinkedEndpoint, LinkedEndpoint] {
  const client = new LinkedEndpoint();
  const worker = new LinkedEndpoint();
  client.peer = worker;
  worker.peer = client;
  return [client, worker];
}

describe('WorkerRpcClient', () => {
  it('matches concurrent responses by request id', async () => {
    const [clientEndpoint, workerEndpoint] = linkedEndpoints();
    exposeWorkerTasks<TestTasks>(workerEndpoint, {
      add: async ({ left, right }) => {
        await Promise.resolve();
        return left + right;
      },
      fail: () => {
        throw new Error('failed task');
      },
    });
    const client = new WorkerRpcClient<TestTasks>(clientEndpoint);

    await expect(Promise.all([
      client.request('add', { left: 1, right: 2 }),
      client.request('add', { left: 4, right: 5 }),
    ])).resolves.toEqual([3, 9]);
    await expect(client.request('fail', undefined)).rejects.toThrow('failed task');
  });

  it('passes transferables to the worker endpoint', async () => {
    const [clientEndpoint, workerEndpoint] = linkedEndpoints();
    exposeWorkerTasks<TestTasks>(workerEndpoint, {
      add: ({ left, right }) => left + right,
      fail: () => { throw new Error('failed task'); },
    });
    const client = new WorkerRpcClient<TestTasks>(clientEndpoint);
    const buffer = new ArrayBuffer(4);

    await expect(client.request('add', { left: 1, right: 2 }, { transfer: [buffer] }))
      .resolves.toBe(3);
    expect(clientEndpoint.lastTransfer).toEqual([buffer]);
  });

  it('terminates a worker that does not settle a bounded request', async () => {
    vi.useFakeTimers();
    try {
      const [clientEndpoint] = linkedEndpoints();
      const fatals: string[] = [];
      const client = new WorkerRpcClient<TestTasks>(clientEndpoint, {
        onFatal: (_error, reason) => fatals.push(reason),
      });
      const pending = client.request('add', { left: 1, right: 2 }, { timeoutMs: 1000 });
      const rejection = expect(pending).rejects.toThrow('Worker task timed out: add');

      await vi.advanceTimersByTimeAsync(1000);

      await rejection;
      expect(clientEndpoint.terminated).toBe(true);
      expect(fatals).toEqual(['timeout']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects pending work and terminates explicitly', async () => {
    const [clientEndpoint] = linkedEndpoints();
    const client = new WorkerRpcClient<TestTasks>(clientEndpoint);
    const pending = client.request('add', { left: 1, right: 2 });

    client.terminate();

    await expect(pending).rejects.toThrow('terminated');
    await expect(client.request('add', { left: 1, right: 2 }))
      .rejects.toThrow('terminated');
    expect(clientEndpoint.terminated).toBe(true);
  });

  it('surfaces worker execution errors', async () => {
    const [clientEndpoint] = linkedEndpoints();
    const fatals: string[] = [];
    const client = new WorkerRpcClient<TestTasks>(clientEndpoint, {
      onFatal: (_error, reason) => fatals.push(reason),
    });
    const pending = client.request('add', { left: 1, right: 2 });
    clientEndpoint.emitError('worker crashed');

    await expect(pending).rejects.toThrow('worker crashed');
    expect(fatals).toEqual(['execution_error']);
  });

  it('identifies response deserialization failures', async () => {
    const [clientEndpoint] = linkedEndpoints();
    const fatals: string[] = [];
    const client = new WorkerRpcClient<TestTasks>(clientEndpoint, {
      onFatal: (_error, reason) => fatals.push(reason),
    });
    const pending = client.request('add', { left: 1, right: 2 });
    clientEndpoint.emitMessageError();

    await expect(pending).rejects.toThrow('could not be deserialized');
    expect(fatals).toEqual(['message_error']);
  });

  it('preserves structured worker error details', async () => {
    const [clientEndpoint, workerEndpoint] = linkedEndpoints();
    exposeWorkerTasks<TestTasks>(workerEndpoint, {
      add: ({ left, right }) => left + right,
      fail: () => {
        const error = new Error('failed task');
        Object.assign(error, { details: { stage: 'parse' } });
        throw error;
      },
    });
    const client = new WorkerRpcClient<TestTasks>(clientEndpoint);

    await expect(client.request('fail', undefined)).rejects.toMatchObject({
      message: 'failed task',
      details: { stage: 'parse' },
    });
  });
});
