import { describe, expect, it } from 'vitest';
import type { PlaylistEntry } from '../types';
import {
  availableCatalogSources,
  catalogSourceKey,
  parseCatalogSource,
  resolveCatalogSource,
  type CatalogSource,
} from './catalog-source';

const playlist = (
  id: string,
  source: PlaylistEntry['source'],
  enabled = true,
): PlaylistEntry => ({
  id,
  name: id,
  url: `http://host/${id}`,
  source,
  enabled,
  xtream: source === 'xtream' ? { username: 'u', password: 'p' } : undefined,
});

describe('catalog sources', () => {
  it('round-trips namespaced source keys', () => {
    const source: CatalogSource = { kind: 'm3u', playlistId: 'p:1' };
    expect(parseCatalogSource(catalogSourceKey(source))).toEqual(source);
    expect(parseCatalogSource('invalid')).toBeNull();
  });

  it('lists enabled Xtream and content-bearing M3U sources in setup order', () => {
    const playlists = [
      playlist('x1', 'xtream'),
      playlist('p1', 'url'),
      playlist('p2', 'upload'),
      playlist('off', 'xtream', false),
    ];
    const counts = new Map([['movie:p1', 2], ['movie:p2', 0]]);

    expect(availableCatalogSources(playlists, 'movies', (kind, id) =>
      counts.get(`${kind}:${id}`) ?? 0)).toEqual([
      { kind: 'xtream', playlistId: 'x1' },
      { kind: 'm3u', playlistId: 'p1' },
    ]);
  });

  it('keeps section selection and falls back from a removed source', () => {
    const available: CatalogSource[] = [
      { kind: 'xtream', playlistId: 'x1' },
      { kind: 'm3u', playlistId: 'p1' },
    ];

    expect(resolveCatalogSource(
      available,
      { kind: 'm3u', playlistId: 'p1' },
      'x1',
    )).toEqual({ kind: 'm3u', playlistId: 'p1' });
    expect(resolveCatalogSource(
      available,
      { kind: 'm3u', playlistId: 'removed' },
      'x1',
    )).toEqual({ kind: 'xtream', playlistId: 'x1' });
  });
});
