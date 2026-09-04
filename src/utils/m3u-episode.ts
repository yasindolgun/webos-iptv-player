import { extFromUrl } from './url';

export interface ParsedEpisodeName {
  series: string;
  season: number;
  episode: number;
  title: string;
}

const SEASON_EPISODE = /^(.*?)\s*(?:[._ -]+)?s(?:eason)?\s*(\d{1,2})\s*(?:[._ -]+)?e(?:pisode)?\s*(\d{1,3})(?:\s*(?:[-._ ]+)(.*))?$/i;
const X_EPISODE = /^(.*?)\s*(?:[._ -]+)?(\d{1,2})x(\d{1,3})(?:\s*(?:[-._ ]+)(.*))?$/i;
const VOD_EXTENSIONS = new Set(['mp4', 'm4v', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv']);

export function parseM3uSeriesEpisodeName(name: string): ParsedEpisodeName | null {
  const match = SEASON_EPISODE.exec(name) ?? X_EPISODE.exec(name);
  if (!match) return null;
  const series = match[1].replace(/[._ -]+$/, '').trim();
  const season = parseInt(match[2], 10);
  const episode = parseInt(match[3], 10);
  if (!series || season < 1 || episode < 1) return null;
  return { series, season, episode, title: (match[4] ?? '').trim() };
}

export function isVodUrl(url: string): boolean {
  if (VOD_EXTENSIONS.has(extFromUrl(url))) return true;
  try {
    const params = new URL(url).searchParams;
    return ['extension', 'output', 'output_format'].some(key =>
      VOD_EXTENSIONS.has((params.get(key) ?? '').toLowerCase()));
  } catch {
    return false;
  }
}

export function streamContentRoute(url: string): 'live' | 'movie' | 'series' | null {
  try {
    const path = new URL(url).pathname;
    const match = /^\/(live|movie|series)\//i.exec(path)
      ?? /\/(live|movie|series)\/[^/]+\/[^/]+\/[^/]+\/?$/i.exec(path);
    return match ? match[1].toLowerCase() as 'live' | 'movie' | 'series' : null;
  } catch {
    return null;
  }
}

export function is247SeriesStream(name: string, url: string): boolean {
  const route = streamContentRoute(url);
  if (route) return route === 'live';
  if (isVodUrl(url)) return false;
  return /\b24\s*[\/-]\s*7\b/.test(name) && parseM3uSeriesEpisodeName(name) === null;
}
