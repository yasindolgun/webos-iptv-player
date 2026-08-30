import { CONFIG } from '../config';
import type { Channel } from '../types';
import { createLogger } from '../utils/logger';
import { retainAppWorker, runAppWorkerTask } from './app-worker-client';
import {
  buildPlaylistIndexPlan,
  playlistIndexDocument,
  type PlaylistIndexPlan,
} from './playlist-index';

const log = createLogger('PlaylistIndex');
let nextSessionId = 1;

export interface PlaylistIndexPreparationMetrics {
  transport: 'worker' | 'fallback';
  startMs: number;
  batchesMs: number;
  finishMs: number;
}

export async function preparePlaylistIndexesOffThread(
  channels: Channel[],
  customGroups: Array<{ key: string; label: string }>,
  timeoutMs = CONFIG.M3U.PARSE_TIMEOUT_MS,
  onMetrics?: (metrics: PlaylistIndexPreparationMetrics) => void,
): Promise<PlaylistIndexPlan> {
  if (typeof Worker === 'undefined') {
    const started = performance.now();
    const plan = buildPlaylistIndexPlan(channels, customGroups);
    onMetrics?.({
      transport: 'fallback',
      startMs: 0,
      batchesMs: performance.now() - started,
      finishMs: 0,
    });
    return plan;
  }
  const sessionId = nextSessionId++;
  const releaseWorker = retainAppWorker();
  const started = performance.now();
  let startCompleted = started;
  let batchesCompleted = started;
  try {
    await runAppWorkerTask(
      'playlist-index.start',
      { sessionId, customGroups, channelCount: channels.length },
      { timeoutMs },
    );
    startCompleted = performance.now();
    for (let start = 0; start < channels.length; start += CONFIG.M3U.RESULT_BATCH_SIZE) {
      const end = Math.min(start + CONFIG.M3U.RESULT_BATCH_SIZE, channels.length);
      const documents = [];
      for (let index = start; index < end; index++) {
        documents.push(playlistIndexDocument(channels[index]));
      }
      await runAppWorkerTask(
        'playlist-index.add',
        { sessionId, documents },
        { timeoutMs },
      );
      const batchNumber = end / CONFIG.M3U.RESULT_BATCH_SIZE;
      if (end < channels.length
          && batchNumber % CONFIG.M3U.INDEX_BATCHES_PER_YIELD === 0) {
        await yieldIndexPreparation();
      }
    }
    batchesCompleted = performance.now();
    const plan = await runAppWorkerTask('playlist-index.finish', { sessionId }, { timeoutMs });
    if (plan.channelCount !== channels.length) {
      throw new Error(
        `Playlist index worker prepared ${String(plan.channelCount)} of `
        + `${String(channels.length)} channels`,
      );
    }
    onMetrics?.({
      transport: 'worker',
      startMs: startCompleted - started,
      batchesMs: batchesCompleted - startCompleted,
      finishMs: performance.now() - batchesCompleted,
    });
    return plan;
  } catch (error) {
    log.warn(
      'Worker index preparation unavailable; using main-thread fallback',
      'event=playlist.index.worker.fallback.used',
      error,
    );
    const fallbackStarted = performance.now();
    const plan = buildPlaylistIndexPlan(channels, customGroups);
    onMetrics?.({
      transport: 'fallback',
      startMs: startCompleted - started,
      batchesMs: performance.now() - fallbackStarted,
      finishMs: 0,
    });
    return plan;
  } finally {
    releaseWorker();
  }
}

function yieldIndexPreparation(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function'
        && (typeof document === 'undefined' || !document.hidden)) {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}
