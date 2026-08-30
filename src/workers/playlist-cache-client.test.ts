import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../types';

const {
  isRunningMock,
  releaseWorkerMock,
  retainWorkerMock,
  runTaskMock,
  setCachedPlaylistMock,
} = vi.hoisted(() => ({
  isRunningMock: vi.fn(),
  releaseWorkerMock: vi.fn(),
  retainWorkerMock: vi.fn(),
  runTaskMock: vi.fn(),
  setCachedPlaylistMock: vi.fn(),
}));

vi.mock('./app-worker-client', () => ({
  isAppWorkerRunning: isRunningMock,
  retainAppWorker: retainWorkerMock,
  runAppWorkerTask: runTaskMock,
}));
vi.mock('../services/idb-cache', () => ({
  playlistSourceSignature: () => 'signature',
  setCachedPlaylist: setCachedPlaylistMock,
}));

import {
  persistCachedPlaylistOffThread,
  runPlaylistCacheWorker,
} from './playlist-cache-client';

function channel(index: number): Channel {
  return {
    id: `ch${String(index)}`,
    name: `ch${String(index)}`,
    logo: '',
    group: '',
    url: `http://host/${String(index)}`,
    extras: null,
    playlistIds: ['p1'],
    catchup: '',
    catchupSource: '',
    catchupDays: 0,
  };
}

beforeEach(() => {
  retainWorkerMock.mockReturnValue(releaseWorkerMock);
  isRunningMock.mockReturnValue(false);
  setCachedPlaylistMock.mockResolvedValue(true);
  runTaskMock.mockResolvedValue({ accepted: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  isRunningMock.mockReset();
  releaseWorkerMock.mockReset();
  retainWorkerMock.mockReset();
  runTaskMock.mockReset();
  setCachedPlaylistMock.mockReset();
});

describe('playlist cache worker client', () => {
  it('waits for each bounded batch before sending the next one', async () => {
    const channels = Array.from({ length: 1001 }, (_, index) => channel(index));
    let active = 0;
    let maximumActive = 0;
    runTaskMock.mockImplementation(async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active--;
      return { accepted: true };
    });

    const metrics = await runPlaylistCacheWorker(channels);

    const addCalls = runTaskMock.mock.calls.filter(call => call[0] === 'playlist-cache.add');
    expect(addCalls.map(call => call[1].channels.length)).toEqual([500, 500, 1]);
    expect(maximumActive).toBe(1);
    expect(metrics).toMatchObject({ batchSize: 500, batches: 3, channels: 1001 });
    expect(runTaskMock.mock.calls.map(call => call[0])).toEqual([
      'playlist-cache.start',
      'playlist-cache.add',
      'playlist-cache.add',
      'playlist-cache.add',
      'playlist-cache.finish',
    ]);
    expect(releaseWorkerMock).toHaveBeenCalledOnce();
  });

  it('uses the compatible page writer when the worker fails', async () => {
    vi.stubGlobal('Worker', function WorkerStub() {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    runTaskMock.mockRejectedValue(new Error('worker unavailable'));
    const channels = [channel(0)];

    await expect(persistCachedPlaylistOffThread(channels)).resolves.toBe(true);

    expect(setCachedPlaylistMock).toHaveBeenCalledWith(
      channels,
      [],
      expect.any(Number),
      'signature',
    );
    expect(releaseWorkerMock).toHaveBeenCalledOnce();
  });
});
