import '../polyfills';
import { CONFIG } from '../config';
import { parseM3UBytes } from '../parsers/m3u-parser';
import type { Channel } from '../types';
import { fetchAndParseXMLTVInWorker } from '../parsers/xmltv-loader';
import { exposeWorkerTasks, type WorkerTaskHandlers } from './worker-rpc';
import { SearchWorkerIndex } from './search-index';
import { ScopedSearchIndex } from './scoped-search-index';
import type { AppWorkerTasks } from './tasks';

const searchIndex = new SearchWorkerIndex();
const scopedSearchIndex = new ScopedSearchIndex();
let m3uSession: {
  id: number;
  channels: Array<Channel | null>;
  cursor: number;
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
