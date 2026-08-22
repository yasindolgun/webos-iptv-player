import { describe, expect, it } from 'vitest';
import type { Channel } from '../types';
import { m3uCatalogCategories, m3uCatalogForKind, m3uCatalogItems } from './m3u-catalog';

function channel(name: string, group: string, kind: Channel['contentKind']): Channel {
  return {
    id: name, name, logo: '', group, sourceGroup: group, url: `http://host/${name}`,
    extras: null, playlistIds: ['p1'], catchup: '', catchupSource: '', catchupDays: 0,
    contentKind: kind,
  };
}

describe('m3uCatalog', () => {
  const channels = [
    channel('Film One', 'Films', 'movie'),
    channel('Film Two', 'Films', 'movie'),
    channel('Series One', 'Series', 'series'),
  ];

  it('groups M3U items into stable categories', () => {
    expect(m3uCatalogCategories(channels)).toEqual([
      { id: 'films', name: 'Films', count: 2 },
      { id: 'series', name: 'Series', count: 1 },
    ]);
  });

  it('keeps direct stream URLs for category browsing and playback', () => {
    expect(m3uCatalogItems(channels, 'films').map(item => item.url))
      .toEqual(['http://host/Film One', 'http://host/Film Two']);
    expect(m3uCatalogForKind(channels, 'series').map(item => item.name))
      .toEqual(['Series One']);
  });
});
