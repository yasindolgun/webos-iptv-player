import { describe, expect, it } from 'vitest';
import { channelContentKind, m3uContentKind, normalizeChannelContentKind } from './m3u-content-kind';
import type { Channel } from '../types';

describe('m3uContentKind', () => {
  it('recognizes movie groups across common M3U labels', () => {
    expect(m3uContentKind('Movies')).toBe('movie');
    expect(m3uContentKind('Películas')).toBe('movie');
    expect(m3uContentKind('Sinema')).toBe('movie');
  });

  it('recognizes series groups across common M3U labels', () => {
    expect(m3uContentKind('Series Drama')).toBe('series');
    expect(m3uContentKind('Diziler')).toBe('series');
    expect(m3uContentKind('DİZİLER')).toBe('series');
    expect(m3uContentKind('DI\u0307ZI\u0307LER')).toBe('series');
    expect(m3uContentKind('Serien')).toBe('series');
  });

  it('keeps an unrecognized group in the live catalog', () => {
    expect(m3uContentKind('News HD')).toBe('live');
  });

  it('does not surface restricted groups in live, movie, or series catalogs', () => {
    expect(m3uContentKind('Adult')).toBe('other');
    expect(m3uContentKind('YETİŞKİN')).toBe('other');
  });
});

describe('channelContentKind', () => {
  const channel = (overrides: Partial<Channel>): Channel => ({
    id: 'ch1', name: 'Alpha Part 1', group: 'Series', url: 'http://host/a',
    logo: '', extras: null, playlistIds: ['m1'], catchup: '', catchupSource: '',
    catchupDays: 0, ...overrides,
  });

  it.each([
    ['extensionless episode', {}, 'series'],
    ['HLS without live evidence', { url: 'http://host/a.m3u8' }, 'series'],
    ['transport stream without live evidence', { url: 'http://host/a.ts' }, 'series'],
    ['continuous title', { name: 'Alpha 24/7' }, 'live'],
    ['continuous title with HLS', { name: 'Alpha 24/7', url: 'http://host/a.m3u8' }, 'live'],
    ['episode title beats continuous hint', { name: 'Alpha 24/7 S01E01' }, 'series'],
    ['VOD container beats continuous hint', { name: 'Alpha 24/7', url: 'http://host/a.mp4' }, 'series'],
    ['query container', { name: 'Alpha 24/7', url: 'http://host/a?extension=mkv' }, 'series'],
    ['query container alias', { name: 'Alpha 24/7', url: 'http://host/a?output_format=MP4' }, 'series'],
    ['root live route beats episode name', { name: 'Alpha S01E01', url: 'http://host/live/u/p/1.ts' }, 'live'],
    ['nested live route', { url: 'http://host/service/live/u/p/1' }, 'live'],
    ['nested episode route', { name: 'Alpha 24/7', url: 'http://host/service/series/u/p/1' }, 'series'],
    ['movie route', { url: 'http://host/movie/u/p/1.m3u8' }, 'movie'],
    ['incidental directory', { url: 'http://host/a/live/b.m3u8' }, 'series'],
    ['query text is not a route', { url: 'http://host/a?next=/live/u/p/1' }, 'series'],
    ['malformed URL is not live evidence', { url: 'invalid' }, 'series'],
    ['API type overrides direct source', { contentKind: 'live', contentKindSource: 'xtream-live', url: 'http://host/series/u/p/1.mp4' }, 'live'],
    ['restricted group stays separate', { group: 'Adult', url: 'http://host/live/u/p/1' }, 'other'],
    ['unlabelled file', { group: 'Group', url: 'http://host/a.mp4' }, 'movie'],
    ['unlabelled episode', { group: 'Group', name: 'Alpha 1x02' }, 'series'],
    ['unlabelled unknown keeps legacy default', { group: 'Group' }, 'live'],
  ] as Array<[string, Partial<Channel>, string]>)('%s', (_label, overrides, expected) => {
    const input = channel(overrides);
    const before = JSON.stringify(input);
    expect(channelContentKind(input)).toBe(expected);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('normalizes a copy and keeps source naming ahead of customization', () => {
    const input = channel({ name: 'Alpha 24/7', sourceName: 'Alpha Part 1', contentKind: 'series' });
    expect(normalizeChannelContentKind(input)).toBe(input);
    const legacy = channel({ url: 'http://host/live/u/p/1', contentKind: 'series' });
    expect(normalizeChannelContentKind(legacy)).toMatchObject({ contentKind: 'live' });
    expect(legacy.contentKind).toBe('series');
  });
});
