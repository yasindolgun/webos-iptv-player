import '../polyfills';
import { CONFIG } from '../config';
import { parseM3UBytes } from '../parsers/m3u-parser';
import type { Channel } from '../types';
import { CachedPlaylistBatchWriter } from '../services/idb-cache';
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
let m3uSession: {
  id: number;
  channels: Array<Channel | null>;
  cursor: number;
} | null = null;
let playlistIndexSession: {
  id: number;
  builder: PlaylistIndexBuilder;
} | null = null;
let playlistCacheSession: {
  id: number;
  writer: CachedPlaylistBatchWriter;
} | null = null;
const handlers: WorkerTaskHandlers<AppWorkerTasks> = {
  'm3u.parse': request => {
    const receivedAtEpochMs = Date.now();
    const started = performance.now();
    const data = parseM3UBytes(
      new Uint8Array(request.buffer),
      request.sourceUrl,
    );
    const channels: Array<Channel | null> = data.channels;
    const { channels: _channels, ...metadata } = data;
    m3uSession = {
      id: request.sessionId,
      channels,
      cursor: 0,
    };
    return {
      data: metadata,
      channelCount: channels.length,
      metrics: {
        inputBytes: request.buffer.byteLength,
        inputTransferMs: Math.max(0, receivedAtEpochMs - request.sentAtEpochMs),
        parseMs: performance.now() - started,
        completedAtEpochMs: Date.now(),
      },
    };
  },
  'm3u.parse.next': request => {
    const session = m3uSession;
    if (!session || session.id !== request.sessionId) {
      throw new Error('M3U parse session is no longer available');
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
    if (done) m3uSession = null;
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
