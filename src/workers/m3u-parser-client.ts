import type { ParsedPlaylist } from '../types';
import { parseM3UBytes } from '../parsers/m3u-parser';
import { retainAppWorker, runAppWorkerTask } from './app-worker-client';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import type { M3UParseWorkerResponse } from './tasks';

const log = createLogger('M3UWorker');
let nextSessionId = 1;

export type M3UWorkerParseResult = Omit<M3UParseWorkerResponse, 'data' | 'metrics'> & {
  data: ParsedPlaylist;
  metrics: M3UParseWorkerResponse['metrics'] & {
    roundTripMs: number;
    resultCloneDeliveryMs: number;
    resultBatchSize: number;
    resultBatches: number;
  };
};

export async function runM3UParseWorker(
  buffer: ArrayBuffer,
  sourceUrl: string,
  timeoutMs = CONFIG.M3U.PARSE_TIMEOUT_MS,
): Promise<M3UWorkerParseResult> {
  const sessionId = nextSessionId++;
  const sentAtEpochMs = Date.now();
  const started = performance.now();
  const releaseWorker = retainAppWorker();
  try {
    const response = await runAppWorkerTask('m3u.parse', {
      buffer,
      sourceUrl,
      sentAtEpochMs,
      sessionId,
    }, {
      transfer: [buffer],
      timeoutMs,
    });
    const channels: ParsedPlaylist['channels'] = [];
    let resultBatches = 0;
    let done = response.channelCount === 0;
    while (!done) {
      const batch = await runAppWorkerTask('m3u.parse.next', { sessionId }, { timeoutMs });
      if (!batch.channels.length && !batch.done) {
        throw new Error('M3U worker returned an empty intermediate batch');
      }
      channels.push(...batch.channels);
      resultBatches++;
      done = batch.done;
      if (!done && resultBatches % CONFIG.M3U.RESULT_BATCHES_PER_YIELD === 0) {
        await yieldResultDelivery();
      }
    }
    if (channels.length !== response.channelCount) {
      throw new Error(
        `M3U worker returned ${String(channels.length)} of `
        + `${String(response.channelCount)} parsed channels`,
      );
    }
    const completedAt = performance.now();
    return {
      data: { ...response.data, channels },
      channelCount: response.channelCount,
      metrics: {
        ...response.metrics,
        roundTripMs: completedAt - started,
        resultCloneDeliveryMs: Math.max(0, Date.now() - response.metrics.completedAtEpochMs),
        resultBatchSize: CONFIG.M3U.RESULT_BATCH_SIZE,
        resultBatches,
      },
    };
  } finally {
    releaseWorker();
  }
}

function yieldResultDelivery(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function'
        && (typeof document === 'undefined' || !document.hidden)) {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

export async function parseM3UOffThread(
  buffer: ArrayBuffer,
  sourceUrl: string,
): Promise<ParsedPlaylist> {
  if (typeof Worker === 'undefined') {
    return parseM3UBytes(new Uint8Array(buffer), sourceUrl);
  }
  try {
    return (await runM3UParseWorker(buffer, sourceUrl)).data;
  } catch (error) {
    if (buffer.byteLength === 0) throw error;
    log.warn(
      'Worker parse unavailable; using main-thread fallback',
      'event=m3u.worker.fallback.used',
      error,
    );
    return parseM3UBytes(new Uint8Array(buffer), sourceUrl);
  }
}
