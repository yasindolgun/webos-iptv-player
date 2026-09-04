import { foldDiacritics, splitLetterNumberTokens } from './unicode-text';
import type { Channel } from '../types';
import { is247SeriesStream, isVodUrl, parseM3uSeriesEpisodeName, streamContentRoute } from './m3u-episode';

export type M3uContentKind = NonNullable<Channel['contentKind']>;

const MOVIE_TOKENS = [
  'movie', 'movies', 'film', 'films', 'cinema', 'cine', 'kino', 'pelicula',
  'filme', 'sinema', 'vod', 'aflam', 'фильм', 'кино', '电影',
];
const SERIES_TOKENS = [
  'series', 'serie', 'serien', 'serial', 'show', 'shows', 'sitcom', 'episode',
  'episodes', 'dizi', 'novela', 'сериал', 'مسلسل', '电视剧',
];
const OTHER_TOKENS = [
  'adult', 'xxx', 'porn', 'erotic', 'erotik', 'yetiskin', 'взросл', 'للكبار',
  'بالغ', '成人',
];

function fold(value: string): string[] {
  return splitLetterNumberTokens(foldDiacritics(value));
}

function hasToken(tokens: string[], wanted: readonly string[]): boolean {
  return tokens.some(token => wanted.some(word => token === word || token.startsWith(word)));
}

// Unknown groups stay live until a later catalog pass can classify them safely.
export function m3uContentKind(group: string): M3uContentKind {
  const tokens = fold(group);
  if (hasToken(tokens, OTHER_TOKENS)) return 'other';
  if (hasToken(tokens, SERIES_TOKENS)) return 'series';
  if (hasToken(tokens, MOVIE_TOKENS)) return 'movie';
  return 'live';
}

export function channelContentKind(channel: Channel): M3uContentKind {
  const kind = channel.contentKind ?? m3uContentKind(channel.sourceGroup ?? channel.group);
  if (kind === 'other') return kind;
  if (channel.contentKindSource === 'xtream-live') return 'live';
  const route = streamContentRoute(channel.url);
  if (route) return route;
  const name = channel.sourceName ?? channel.name;
  if (parseM3uSeriesEpisodeName(name) && kind !== 'movie') return 'series';
  if (isVodUrl(channel.url)) return kind === 'series' ? 'series' : 'movie';
  if (kind === 'series' && is247SeriesStream(name, channel.url)) return 'live';
  return kind;
}

export function normalizeChannelContentKind(channel: Channel): Channel {
  const contentKind = channelContentKind(channel);
  return contentKind === channel.contentKind ? channel : { ...channel, contentKind };
}

