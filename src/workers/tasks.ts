import type {
  Channel,
  EpgSource,
  ParsedEpg,
  ParsedPlaylist,
  PlaylistEntry,
  SeriesItem,
  VodItem,
} from '../types';
import type { XMLTVParseStats } from '../parsers/xmltv-parser';
import type {
  PlaylistIndexDocument,
  PlaylistIndexPlan,
} from './playlist-index';

export interface XMLTVWorkerRequest {
  url: string;
  timeout: number;
  options: {
    nowMs?: number;
    channelIds?: string[];
    channelNames?: string[];
    retainChannelCatalog?: boolean;
  };
}

export interface XMLTVWorkerResponse {
  data: ParsedEpg;
  stats: XMLTVParseStats;
  metrics: {
    transport: 'stream' | 'array_buffer';
    encoding: 'gzip' | 'plain';
    attempts: number;
    inputBytes: number;
    chunks: number;
    elapsedMs: number;
  };
}

export interface SearchIndexRequest {
  sessionId: number;
  reset?: boolean;
  channels?: string[][];
  programmes?: string[][];
}

export interface SearchIndexResponse {
  accepted: boolean;
}

export interface SearchQueryRequest {
  sessionId: number;
  query: string;
  limit: number;
  includeCatalog: boolean;
}

export interface SearchRankedIndices {
  indices: number[];
  hasMore: boolean;
}

export interface SearchCatalogDocument {
  id: string;
  name: string;
}

export interface SearchRankedDocuments {
  documents: SearchCatalogDocument[];
  hasMore: boolean;
}

export interface SearchCatalogLoadRequest {
  sessionId: number;
  account: PlaylistEntry;
}

export interface SearchCatalogLoadResponse {
  accepted: boolean;
  movieCount: number;
  seriesCount: number;
}

export interface SearchCatalogHydrateRequest {
  sessionId: number;
  movieIds: string[];
  seriesIds: string[];
}

export interface SearchCatalogHydrateResponse {
  movies: VodItem[];
  series: SeriesItem[];
}

export interface SearchCatalogReleaseRequest {
  sessionId: number;
}

export interface SearchQueryResponse {
  channels: SearchRankedIndices;
  programmes: SearchRankedIndices;
  movies: SearchRankedDocuments;
  series: SearchRankedDocuments;
}

export interface ListSearchIndexRequest {
  owner: string;
  sessionId: number;
  mode: 'fields' | 'names';
  documents: string[][];
}

export interface ListSearchQueryRequest {
  owner: string;
  sessionId: number;
  query: string;
  limit?: number;
}

export interface M3UParseWorkerRequest {
  buffer: ArrayBuffer;
  sourceUrl: string;
  sentAtEpochMs: number;
  sessionId: number;
}

export interface M3UParseWorkerResponse {
  data: Omit<ParsedPlaylist, 'channels'>;
  channelCount: number;
  metrics: {
    inputBytes: number;
    inputTransferMs: number;
    parseMs: number;
    completedAtEpochMs: number;
  };
}

export interface M3UParseBatchRequest {
  sessionId: number;
}

export interface M3UParseBatchResponse {
  channels: Channel[];
  done: boolean;
}

export interface PlaylistIndexStartRequest {
  sessionId: number;
  channelCount: number;
  customGroups: Array<{ key: string; label: string }>;
}

export interface PlaylistIndexAddRequest {
  sessionId: number;
  documents: PlaylistIndexDocument[];
}

export interface PlaylistIndexSessionRequest {
  sessionId: number;
}

export interface PlaylistCacheStartRequest {
  sessionId: number;
  writeId: string;
  sourceSignature: string;
  epgSources: EpgSource[];
  timestamp: number;
  channelCount: number;
}

export interface PlaylistCacheAddRequest {
  sessionId: number;
  channels: Channel[];
}

export interface PlaylistCacheSessionRequest {
  sessionId: number;
}

export interface ScopedSearchReleaseRequest {
  owner: string;
  sessionId: number;
}

export interface MappingSearchDocument {
  id: string;
  channelId: string;
  name: string;
  fields: string[];
  sourceIndex: number;
}

export interface MappingSearchIndexRequest {
  owner: string;
  sessionId: number;
  documents: MappingSearchDocument[];
}

export interface MappingSearchQueryRequest {
  owner: string;
  sessionId: number;
  query: string;
  selectedId: string;
}

export interface AppWorkerTasks {
  'm3u.parse': {
    request: M3UParseWorkerRequest;
    response: M3UParseWorkerResponse;
  };
  'm3u.parse.next': {
    request: M3UParseBatchRequest;
    response: M3UParseBatchResponse;
  };
  'playlist-index.start': {
    request: PlaylistIndexStartRequest;
    response: { accepted: boolean };
  };
  'playlist-index.add': {
    request: PlaylistIndexAddRequest;
    response: { accepted: boolean };
  };
  'playlist-index.finish': {
    request: PlaylistIndexSessionRequest;
    response: PlaylistIndexPlan;
  };
  'playlist-cache.start': {
    request: PlaylistCacheStartRequest;
    response: { accepted: boolean };
  };
  'playlist-cache.add': {
    request: PlaylistCacheAddRequest;
    response: { accepted: boolean };
  };
  'playlist-cache.finish': {
    request: PlaylistCacheSessionRequest;
    response: { accepted: boolean };
  };
  'playlist-cache.abort': {
    request: PlaylistCacheSessionRequest;
    response: { accepted: boolean };
  };
  'xmltv.load': {
    request: XMLTVWorkerRequest;
    response: XMLTVWorkerResponse;
  };
  'search.index': {
    request: SearchIndexRequest;
    response: SearchIndexResponse;
  };
  'search.query': {
    request: SearchQueryRequest;
    response: SearchQueryResponse | null;
  };
  'search.catalog.load': {
    request: SearchCatalogLoadRequest;
    response: SearchCatalogLoadResponse;
  };
  'search.catalog.hydrate': {
    request: SearchCatalogHydrateRequest;
    response: SearchCatalogHydrateResponse;
  };
  'search.catalog.release': {
    request: SearchCatalogReleaseRequest;
    response: SearchIndexResponse;
  };
  'list-search.index': {
    request: ListSearchIndexRequest;
    response: SearchIndexResponse;
  };
  'list-search.query': {
    request: ListSearchQueryRequest;
    response: SearchRankedIndices | null;
  };
  'list-search.release': {
    request: ScopedSearchReleaseRequest;
    response: SearchIndexResponse;
  };
  'mapping-search.index': {
    request: MappingSearchIndexRequest;
    response: SearchIndexResponse;
  };
  'mapping-search.query': {
    request: MappingSearchQueryRequest;
    response: SearchRankedIndices | null;
  };
  'mapping-search.release': {
    request: ScopedSearchReleaseRequest;
    response: SearchIndexResponse;
  };
}
