import type { ParsedPlaylist } from '../types';
import { parseM3UBytes } from '../parsers/m3u-parser';
import { runAppWorkerTask } from './app-worker-client';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import type { M3UParseWorkerResponse } from './tasks';

const log = createLogger('M3UWorker');

export interface M3UWorkerParseResult extends M3UParseWorkerResponse {
  metrics: M3UParseWorkerResponse['metrics'] & {
    roundTripMs: number;
    resultCloneDeliveryMs: number;
  };
}

export async function runM3UParseWorker(
  buffer: ArrayBuffer,
  sourceUrl: string,
  timeoutMs = CONFIG.M3U.PARSE_TIMEOUT_MS,
): Promise<M3UWorkerParseResult> {
  const sentAtEpochMs = Date.now();
  const started = performance.now();
  const response = await runAppWorkerTask('m3u.parse', {
    buffer,
    sourceUrl,
    sentAtEpochMs,
  }, {
    transfer: [buffer],
    timeoutMs,
  });
  return {
    ...response,
    metrics: {
      ...response.metrics,
      roundTripMs: performance.now() - started,
      resultCloneDeliveryMs: Math.max(0, Date.now() - response.metrics.completedAtEpochMs),
    },
  };
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
