import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseM3UBytes } from '../parsers/m3u-parser';

const { runTaskMock } = vi.hoisted(() => ({ runTaskMock: vi.fn() }));

vi.mock('./app-worker-client', () => ({ runAppWorkerTask: runTaskMock }));

import { parseM3UOffThread } from './m3u-parser-client';

const SOURCE = '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://host/a';

afterEach(() => {
  vi.unstubAllGlobals();
  runTaskMock.mockReset();
});

describe('parseM3UOffThread', () => {
  it('parses locally when workers are unavailable', async () => {
    vi.stubGlobal('Worker', undefined);
    const buffer = new TextEncoder().encode(SOURCE).buffer;

    const parsed = await parseM3UOffThread(buffer, 'http://host/list.m3u');

    expect(parsed.channels.map(channel => channel.name)).toEqual(['Alpha']);
    expect(runTaskMock).not.toHaveBeenCalled();
  });

  it('transfers the playlist buffer to the app worker', async () => {
    vi.stubGlobal('Worker', function WorkerStub() {});
    const buffer = new TextEncoder().encode(SOURCE).buffer;
    runTaskMock.mockImplementation(async (_task, request) =>
      parseM3UBytes(new Uint8Array(request.buffer), request.sourceUrl));

    const parsed = await parseM3UOffThread(buffer, 'http://host/list.m3u');

    expect(parsed.channels.map(channel => channel.name)).toEqual(['Alpha']);
    expect(runTaskMock).toHaveBeenCalledWith(
      'm3u.parse',
      { buffer, sourceUrl: 'http://host/list.m3u' },
      {
        transfer: [buffer],
        timeoutMs: 120000,
      },
    );
  });

  it('parses locally when the worker request fails before transferring the buffer', async () => {
    vi.stubGlobal('Worker', function WorkerStub() {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const buffer = new TextEncoder().encode(SOURCE).buffer;
    runTaskMock.mockRejectedValue(new Error('worker unavailable'));

    const parsed = await parseM3UOffThread(buffer, 'http://host/list.m3u');

    expect(parsed.channels.map(channel => channel.name)).toEqual(['Alpha']);
    expect(warn).toHaveBeenCalledWith(
      '[M3UWorker]',
      'Worker parse unavailable; using main-thread fallback',
      'event=m3u.worker.fallback.used',
      expect.objectContaining({ message: 'worker unavailable' }),
    );
  });
});
