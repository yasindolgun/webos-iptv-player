import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../types';
import type { WorkerTaskHandlers } from './worker-rpc';
import type { AppWorkerTasks } from './tasks';

const {
  cacheWriterAbortMock,
  cacheWriterAddMock,
  cacheWriterBeginMock,
  cacheWriterFinishMock,
  exposeMock,
  parseStageBeginMock,
} = vi.hoisted(() => ({
  cacheWriterAbortMock: vi.fn(),
  cacheWriterAddMock: vi.fn(),
  cacheWriterBeginMock: vi.fn(),
  cacheWriterFinishMock: vi.fn(),
  exposeMock: vi.fn(),
  parseStageBeginMock: vi.fn(),
}));

vi.mock('./worker-rpc', () => ({
  exposeWorkerTasks: exposeMock,
  withWorkerResponseTransfers: <Response>(response: Response) => response,
}));
vi.mock('../services/idb-cache', () => ({
  CachedPlaylistBatchWriter: {
    begin: cacheWriterBeginMock,
  },
}));
vi.mock('../services/playlist-parse-stage', () => ({
  PlaylistParseStage: {
    begin: parseStageBeginMock,
  },
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
  cacheWriterBeginMock.mockResolvedValue({
    abort: cacheWriterAbortMock,
    add: cacheWriterAddMock,
    finish: cacheWriterFinishMock,
  });
  parseStageBeginMock.mockImplementation(() => {
    const batches: Channel[][] = [];
    return Promise.resolve({
      abort: vi.fn(),
      add: vi.fn((channels: Channel[]) => { batches.push(channels); }),
      finish: vi.fn(),
      take: vi.fn((limit: number) => {
        const taken = batches.splice(0, limit);
        return { batches: taken, done: batches.length === 0 };
      }),
    });
  });
  await import('./app-worker');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  exposeMock.mockReset();
  parseStageBeginMock.mockReset();
  cacheWriterAbortMock.mockReset();
  cacheWriterAddMock.mockReset();
  cacheWriterBeginMock.mockReset();
  cacheWriterFinishMock.mockReset();
});

describe('app worker M3U task', () => {
  it('stages parsed channels and releases them in bounded result batches', async () => {
    const entries = Array.from({ length: 501 }, (_, index) =>
      `#EXTINF:-1,ch${String(index + 1)}\nhttp://host/${String(index + 1)}`);
    const source = ['#EXTM3U', ...entries].join('\n');
    const buffer = new TextEncoder().encode(source).buffer;
    const result = await handlers['m3u.parse']({
      buffer,
      sourceUrl: 'http://host/list.m3u',
      sentAtEpochMs: Date.now(),
      sessionId: 7,
    });

    expect(result).toMatchObject({
      data: {
        groups: ['builtin:uncategorized'],
      },
      channelCount: 501,
      metrics: {
        decodeChunkBytes: 64 * 1024,
        decodeChunks: 1,
        encoding: 'utf-8',
        inputBytes: buffer.byteLength,
        inputTransferMs: expect.any(Number),
        maxBufferedChannels: 500,
        maxDecodedChunkChars: source.length,
        parseMs: expect.any(Number),
        sourceStaging: 'indexeddb',
        stageBatchSize: 500,
        stageBatches: 2,
        stageWriteMs: expect.any(Number),
        completedAtEpochMs: expect.any(Number),
      },
    });
    expect('channels' in result.data).toBe(false);

    const first = await handlers['m3u.parse.next']({ sessionId: 7 });
    const second = await handlers['m3u.parse.next']({ sessionId: 7 });

    expect(first.channels).toHaveLength(500);
    expect(first.done).toBe(false);
    expect(second.channels).toEqual([
      expect.objectContaining({ name: 'ch501', url: 'http://host/501' }),
    ]);
    expect(second.done).toBe(true);
    await expect(handlers['m3u.parse.next']({ sessionId: 7 }))
      .rejects.toThrow('M3U parse session is no longer available');
  });

  it('reports bounded decoding for a multi-chunk transferred playlist', async () => {
    const entries = Array.from({ length: 2_000 }, (_, index) =>
      `#EXTINF:-1,Channel ${String(index)}\nhttp://host/${String(index)}`);
    const source = ['#EXTM3U', ...entries].join('\n');
    const buffer = new TextEncoder().encode(source).buffer;

    const parsed = await handlers['m3u.parse']({
      buffer,
      sourceUrl: 'http://host/list.m3u',
      sentAtEpochMs: Date.now(),
      sessionId: 8,
    });

    expect(buffer.byteLength).toBeGreaterThan(64 * 1024);
    expect(parsed.channelCount).toBe(2_000);
    expect(parsed.metrics.decodeChunkBytes).toBe(64 * 1024);
    expect(parsed.metrics.decodeChunks)
      .toBe(Math.ceil(buffer.byteLength / parsed.metrics.decodeChunkBytes));
    expect(parsed.metrics.maxDecodedChunkChars)
      .toBeLessThanOrEqual(parsed.metrics.decodeChunkBytes);
  });

  it('falls back to bounded worker-memory delivery when staging is unavailable', async () => {
    parseStageBeginMock.mockRejectedValueOnce(new Error('staging unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = '#EXTM3U\n#EXTINF:-1,ch1\nhttp://host/1';
    const buffer = new TextEncoder().encode(source).buffer;

    const parsed = await handlers['m3u.parse']({
      buffer,
      sourceUrl: 'http://host/list.m3u',
      sentAtEpochMs: Date.now(),
      sessionId: 9,
    });

    expect(parsed).toMatchObject({
      channelCount: 1,
      metrics: {
        sourceStaging: 'memory',
        stageBatches: 0,
        maxBufferedChannels: 1,
      },
    });
    await expect(handlers['m3u.parse.next']({ sessionId: 9 })).resolves.toMatchObject({
      channels: [expect.objectContaining({ name: 'ch1' })],
      done: true,
    });
  });

  it('keeps overlapping parse result sessions isolated', async () => {
    const firstBuffer = new TextEncoder().encode(
      '#EXTM3U\n#EXTINF:-1,ch1\nhttp://host/1',
    ).buffer;
    const secondBuffer = new TextEncoder().encode(
      '#EXTM3U\n#EXTINF:-1,ch2\nhttp://host/2',
    ).buffer;

    await Promise.all([
      handlers['m3u.parse']({
        buffer: firstBuffer,
        sourceUrl: 'http://host/first.m3u',
        sentAtEpochMs: Date.now(),
        sessionId: 21,
      }),
      handlers['m3u.parse']({
        buffer: secondBuffer,
        sourceUrl: 'http://host/second.m3u',
        sentAtEpochMs: Date.now(),
        sessionId: 22,
      }),
    ]);

    await expect(handlers['m3u.parse.next']({ sessionId: 21 })).resolves.toMatchObject({
      channels: [expect.objectContaining({ name: 'ch1' })],
      done: true,
    });
    await expect(handlers['m3u.parse.next']({ sessionId: 22 })).resolves.toMatchObject({
      channels: [expect.objectContaining({ name: 'ch2' })],
      done: true,
    });
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

describe('app worker playlist cache task', () => {
  it('keeps one backpressured writer session through manifest commit', async () => {
    expect(await handlers['playlist-cache.start']({
      sessionId: 13,
      writeId: 'write-1',
      sourceSignature: 'signature',
      epgSources: [],
      timestamp: 1000,
      channelCount: 1,
    })).toEqual({ accepted: true });
    expect(await handlers['playlist-cache.add']({
      sessionId: 13,
      channels: [{
        id: 'ch1',
        name: 'Alpha',
        logo: '',
        group: '',
        url: 'http://host/a',
        extras: null,
        playlistIds: ['p1'],
        catchup: '',
        catchupSource: '',
        catchupDays: 0,
      }],
    })).toEqual({ accepted: true });
    expect(await handlers['playlist-cache.finish']({ sessionId: 13 }))
      .toEqual({ accepted: true });

    expect(cacheWriterBeginMock).toHaveBeenCalledOnce();
    expect(cacheWriterAddMock).toHaveBeenCalledOnce();
    expect(cacheWriterFinishMock).toHaveBeenCalledOnce();
    await expect(handlers['playlist-cache.add']({ sessionId: 13, channels: [] }))
      .rejects.toThrow('Playlist cache session is no longer available');
  });
});
