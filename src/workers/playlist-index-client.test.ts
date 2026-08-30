import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../types';
import { PlaylistIndexBuilder } from './playlist-index';

const { releaseWorkerMock, retainWorkerMock, runTaskMock } = vi.hoisted(() => ({
  releaseWorkerMock: vi.fn(),
  retainWorkerMock: vi.fn(),
  runTaskMock: vi.fn(),
}));

vi.mock('./app-worker-client', () => ({
  retainAppWorker: retainWorkerMock,
  runAppWorkerTask: runTaskMock,
}));

import { preparePlaylistIndexesOffThread } from './playlist-index-client';

function channel(index: number): Channel {
  return {
    id: `ch${String(index)}`,
    name: `ch${String(index)}`,
    logo: '',
    group: `Group ${String(index % 2)}`,
    url: `http://host/${String(index)}`,
    extras: null,
    playlistIds: [`p${String(index % 2)}`],
    catchup: '',
    catchupSource: '',
    catchupDays: 0,
  };
}

beforeEach(() => {
  retainWorkerMock.mockReturnValue(releaseWorkerMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  releaseWorkerMock.mockReset();
  retainWorkerMock.mockReset();
  runTaskMock.mockReset();
});

describe('preparePlaylistIndexesOffThread', () => {
  it('sends only bounded document batches and retains the worker session', async () => {
    vi.stubGlobal('Worker', function WorkerStub() {});
    let builder: PlaylistIndexBuilder | null = null;
    runTaskMock.mockImplementation(async (task, request) => {
      if (task === 'playlist-index.start') {
        builder = new PlaylistIndexBuilder(request.customGroups, request.channelCount);
        return { accepted: true };
      }
      if (task === 'playlist-index.add') {
        builder?.add(request.documents);
        return { accepted: true };
      }
      if (!builder) throw new Error('missing builder');
      return builder.finish();
    });
    const channels = Array.from({ length: 501 }, (_, index) => channel(index));

    const plan = await preparePlaylistIndexesOffThread(channels, []);

    const addCalls = runTaskMock.mock.calls.filter(call => call[0] === 'playlist-index.add');
    expect(addCalls.map(call => call[1].documents.length)).toEqual([500, 1]);
    expect(plan.channelCount).toBe(501);
    expect(plan.channelIndicesByPlaylist.get('p1')).toHaveLength(250);
    expect(retainWorkerMock).toHaveBeenCalledOnce();
    expect(releaseWorkerMock).toHaveBeenCalledOnce();
  });

  it('builds the same plan locally when workers are unavailable', async () => {
    vi.stubGlobal('Worker', undefined);
    const plan = await preparePlaylistIndexesOffThread([channel(0), channel(1)], []);

    expect(plan.groups).toEqual(['Group 0', 'Group 1']);
    expect(Array.from(plan.channelIndicesByPlaylist.get('p0') ?? [])).toEqual([0]);
    expect(runTaskMock).not.toHaveBeenCalled();
  });

  it('yields to rendering between bounded worker batch groups', async () => {
    vi.stubGlobal('Worker', function WorkerStub() {});
    const frame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', frame);
    let builder: PlaylistIndexBuilder | null = null;
    runTaskMock.mockImplementation(async (task, request) => {
      if (task === 'playlist-index.start') {
        builder = new PlaylistIndexBuilder(request.customGroups, request.channelCount);
        return { accepted: true };
      }
      if (task === 'playlist-index.add') {
        builder?.add(request.documents);
        return { accepted: true };
      }
      if (!builder) throw new Error('missing builder');
      return builder.finish();
    });

    const plan = await preparePlaylistIndexesOffThread(
      Array.from({ length: 3001 }, (_, index) => channel(index)),
      [],
    );

    expect(plan.channelCount).toBe(3001);
    expect(frame).toHaveBeenCalledOnce();
  });

  it('falls back locally when a worker session fails', async () => {
    vi.stubGlobal('Worker', function WorkerStub() {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    runTaskMock.mockRejectedValue(new Error('worker unavailable'));

    const plan = await preparePlaylistIndexesOffThread([channel(0)], []);

    expect(plan.channelCount).toBe(1);
    expect(releaseWorkerMock).toHaveBeenCalledOnce();
  });
});
