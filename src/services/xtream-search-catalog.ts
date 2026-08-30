import { CONFIG } from '../config';
import type { PlaylistEntry, SeriesItem, VodItem } from '../types';
import type { SearchCatalogDocument } from '../workers/tasks';
import { createLogger } from '../utils/logger';
import { getCachedCatalog, setCachedCatalog } from './idb-cache';
import {
  loadAllSeries,
  loadAllVodStreams,
  xtreamCatalogCacheKey,
} from './xtream-catalog';

const MANIFEST_VERSION = 1;
const log = createLogger('SearchCatalog');

type CatalogKind = 'movies' | 'series';
type CatalogItem = VodItem | SeriesItem;

interface SearchCatalogManifest {
  version: number;
  generation: string;
  documents: Array<SearchCatalogDocument & { block: number }>;
}

interface SearchCatalogPartition<T extends CatalogItem> {
  account: PlaylistEntry;
  kind: CatalogKind;
  generation: string;
  documents: Array<SearchCatalogDocument & { block: number }>;
  blockById: Map<string, number>;
  itemGuard: (item: CatalogItem) => item is T;
}

export interface XtreamSearchCatalog {
  movies: SearchCatalogPartition<VodItem>;
  series: SearchCatalogPartition<SeriesItem>;
}

export async function loadXtreamSearchCatalog(
  account: PlaylistEntry,
  signal?: AbortSignal,
): Promise<XtreamSearchCatalog> {
  const movies = await loadPartitionSafely(
    account,
    'movies',
    signal,
    () => loadAllVodStreams(account, signal),
    isVodItem,
  );
  ensureActive(signal);
  const series = await loadPartitionSafely(
    account,
    'series',
    signal,
    () => loadAllSeries(account, signal),
    isSeriesItem,
  );
  return { movies, series };
}

async function loadPartitionSafely<T extends CatalogItem>(
  account: PlaylistEntry,
  kind: CatalogKind,
  signal: AbortSignal | undefined,
  load: () => Promise<T[]>,
  itemGuard: (item: CatalogItem) => item is T,
): Promise<SearchCatalogPartition<T>> {
  try {
    return await loadPartition(account, kind, signal, load, itemGuard);
  } catch (error) {
    ensureActive(signal);
    log.error(
      'Search catalog partition load failed',
      'event=xtream.search.load.failed',
      `resource=${kind}`,
      error,
    );
    return partition(account, kind, {
      version: MANIFEST_VERSION,
      generation: '',
      documents: [],
    }, itemGuard);
  }
}

export async function hydrateXtreamSearchCatalog(
  catalog: XtreamSearchCatalog,
  movieIds: string[],
  seriesIds: string[],
): Promise<{ movies: VodItem[]; series: SeriesItem[] }> {
  const movies = await hydratePartition(catalog.movies, movieIds);
  const series = await hydratePartition(catalog.series, seriesIds);
  return { movies, series };
}

async function loadPartition<T extends CatalogItem>(
  account: PlaylistEntry,
  kind: CatalogKind,
  signal: AbortSignal | undefined,
  load: () => Promise<T[]>,
  itemGuard: (item: CatalogItem) => item is T,
): Promise<SearchCatalogPartition<T>> {
  const cached = await getCachedCatalog<SearchCatalogManifest>(manifestKey(account, kind));
  ensureActive(signal);
  if (cached && isFresh(cached.timestamp) && validManifest(cached.data)) {
    return partition(account, kind, cached.data, itemGuard);
  }

  try {
    const items = await load();
    ensureActive(signal);
    const manifest = await persistPartition(account, kind, items);
    return partition(account, kind, manifest, itemGuard);
  } catch (error) {
    if (cached && validManifest(cached.data)) {
      return partition(account, kind, cached.data, itemGuard);
    }
    throw error;
  }
}

async function persistPartition<T extends CatalogItem>(
  account: PlaylistEntry,
  kind: CatalogKind,
  items: T[],
): Promise<SearchCatalogManifest> {
  const generation = `${String(Date.now())}-${String(Math.floor(Math.random() * 0x1000000))}`;
  const documents: Array<SearchCatalogDocument & { block: number }> = [];
  const blockSize = CONFIG.XTREAM.SEARCH_CATALOG_BLOCK_SIZE;
  for (let start = 0; start < items.length; start += blockSize) {
    const block = Math.floor(start / blockSize);
    const records = items.slice(start, start + blockSize);
    const stored = await setCachedCatalog(blockKey(account, kind, generation, block), records);
    if (!stored) throw new Error('Search catalog block was not accepted');
    for (const item of records) {
      documents.push({ id: itemId(item), name: item.name, block });
    }
  }
  const manifest = { version: MANIFEST_VERSION, generation, documents };
  const stored = await setCachedCatalog(manifestKey(account, kind), manifest);
  if (!stored) throw new Error('Search catalog manifest was not accepted');
  return manifest;
}

function partition<T extends CatalogItem>(
  account: PlaylistEntry,
  kind: CatalogKind,
  manifest: SearchCatalogManifest,
  itemGuard: (item: CatalogItem) => item is T,
): SearchCatalogPartition<T> {
  const blockById = new Map<string, number>();
  for (const document of manifest.documents) blockById.set(document.id, document.block);
  return {
    account,
    kind,
    generation: manifest.generation,
    documents: manifest.documents,
    blockById,
    itemGuard,
  };
}

async function hydratePartition<T extends CatalogItem>(
  catalog: SearchCatalogPartition<T>,
  ids: string[],
): Promise<T[]> {
  const requested = new Set(ids);
  const blocks = new Set<number>();
  for (const id of ids) {
    const block = catalog.blockById.get(id);
    if (block !== undefined) blocks.add(block);
  }
  const byId = new Map<string, T>();
  for (const block of blocks) {
    const cached = await getCachedCatalog<CatalogItem[]>(blockKey(
      catalog.account,
      catalog.kind,
      catalog.generation,
      block,
    ));
    if (!cached) continue;
    for (const item of cached.data) {
      const id = itemId(item);
      if (requested.has(id) && catalog.itemGuard(item)) byId.set(id, item);
    }
  }
  const hydrated: T[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item) hydrated.push(item);
  }
  return hydrated;
}

function manifestKey(account: PlaylistEntry, kind: CatalogKind): string {
  return xtreamCatalogCacheKey(account, `search_${kind}_manifest`);
}

function blockKey(
  account: PlaylistEntry,
  kind: CatalogKind,
  generation: string,
  block: number,
): string {
  return xtreamCatalogCacheKey(account, `search_${kind}_block`, `${generation}:${String(block)}`);
}

function validManifest(value: SearchCatalogManifest): boolean {
  return value?.version === MANIFEST_VERSION
    && typeof value.generation === 'string'
    && Array.isArray(value.documents);
}

function isFresh(timestamp: number): boolean {
  return Date.now() - timestamp < CONFIG.XTREAM.CATALOG_TTL_MS;
}

function ensureActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Search catalog load was cancelled');
}

function itemId(item: CatalogItem): string {
  return 'streamId' in item ? item.streamId : item.seriesId;
}

function isVodItem(item: CatalogItem): item is VodItem {
  return 'streamId' in item;
}

function isSeriesItem(item: CatalogItem): item is SeriesItem {
  return 'seriesId' in item;
}
