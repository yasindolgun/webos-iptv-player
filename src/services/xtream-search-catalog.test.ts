import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaylistEntry, SeriesItem, VodItem } from '../types';

const { cache, catalogMock, cacheMock } = vi.hoisted(() => ({
  cache: new Map<string, { key: string; timestamp: number; data: unknown }>(),
  catalogMock: {
    loadAllVodStreams: vi.fn(),
    loadAllSeries: vi.fn(),
  },
  cacheMock: {
    getCachedCatalog: vi.fn(async (key: string) => cache.get(key) ?? null),
    setCachedCatalog: vi.fn(async (key: string, data: unknown) => {
      cache.set(key, { key, timestamp: Date.now(), data });
      return true;
    }),
  },
}));

vi.mock('./idb-cache', () => cacheMock);
vi.mock('./xtream-catalog', () => ({
  ...catalogMock,
  xtreamCatalogCacheKey: (
    entry: PlaylistEntry,
    resource: string,
    parameter?: string,
  ) => `${entry.id}|signature|${resource}${parameter === undefined ? '' : `|${parameter}`}`,
}));

import {
  hydrateXtreamSearchCatalog,
  loadXtreamSearchCatalog,
} from './xtream-search-catalog';

const account: PlaylistEntry = {
  id: 'x1',
  name: 'X',
  url: 'http://host/a',
  source: 'xtream',
  xtream: { username: 'u', password: 'p' },
};

const movie = (index: number): VodItem => ({
  accountId: account.id,
  streamId: `m${String(index)}`,
  name: `Movie ${String(index)}`,
  poster: `http://host/m${String(index)}.jpg`,
  rating: '',
  categoryId: '1',
  containerExtension: 'mp4',
});

const series = (index: number): SeriesItem => ({
  accountId: account.id,
  seriesId: `s${String(index)}`,
  name: `Series ${String(index)}`,
  poster: `http://host/s${String(index)}.jpg`,
  rating: '',
  categoryId: '1',
});

beforeEach(() => {
  cache.clear();
  vi.clearAllMocks();
  catalogMock.loadAllVodStreams.mockResolvedValue([]);
  catalogMock.loadAllSeries.mockResolvedValue([]);
});

describe('Xtream Search catalog', () => {
  it('partitions full records and hydrates only requested blocks', async () => {
    const movies = Array.from({ length: 1_201 }, (_, index) => movie(index));
    catalogMock.loadAllVodStreams.mockResolvedValue(movies);
    catalogMock.loadAllSeries.mockResolvedValue([series(0)]);

    const catalog = await loadXtreamSearchCatalog(account);

    expect(catalog.movies.documents).toHaveLength(1_201);
    expect(catalog.movies.documents[0]).toEqual({ id: 'm0', name: 'Movie 0', block: 0 });
    expect([...cache.keys()].filter(key => key.includes('search_movies_block')))
      .toHaveLength(3);

    cacheMock.getCachedCatalog.mockClear();
    const hydrated = await hydrateXtreamSearchCatalog(
      catalog,
      ['m0', 'm501', 'm1200'],
      ['s0'],
    );

    expect(hydrated.movies.map(item => item.streamId)).toEqual(['m0', 'm501', 'm1200']);
    expect(hydrated.series.map(item => item.seriesId)).toEqual(['s0']);
    expect(cacheMock.getCachedCatalog).toHaveBeenCalledTimes(4);
  });

  it('reuses a fresh compact manifest without loading full catalogs again', async () => {
    catalogMock.loadAllVodStreams.mockResolvedValue([movie(0)]);
    catalogMock.loadAllSeries.mockResolvedValue([series(0)]);
    await loadXtreamSearchCatalog(account);
    catalogMock.loadAllVodStreams.mockClear();
    catalogMock.loadAllSeries.mockClear();

    const catalog = await loadXtreamSearchCatalog(account);

    expect(catalog.movies.documents).toEqual([{ id: 'm0', name: 'Movie 0', block: 0 }]);
    expect(catalogMock.loadAllVodStreams).not.toHaveBeenCalled();
    expect(catalogMock.loadAllSeries).not.toHaveBeenCalled();
  });

  it('keeps a successful partition searchable when its peer fails', async () => {
    catalogMock.loadAllVodStreams.mockResolvedValue([movie(0)]);
    catalogMock.loadAllSeries.mockRejectedValue(new Error('failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const catalog = await loadXtreamSearchCatalog(account);

    expect(catalog.movies.documents).toHaveLength(1);
    expect(catalog.series.documents).toEqual([]);
  });
});
