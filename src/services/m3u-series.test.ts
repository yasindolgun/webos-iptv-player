import { describe, expect, it, vi } from 'vitest';
import type { Channel } from '../types';
import {
  is247SeriesStream,
  m3uSeriesCatalog,
  m3uSeriesCatalogInFrames,
  parseM3uSeriesEpisodeName,
} from './m3u-series';

function channel(id: string, name: string): Channel {
  return {
    id, name, logo: '', group: 'Series', sourceGroup: 'Series', url: `http://host/${id}`,
    extras: null, playlistIds: ['p1'], catchup: '', catchupSource: '', catchupDays: 0,
    contentKind: 'series',
  };
}

describe('m3uSeriesCatalog', () => {
  it('recognizes common season and episode title patterns', () => {
    expect(parseM3uSeriesEpisodeName('Show One S02E03 - Part')).toEqual({
      series: 'Show One', season: 2, episode: 3, title: 'Part',
    });
    expect(parseM3uSeriesEpisodeName('Show Two 1x04')).toEqual({
      series: 'Show Two', season: 1, episode: 4, title: '',
    });
  });

  it('groups episodes by series and season while preserving unrecognized entries', () => {
    const catalog = m3uSeriesCatalog([
      channel('e3', 'Show One S02E01 - Next'),
      channel('flat', 'Show Without Episode Pattern'),
      channel('e2', 'Show One S01E02 - Second'),
      channel('e1', 'Show One S01E01 - First'),
    ]);

    expect(catalog.series).toHaveLength(1);
    expect(catalog.series[0].seasons).toEqual([1, 2]);
    expect(catalog.series[0].episodesBySeason[1].map(item => item.channel.id))
      .toEqual(['e1', 'e2']);
    expect(catalog.flat.map(item => item.id)).toEqual(['flat']);
  });

  it('builds the same series grouping in frame slices', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    const catalog = await m3uSeriesCatalogInFrames([
      channel('e2', 'Show One S01E02 - Second'),
      channel('e1', 'Show One S01E01 - First'),
    ], () => true);
    vi.unstubAllGlobals();

    expect(catalog?.series[0].episodesBySeason[1].map(item => item.channel.id))
      .toEqual(['e1', 'e2']);
  });

  it('identifies 24/7 series live streams vs VOD episodes', () => {
    expect(is247SeriesStream('Alpha 24/7 Show', 'http://host/play/abc')).toBe(true);
    expect(is247SeriesStream('Alpha Show S01E01', 'http://host/play/abc#.mkv')).toBe(false);
    expect(is247SeriesStream('Alpha Show', 'http://host/series/abc.mp4')).toBe(false);
    expect(is247SeriesStream('Alpha Show 1x02', 'http://host/play/abc')).toBe(false);
  });
});
