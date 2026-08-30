import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerTaskHandlers } from './worker-rpc';
import type { AppWorkerTasks } from './tasks';

const { exposeMock } = vi.hoisted(() => ({ exposeMock: vi.fn() }));

vi.mock('./worker-rpc', () => ({
  exposeWorkerTasks: exposeMock,
  withWorkerResponseTransfers: <Response>(response: Response) => response,
}));

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

describe('app worker playlist index task', () => {
  it('prepares compact indices over a bounded document session', () => {
    const documents = [
      {
        url: 'http://host/a',
        group: 'News',
        groupKey: '',
        sourceGroup: '',
        contentKind: '' as const,
        playlistIds: ['p1'],
      },
      {
        url: 'http://host/b',
        group: 'Movies',
        groupKey: 'custom',
        sourceGroup: 'News',
        contentKind: 'movie' as const,
        playlistIds: ['p1', 'p2'],
      },
    ];

    expect(handlers['playlist-index.start']({
      sessionId: 11,
      channelCount: 2,
      customGroups: [{ key: 'empty', label: 'Empty' }],
    })).toEqual({ accepted: true });
    expect(handlers['playlist-index.add']({ sessionId: 11, documents }))
      .toEqual({ accepted: true });
    const plan = handlers['playlist-index.finish']({ sessionId: 11 });

    expect(plan.channelCount).toBe(2);
    expect(plan.groups).toEqual(['News', 'Movies', 'Empty']);
    expect(Array.from(plan.channelIndicesByGroup.get('News') ?? [])).toEqual([0]);
    expect(Array.from(plan.channelIndicesByContentKind.get('movie') ?? [])).toEqual([1]);
    expect(Array.from(plan.channelIndicesByPlaylist.get('p1') ?? [])).toEqual([0, 1]);
    expect(Array.from(plan.channelIndicesByPlaylistGroup.get('p2')?.get('Movies') ?? []))
      .toEqual([1]);
    expect(plan.groupsByPlaylist.get('p1')).toEqual(['News', 'Movies']);
    expect(plan.groupKeyByDisplay.get('Movies')).toBe('custom');
    expect(() => handlers['playlist-index.finish']({ sessionId: 11 }))
      .toThrow('Playlist index session is no longer available');
  });
});
