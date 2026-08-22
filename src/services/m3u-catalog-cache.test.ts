// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Channel, PlaylistEntry } from '../types';
import { clearAllCachedData } from './idb-cache';
import {
  getCachedM3uCatalog,
  m3uSourceSignature,
  setCachedM3uCatalog,
} from './m3u-catalog-cache';

const source = (): PlaylistEntry => ({ id: 'p1', name: 'Source', url: 'http://host/list.m3u' });
const channel = (name: string, group: string): Channel => ({
  id: name,
  name,
  logo: '',
  group,
  url: `http://host/${name}`,
  extras: null,
  playlistIds: ['p1'],
  catchup: '',
  catchupSource: '',
  catchupDays: 0,
});

describe('m3u-catalog-cache', () => {
  beforeEach(async () => {
    await clearAllCachedData();
  });

  it('stores each content type separately', async () => {
    const channels = [
      channel('Channel One', 'News'),
      channel('Film One', 'Films'),
      channel('Series One', 'Series'),
    ];

    await setCachedM3uCatalog(source(), 'movie', channels);
    await setCachedM3uCatalog(source(), 'series', channels);

    expect((await getCachedM3uCatalog(source(), 'movie'))?.map(item => item.name))
      .toEqual(['Film One']);
    expect((await getCachedM3uCatalog(source(), 'movie'))?.[0].playlistIds).toEqual(['p1']);
    expect((await getCachedM3uCatalog(source(), 'series'))?.map(item => item.name))
      .toEqual(['Series One']);
    expect(await getCachedM3uCatalog(source(), 'live')).toBeNull();
  });

  it('does not use a catalog after its source changes', async () => {
    await setCachedM3uCatalog(source(), 'movie', [channel('Film One', 'Films')]);
    const changed = { ...source(), url: 'http://host/other.m3u' };

    expect(await getCachedM3uCatalog(changed, 'movie')).toBeNull();
  });

  it('derives a stable signature from the source kind and URL', () => {
    expect(m3uSourceSignature(source())).toBe('url\nhttp://host/list.m3u');
    expect(m3uSourceSignature({ ...source(), source: 'upload' }))
      .toBe('upload\nhttp://host/list.m3u');
  });
});
