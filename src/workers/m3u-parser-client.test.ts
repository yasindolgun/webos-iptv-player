import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseM3UBytes } from '../parsers/m3u-parser';

const { releaseWorkerMock, retainWorkerMock, runTaskMock } = vi.hoisted(() => ({
  releaseWorkerMock: vi.fn(),
  retainWorkerMock: vi.fn(),
  runTaskMock: vi.fn(),
}));

vi.mock('./app-worker-client', () => ({
  retainAppWorker: retainWorkerMock,
  runAppWorkerTask: runTaskMock,
}));

import { parseM3UOffThread, runM3UParseWorker } from './m3u-parser-client';

const SOURCE = '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://host/a';
const DECODE_METRICS = {
  decodeChunkBytes: 64 * 1024,
  decodeChunks: 1,
  encoding: 'utf-8' as const,
  maxDecodedChunkChars: SOURCE.length,
  maxBufferedChannels: 1,
  sourceStaging: 'indexeddb' as const,
  stageBatchSize: 500,
  stageBatches: 1,
  stageReadBatches: 6,
  stageWriteMs: 3,
};

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
    runTaskMock.mockImplementation(async (task) => {
      if (task === 'm3u.parse.next') return { channels: parsed.channels, done: true };
      const { channels: _channels, ...data } = parsed;
      return {
        data,
        channelCount: parsed.channels.length,
        metrics: {
          ...DECODE_METRICS,
          inputBytes: buffer.byteLength,
          inputTransferMs: 15,
          parseMs: 40,
          completedAtEpochMs: 1065,
        },
      };
    });

    const result = await runM3UParseWorker(buffer, 'http://host/list.m3u', 75);

    expect(result.data).toEqual(parsed);
    expect(result.metrics).toEqual({
      ...DECODE_METRICS,
      inputBytes: buffer.byteLength,
      inputTransferMs: 15,
      parseMs: 40,
      completedAtEpochMs: 1065,
      roundTripMs: 80,
      resultCloneDeliveryMs: 25,
      resultBatchSize: 500,
      resultBatches: 1,
    });
    expect(runTaskMock).toHaveBeenCalledWith(
      'm3u.parse',
      {
        buffer,
        sourceUrl: 'http://host/list.m3u',
        sentAtEpochMs: 1000,
        sessionId: expect.any(Number),
      },
      { transfer: [buffer], timeoutMs: 75 },
    );
    expect(runTaskMock).toHaveBeenCalledWith(
      'm3u.parse.next',
      { sessionId: expect.any(Number) },
      { timeoutMs: 75 },
    );
    expect(retainWorkerMock).toHaveBeenCalledOnce();
    expect(releaseWorkerMock).toHaveBeenCalledOnce();
  });

  it('does not report a negative clone-delivery duration after a clock adjustment', async () => {
    const buffer = new TextEncoder().encode(SOURCE).buffer;
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(900);
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(20);
    const parsed = parseM3UBytes(new Uint8Array(buffer), 'http://host/list.m3u');
    runTaskMock.mockImplementation(async (task) => {
      if (task === 'm3u.parse.next') return { channels: parsed.channels, done: true };
      const { channels: _channels, ...data } = parsed;
      return {
        data,
        channelCount: parsed.channels.length,
        metrics: {
          inputBytes: buffer.byteLength,
          inputTransferMs: 1,
          parseMs: 2,
          completedAtEpochMs: 950,
        },
      };
    });

    const result = await runM3UParseWorker(buffer, 'http://host/list.m3u');

    expect(result.metrics.resultCloneDeliveryMs).toBe(0);
    expect(result.metrics.roundTripMs).toBe(10);
  });

  it('rejects an empty intermediate batch and releases the retained worker', async () => {
    const buffer = new TextEncoder().encode(SOURCE).buffer;
    const parsed = parseM3UBytes(new Uint8Array(buffer), 'http://host/list.m3u');
    runTaskMock.mockImplementation(async (task) => {
      if (task === 'm3u.parse.next') return { channels: [], done: false };
      const { channels: _channels, ...data } = parsed;
      return {
        data,
        channelCount: 1,
        metrics: {
          inputBytes: buffer.byteLength,
          inputTransferMs: 1,
          parseMs: 2,
          completedAtEpochMs: Date.now(),
        },
      };
    });

    await expect(runM3UParseWorker(buffer, 'http://host/list.m3u'))
      .rejects.toThrow('empty intermediate batch');
    expect(releaseWorkerMock).toHaveBeenCalledOnce();
  });

  it('rejects a completed response that omits parsed channels', async () => {
    const buffer = new TextEncoder().encode(SOURCE).buffer;
    const parsed = parseM3UBytes(new Uint8Array(buffer), 'http://host/list.m3u');
    runTaskMock.mockImplementation(async (task) => {
      if (task === 'm3u.parse.next') return { channels: parsed.channels, done: true };
      const { channels: _channels, ...data } = parsed;
      return {
        data,
        channelCount: 2,
        metrics: {
          inputBytes: buffer.byteLength,
          inputTransferMs: 1,
          parseMs: 2,
          completedAtEpochMs: Date.now(),
        },
      };
    });

    await expect(runM3UParseWorker(buffer, 'http://host/list.m3u'))
      .rejects.toThrow('returned 1 of 2 parsed channels');
    expect(releaseWorkerMock).toHaveBeenCalledOnce();
  });

  it('yields to rendering between staged result batch groups', async () => {
    const frame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', frame);
    const entries = Array.from({ length: 3_001 }, (_, index) =>
      `#EXTINF:-1,ch${String(index)}\nhttp://host/${String(index)}`);
    const source = ['#EXTM3U', ...entries].join('\n');
    const buffer = new TextEncoder().encode(source).buffer;
    const parsed = parseM3UBytes(new Uint8Array(buffer), 'http://host/list.m3u');
    let cursor = 0;
    runTaskMock.mockImplementation(async (task) => {
      if (task === 'm3u.parse.next') {
        const channels = parsed.channels.slice(cursor, cursor + 500);
        cursor += channels.length;
        return { channels, done: cursor >= parsed.channels.length };
      }
      const { channels: _channels, ...data } = parsed;
      return {
        data,
        channelCount: parsed.channels.length,
        metrics: {
          ...DECODE_METRICS,
          inputBytes: buffer.byteLength,
          inputTransferMs: 1,
          parseMs: 2,
          completedAtEpochMs: Date.now(),
        },
      };
    });

    const result = await runM3UParseWorker(buffer, 'http://host/list.m3u');

    expect(result.data.channels).toHaveLength(3_001);
    expect(result.metrics.resultBatches).toBe(7);
    expect(frame).toHaveBeenCalledOnce();
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
    let workerChannels = parseM3UBytes(new Uint8Array(buffer), 'http://host/list.m3u').channels;
    runTaskMock.mockImplementation(async (task, request) => {
      if (task === 'm3u.parse.next') {
        const channels = workerChannels;
        workerChannels = [];
        return { channels, done: true };
      }
      const parsed = parseM3UBytes(new Uint8Array(request.buffer), request.sourceUrl);
      const { channels: _channels, ...data } = parsed;
      workerChannels = parsed.channels;
      return {
        data,
        channelCount: parsed.channels.length,
        metrics: {
          inputBytes: request.buffer.byteLength,
          inputTransferMs: 1,
          parseMs: 2,
          completedAtEpochMs: Date.now(),
        },
      };
    });

    const parsed = await parseM3UOffThread(buffer, 'http://host/list.m3u');

    expect(parsed.channels.map(channel => channel.name)).toEqual(['Alpha']);
    expect(runTaskMock).toHaveBeenCalledWith(
      'm3u.parse',
      {
        buffer,
        sourceUrl: 'http://host/list.m3u',
        sentAtEpochMs: expect.any(Number),
        sessionId: expect.any(Number),
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
