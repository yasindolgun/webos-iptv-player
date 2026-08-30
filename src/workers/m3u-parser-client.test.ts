import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseM3UBytes } from '../parsers/m3u-parser';

const { runTaskMock } = vi.hoisted(() => ({ runTaskMock: vi.fn() }));

vi.mock('./app-worker-client', () => ({ runAppWorkerTask: runTaskMock }));

import { parseM3UOffThread, runM3UParseWorker } from './m3u-parser-client';

const SOURCE = '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://host/a';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  runTaskMock.mockReset();
});

describe('runM3UParseWorker', () => {
  it('reports round-trip phases and passes through a custom timeout', async () => {
    const buffer = new TextEncoder().encode(SOURCE).buffer;
    const parsed = parseM3UBytes(new Uint8Array(buffer), 'http://host/list.m3u');
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1090);
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(280);
    runTaskMock.mockResolvedValue({
      data: parsed,
      metrics: {
        inputBytes: buffer.byteLength,
        inputTransferMs: 15,
        parseMs: 40,
        completedAtEpochMs: 1065,
      },
    });

    const result = await runM3UParseWorker(buffer, 'http://host/list.m3u', 75);

    expect(result.data).toBe(parsed);
    expect(result.metrics).toEqual({
      inputBytes: buffer.byteLength,
      inputTransferMs: 15,
      parseMs: 40,
      completedAtEpochMs: 1065,
      roundTripMs: 80,
      resultCloneDeliveryMs: 25,
    });
    expect(runTaskMock).toHaveBeenCalledWith(
      'm3u.parse',
      {
        buffer,
        sourceUrl: 'http://host/list.m3u',
        sentAtEpochMs: 1000,
      },
      { transfer: [buffer], timeoutMs: 75 },
    );
  });

  it('does not report a negative clone-delivery duration after a clock adjustment', async () => {
    const buffer = new TextEncoder().encode(SOURCE).buffer;
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(900);
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(20);
    runTaskMock.mockResolvedValue({
      data: parseM3UBytes(new Uint8Array(buffer), 'http://host/list.m3u'),
      metrics: {
        inputBytes: buffer.byteLength,
        inputTransferMs: 1,
        parseMs: 2,
        completedAtEpochMs: 950,
      },
    });

    const result = await runM3UParseWorker(buffer, 'http://host/list.m3u');

    expect(result.metrics.resultCloneDeliveryMs).toBe(0);
    expect(result.metrics.roundTripMs).toBe(10);
  });
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
    runTaskMock.mockImplementation(async (_task, request) => ({
      data: parseM3UBytes(new Uint8Array(request.buffer), request.sourceUrl),
      metrics: {
        inputBytes: request.buffer.byteLength,
        inputTransferMs: 1,
        parseMs: 2,
        completedAtEpochMs: Date.now(),
      },
    }));

    const parsed = await parseM3UOffThread(buffer, 'http://host/list.m3u');

    expect(parsed.channels.map(channel => channel.name)).toEqual(['Alpha']);
    expect(runTaskMock).toHaveBeenCalledWith(
      'm3u.parse',
      {
        buffer,
        sourceUrl: 'http://host/list.m3u',
        sentAtEpochMs: expect.any(Number),
      },
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
