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
  return VOD_EXTENSIONS.has(extFromUrl(url));
}

// A continuous 24/7 series stream is delivered as a live broadcast rather
// than a discrete VOD episode file (no VOD container extension, no /movie/ or
// /series/ route, and no season/episode designation in the title).
export function is247SeriesStream(name: string, url: string): boolean {
  if (isVodUrl(url)) return false;
  try {
    const firstPathPart = new URL(url).pathname.split('/').filter(Boolean)[0]?.toLowerCase();
    if (firstPathPart === 'movie' || firstPathPart === 'series') return false;
  } catch {}
  return parseM3uSeriesEpisodeName(name) === null;
}
