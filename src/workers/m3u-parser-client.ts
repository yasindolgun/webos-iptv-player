import type { ParsedPlaylist } from '../types';
import { parseM3UBytes } from '../parsers/m3u-parser';
import { runAppWorkerTask } from './app-worker-client';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('M3UWorker');

export async function parseM3UOffThread(
  buffer: ArrayBuffer,
  sourceUrl: string,
): Promise<ParsedPlaylist> {
  if (typeof Worker === 'undefined') {
    return parseM3UBytes(new Uint8Array(buffer), sourceUrl);
  }
  try {
    return await runAppWorkerTask('m3u.parse', { buffer, sourceUrl }, {
      transfer: [buffer],
      timeoutMs: CONFIG.M3U.PARSE_TIMEOUT_MS,
    });
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
