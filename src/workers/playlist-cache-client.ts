import { CONFIG } from '../config';
import type { Channel, EpgSource } from '../types';
import { createLogger } from '../utils/logger';
import {
  playlistSourceSignature,
  setCachedPlaylist,
} from '../services/idb-cache';
import {
  isAppWorkerRunning,
  retainAppWorker,
  runAppWorkerTask,
} from './app-worker-client';

const log = createLogger('PlaylistCacheWorker');
let nextSessionId = 1;
let nextWriteId = 1;
let scheduledPlaylist: {
  channels: Channel[];
  epgSources: EpgSource[];
  timestamp: number;
  sourceSignature: string;
} | null = null;
let playlistFrame: number | null = null;
let playlistTimer: ReturnType<typeof setTimeout> | null = null;
let drainPromise: Promise<void> | null = null;

export interface PlaylistCacheWriteMetrics {
  durationMs: number;
  batchSize: number;
  batches: number;
  channels: number;
}

export async function runPlaylistCacheWorker(
  channels: Channel[],
  epgSources: EpgSource[] = [],
  timestamp = Date.now(),
  sourceSignature = playlistSourceSignature(),
): Promise<PlaylistCacheWriteMetrics> {
  if (!channels.length) throw new Error('Playlist cache write requires channels');
  const sessionId = nextSessionId++;
  const writeId = `${timestamp.toString(36)}-${String(nextWriteId++)}`;
  const started = performance.now();
  const releaseWorker = retainAppWorker();
  let sessionStarted = false;
  try {
    await runAppWorkerTask('playlist-cache.start', {
      sessionId,
      writeId,
      sourceSignature,
      epgSources,
      timestamp,
      channelCount: channels.length,
    }, { timeoutMs: CONFIG.M3U.PARSE_TIMEOUT_MS });
    sessionStarted = true;
    let batches = 0;
    for (let index = 0; index < channels.length; index += CONFIG.M3U.RESULT_BATCH_SIZE) {
      await runAppWorkerTask('playlist-cache.add', {
        sessionId,
        channels: channels.slice(index, index + CONFIG.M3U.RESULT_BATCH_SIZE),
      }, { timeoutMs: CONFIG.M3U.PARSE_TIMEOUT_MS });
      batches++;
    }
    await runAppWorkerTask(
      'playlist-cache.finish',
      { sessionId },
      { timeoutMs: CONFIG.M3U.PARSE_TIMEOUT_MS },
    );
    return {
      durationMs: performance.now() - started,
      batchSize: CONFIG.M3U.RESULT_BATCH_SIZE,
      batches,
      channels: channels.length,
    };
  } catch (error) {
    if (sessionStarted && isAppWorkerRunning()) {
      try {
        await runAppWorkerTask(
          'playlist-cache.abort',
          { sessionId },
          { timeoutMs: CONFIG.M3U.PARSE_TIMEOUT_MS },
        );
      } catch {
        // The original persistence failure is the actionable error.
      }
    }
    throw error;
  } finally {
    releaseWorker();
  }
}

export async function persistCachedPlaylistOffThread(
  channels: Channel[],
  epgSources: EpgSource[] = [],
  timestamp = Date.now(),
  sourceSignature = playlistSourceSignature(),
): Promise<boolean> {
  if (!channels.length) return false;
  if (typeof Worker !== 'undefined') {
    try {
      const metrics = await runPlaylistCacheWorker(
        channels,
        epgSources,
        timestamp,
        sourceSignature,
      );
      log.info(
        'Playlist cache write completed',
        'event=playlist.cache.worker.completed',
        `channels=${String(metrics.channels)}`,
        `batches=${String(metrics.batches)}`,
        `batchSize=${String(metrics.batchSize)}`,
        `durationMs=${metrics.durationMs.toFixed(1)}`,
      );
      return true;
    } catch (error) {
      log.warn(
        'Worker cache write unavailable; using main-thread fallback',
        'event=playlist.cache.worker.fallback.used',
        error,
      );
    }
  }
  return setCachedPlaylist(channels, epgSources, timestamp, sourceSignature);
}

function cancelPlaylistSchedule(): void {
  if (playlistFrame !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(playlistFrame);
  }
  if (playlistTimer !== null) clearTimeout(playlistTimer);
  playlistFrame = null;
  playlistTimer = null;
}

function startPlaylistDrain(): void {
  cancelPlaylistSchedule();
  if (drainPromise) return;
  drainPromise = (async () => {
    while (scheduledPlaylist) {
      const pending = scheduledPlaylist;
      scheduledPlaylist = null;
      const stored = await persistCachedPlaylistOffThread(
        pending.channels,
        pending.epgSources,
        pending.timestamp,
        pending.sourceSignature,
      );
      if (!stored) {
        log.warn(
          'Playlist cache write was not accepted',
          'event=playlist.cache.write.skipped',
          'operation=write',
        );
      }
    }
  })().catch(error => log.error(
    'Playlist cache write failed',
    'event=playlist.cache.write.failed',
    'operation=write',
    error,
  )).then(() => {
    drainPromise = null;
    if (scheduledPlaylist) startPlaylistDrain();
  });
}

export function scheduleCachedPlaylistOffThread(
  channels: Channel[],
  epgSources: EpgSource[] = [],
  timestamp = Date.now(),
): void {
  if (!channels.length) return;
  scheduledPlaylist = {
    channels,
    epgSources,
    timestamp,
    sourceSignature: playlistSourceSignature(),
  };
  if (drainPromise) return;
  cancelPlaylistSchedule();
  if (typeof requestAnimationFrame === 'function') {
    playlistFrame = requestAnimationFrame(() => {
      playlistFrame = requestAnimationFrame(startPlaylistDrain);
    });
  } else {
    playlistTimer = setTimeout(startPlaylistDrain, 0);
  }
}

export async function flushPlaylistCacheWrites(): Promise<void> {
  if (scheduledPlaylist) startPlaylistDrain();
  while (drainPromise) await drainPromise;
}
