import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerTaskHandlers } from './worker-rpc';
import type { AppWorkerTasks } from './tasks';

const { exposeMock } = vi.hoisted(() => ({ exposeMock: vi.fn() }));

vi.mock('./worker-rpc', () => ({ exposeWorkerTasks: exposeMock }));

let handlers: WorkerTaskHandlers<AppWorkerTasks>;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('self', {});
  exposeMock.mockImplementation((
    _endpoint: unknown,
    registered: WorkerTaskHandlers<AppWorkerTasks>,
  ) => {
    handlers = registered;
  });
  await import('./app-worker');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  exposeMock.mockReset();
});

describe('app worker M3U task', () => {
  it('retains parsed channels and releases them in bounded result batches', () => {
    const entries = Array.from({ length: 501 }, (_, index) =>
      `#EXTINF:-1,ch${String(index + 1)}\nhttp://host/${String(index + 1)}`);
    const source = ['#EXTM3U', ...entries].join('\n');
    const buffer = new TextEncoder().encode(source).buffer;
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1100);
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(70);

    const result = handlers['m3u.parse']({
      buffer,
      sourceUrl: 'http://host/list.m3u',
      sentAtEpochMs: 900,
      sessionId: 7,
    });

    expect(result).toMatchObject({
      data: {
        groups: ['builtin:uncategorized'],
      },
      channelCount: 501,
      metrics: {
        inputBytes: buffer.byteLength,
        inputTransferMs: 100,
        parseMs: 50,
        completedAtEpochMs: 1100,
      },
    });
    expect('channels' in result.data).toBe(false);

    const first = handlers['m3u.parse.next']({ sessionId: 7 });
    const second = handlers['m3u.parse.next']({ sessionId: 7 });

    expect(first.channels).toHaveLength(500);
    expect(first.done).toBe(false);
    expect(second.channels).toEqual([
      expect.objectContaining({ name: 'ch501', url: 'http://host/501' }),
    ]);
    expect(second.done).toBe(true);
    expect(() => handlers['m3u.parse.next']({ sessionId: 7 }))
      .toThrow('M3U parse session is no longer available');
  });
});
