import '../polyfills';
import { CONFIG } from '../config';
import {
  parseM3UBytesInBatches,
  parseM3UBytesWithMetrics,
} from '../parsers/m3u-parser';
import type { Channel } from '../types';
import { CachedPlaylistBatchWriter } from '../services/idb-cache';
import { PlaylistParseStage } from '../services/playlist-parse-stage';
import { createLogger } from '../utils/logger';
import {
  hydrateXtreamSearchCatalog,
  loadXtreamSearchCatalog,
  type XtreamSearchCatalog,
} from '../services/xtream-search-catalog';
import { fetchAndParseXMLTVInWorker } from '../parsers/xmltv-loader';
import {
  exposeWorkerTasks,
  withWorkerResponseTransfers,
  type WorkerTaskHandlers,
} from './worker-rpc';
import { SearchWorkerIndex } from './search-index';
import { ScopedSearchIndex } from './scoped-search-index';
import type { AppWorkerTasks } from './tasks';
import {
  PlaylistIndexBuilder,
  playlistIndexTransferables,
} from './playlist-index';

const searchIndex = new SearchWorkerIndex();
const scopedSearchIndex = new ScopedSearchIndex();
const log = createLogger('AppWorker');
let searchCatalogSession: {
  id: number;
  catalog: XtreamSearchCatalog | null;
  controller: AbortController;
} | null = null;
type M3USession = {
  id: number;
  kind: 'memory';
  channels: Array<Channel | null>;
  cursor: number;
} | {
  id: number;
  kind: 'staged';
  exhausted: boolean;
  pending: Channel[][];
  stage: PlaylistParseStage;
};
const m3uSessions = new Map<number, M3USession>();
let playlistIndexSession: {
  id: number;
  builder: PlaylistIndexBuilder;
} | null = null;
let playlistCacheSession: {
  id: number;
  writer: CachedPlaylistBatchWriter;
} | null = null;
const handlers: WorkerTaskHandlers<AppWorkerTasks> = {
  'm3u.parse': async request => {
    const previous = m3uSessions.get(request.sessionId);
    if (previous?.kind === 'staged') await previous.stage.abort();
    m3uSessions.delete(request.sessionId);
    const receivedAtEpochMs = Date.now();
    const started = performance.now();
    const bytes = new Uint8Array(request.buffer);
    let stage: PlaylistParseStage | null = null;
    let stageWriteMs = 0;
    try {
      const activeStage = await PlaylistParseStage.begin(`m3u-${String(request.sessionId)}`);
      stage = activeStage;
      const parsed = await parseM3UBytesInBatches(
        bytes,
        request.sourceUrl,
        async channels => {
          const writeStarted = performance.now();
          await activeStage.add(channels);
          stageWriteMs += performance.now() - writeStarted;
        },
      );
      stage.finish();
      if (parsed.metrics.channelCount) {
        m3uSessions.set(request.sessionId, {
          id: request.sessionId,
          kind: 'staged',
          exhausted: false,
          pending: [],
          stage,
        });
      }
      return {
        data: parsed.data,
        channelCount: parsed.metrics.channelCount,
        metrics: {
          decodeChunkBytes: parsed.metrics.decodeChunkBytes,
          decodeChunks: parsed.metrics.decodeChunks,
          encoding: parsed.metrics.encoding,
          maxDecodedChunkChars: parsed.metrics.maxDecodedChunkChars,
          inputBytes: request.buffer.byteLength,
          inputTransferMs: Math.max(0, receivedAtEpochMs - request.sentAtEpochMs),
          maxBufferedChannels: parsed.metrics.maxBufferedChannels,
          parseMs: Math.max(0, performance.now() - started - stageWriteMs),
          sourceStaging: 'indexeddb' as const,
          stageBatchSize: CONFIG.M3U.RESULT_BATCH_SIZE,
          stageBatches: parsed.metrics.batches,
          stageReadBatches: CONFIG.M3U.RESULT_BATCHES_PER_YIELD,
          stageWriteMs,
          completedAtEpochMs: Date.now(),
        },
      };
    } catch (error) {
      await stage?.abort();
      log.warn(
        'Playlist parse staging unavailable; retaining worker result batches in memory',
        'event=m3u.parse.staging.fallback.used',
        error,
      );
      const parsed = parseM3UBytesWithMetrics(bytes, request.sourceUrl);
      const data = parsed.data;
      const channels: Array<Channel | null> = data.channels;
      const { channels: _channels, ...metadata } = data;
      m3uSessions.set(request.sessionId, {
        id: request.sessionId,
        kind: 'memory',
        channels,
        cursor: 0,
      });
      return {
        data: metadata,
        channelCount: channels.length,
        metrics: {
          ...parsed.metrics,
          inputBytes: request.buffer.byteLength,
          inputTransferMs: Math.max(0, receivedAtEpochMs - request.sentAtEpochMs),
          maxBufferedChannels: channels.length,
          parseMs: performance.now() - started,
          sourceStaging: 'memory' as const,
          stageBatchSize: CONFIG.M3U.RESULT_BATCH_SIZE,
          stageBatches: 0,
          stageReadBatches: 0,
          stageWriteMs,
          completedAtEpochMs: Date.now(),
        },
      };
    }
  },
  'm3u.parse.next': async request => {
    const session = m3uSessions.get(request.sessionId);
    if (!session) {
      throw new Error('M3U parse session is no longer available');
    }
    if (session.kind === 'staged') {
      if (!session.pending.length) {
        const staged = await session.stage.take(CONFIG.M3U.RESULT_BATCHES_PER_YIELD);
        session.pending.push(...staged.batches);
        session.exhausted = staged.done;
      }
      const channels = session.pending.shift() ?? [];
      const done = session.exhausted && !session.pending.length;
      if (done) m3uSessions.delete(request.sessionId);
      return { channels, done };
    }
    const end = Math.min(
      session.cursor + CONFIG.M3U.RESULT_BATCH_SIZE,
      session.channels.length,
    );
    const channels: Channel[] = [];
    for (let index = session.cursor; index < end; index++) {
      const channel = session.channels[index];
      if (channel) channels.push(channel);
      session.channels[index] = null;
    }
    session.cursor = end;
    const done = end >= session.channels.length;
    if (done) m3uSessions.delete(request.sessionId);
    return { channels, done };
  },
  'playlist-index.start': request => {
    playlistIndexSession = {
      id: request.sessionId,
      builder: new PlaylistIndexBuilder(request.customGroups, request.channelCount),
    };
    return { accepted: true };
  },
  'playlist-index.add': request => {
    const session = playlistIndexSession;
    if (!session || session.id !== request.sessionId) {
      throw new Error('Playlist index session is no longer available');
    }
    session.builder.add(request.documents);
    return { accepted: true };
  },
  'playlist-index.finish': request => {
    const session = playlistIndexSession;
    if (!session || session.id !== request.sessionId) {
      throw new Error('Playlist index session is no longer available');
    }
    playlistIndexSession = null;
    const plan = session.builder.finish();
    return withWorkerResponseTransfers(plan, playlistIndexTransferables(plan));
  },
  'playlist-cache.start': async request => {
    if (playlistCacheSession) await playlistCacheSession.writer.abort();
    const writer = await CachedPlaylistBatchWriter.begin({
      writeId: request.writeId,
      sourceSignature: request.sourceSignature,
      epgSources: request.epgSources,
      timestamp: request.timestamp,
      channelCount: request.channelCount,
    });
    playlistCacheSession = { id: request.sessionId, writer };
    return { accepted: true };
  },
  'playlist-cache.add': async request => {
    const session = playlistCacheSession;
    if (!session || session.id !== request.sessionId) {
      throw new Error('Playlist cache session is no longer available');
    }
    await session.writer.add(request.channels);
    return { accepted: true };
  },
  'playlist-cache.finish': async request => {
    const session = playlistCacheSession;
    if (!session || session.id !== request.sessionId) {
      throw new Error('Playlist cache session is no longer available');
    }
    await session.writer.finish();
    playlistCacheSession = null;
    return { accepted: true };
  },
  'playlist-cache.abort': async request => {
    const session = playlistCacheSession;
    if (!session || session.id !== request.sessionId) {
      return { accepted: false };
    }
    playlistCacheSession = null;
    await session.writer.abort();
    return { accepted: true };
  },
  'xmltv.load': request => fetchAndParseXMLTVInWorker(request),
  'search.index': request => searchIndex.index(request),
  'search.query': request => searchIndex.query(request),
  'search.channels.query': request => searchIndex.queryChannels(request),
  'search.catalog.load': async request => {
    searchCatalogSession?.controller.abort();
    const controller = new AbortController();
    const session: NonNullable<typeof searchCatalogSession> = {
      id: request.sessionId,
      catalog: null,
      controller,
    };
    searchCatalogSession = session;
    const catalog = await loadXtreamSearchCatalog(request.account, controller.signal);
    if (searchCatalogSession !== session || controller.signal.aborted) {
      return { accepted: false, movieCount: 0, seriesCount: 0 };
    }
    session.catalog = catalog;
    const indexed = searchIndex.catalog(
      request.sessionId,
      catalog.movies.documents,
      catalog.series.documents,
    );
    return {
      accepted: indexed.accepted,
      movieCount: catalog.movies.documents.length,
      seriesCount: catalog.series.documents.length,
    };
  },
  'search.catalog.hydrate': request => {
    const session = searchCatalogSession;
    if (!session || session.id !== request.sessionId || !session.catalog) {
      return { movies: [], series: [] };
    }
    return hydrateXtreamSearchCatalog(
      session.catalog,
      request.movieIds,
      request.seriesIds,
    );
  },
  'search.catalog.release': request => {
    const session = searchCatalogSession;
    if (!session || session.id !== request.sessionId) return { accepted: false };
    session.controller.abort();
    searchCatalogSession = null;
    return { accepted: true };
  },
  'list-search.index': request => scopedSearchIndex.indexList(request),
  'list-search.query': request => scopedSearchIndex.queryList(request),
  'list-search.release': request => scopedSearchIndex.releaseList(request),
  'mapping-search.index': request => scopedSearchIndex.indexMapping(request),
  'mapping-search.query': request => scopedSearchIndex.queryMapping(request),
  'mapping-search.release': request => scopedSearchIndex.releaseMapping(request),
};

exposeWorkerTasks(
  self as unknown as Parameters<typeof exposeWorkerTasks<AppWorkerTasks>>[0],
  handlers,
);
