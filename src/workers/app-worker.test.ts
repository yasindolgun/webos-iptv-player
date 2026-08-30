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
  it('parses the transferred buffer and reports worker-side timing phases', () => {
    const source = '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://host/a';
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
    });

    expect(result).toMatchObject({
      data: {
        channels: [{ name: 'Alpha', url: 'http://host/a' }],
      },
      metrics: {
        inputBytes: buffer.byteLength,
        inputTransferMs: 100,
        parseMs: 50,
        completedAtEpochMs: 1100,
      },
    });
  });
});
