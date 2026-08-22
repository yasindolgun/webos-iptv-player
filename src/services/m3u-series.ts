import type { Channel } from '../types';
import { m3uCatalogCategoryId } from './m3u-catalog';

export interface M3uSeriesEpisode {
  channel: Channel;
  season: number;
  episode: number;
  title: string;
}

export interface M3uSeries {
  id: string;
  name: string;
  poster: string;
  categoryId: string;
  seasons: number[];
  episodesBySeason: Record<number, M3uSeriesEpisode[]>;
}

export interface M3uSeriesCatalog {
  series: M3uSeries[];
  flat: Channel[];
}

interface ParsedEpisodeName {
  series: string;
  season: number;
  episode: number;
  title: string;
}

const SEASON_EPISODE = /^(.*?)\s*(?:[._ -]+)?s(?:eason)?\s*(\d{1,2})\s*(?:[._ -]+)?e(?:pisode)?\s*(\d{1,3})(?:\s*(?:[-._ ]+)(.*))?$/i;
const X_EPISODE = /^(.*?)\s*(?:[._ -]+)?(\d{1,2})x(\d{1,3})(?:\s*(?:[-._ ]+)(.*))?$/i;

export function parseM3uSeriesEpisodeName(name: string): ParsedEpisodeName | null {
  const match = SEASON_EPISODE.exec(name) ?? X_EPISODE.exec(name);
  if (!match) return null;
  const series = match[1].replace(/[._ -]+$/, '').trim();
  const season = parseInt(match[2], 10);
  const episode = parseInt(match[3], 10);
  if (!series || season < 1 || episode < 1) return null;
  return { series, season, episode, title: (match[4] ?? '').trim() };
}

export function m3uSeriesCatalog(channels: Channel[]): M3uSeriesCatalog {
  const byId = new Map<string, M3uSeries>();
  const flat: Channel[] = [];
  for (const channel of channels) {
    const parsed = parseM3uSeriesEpisodeName(channel.name);
    if (!parsed) {
      flat.push(channel);
      continue;
    }
    const categoryId = m3uCatalogCategoryId(channel);
    const id = `${categoryId}|${parsed.series.toLocaleLowerCase()}`;
    let series = byId.get(id);
    if (!series) {
      series = {
        id,
        name: parsed.series,
        poster: channel.logo,
        categoryId,
        seasons: [],
        episodesBySeason: {},
      };
      byId.set(id, series);
    }
    const episodes = series.episodesBySeason[parsed.season]
      ?? (series.episodesBySeason[parsed.season] = []);
    episodes.push({ channel, season: parsed.season, episode: parsed.episode, title: parsed.title });
    if (!series.poster && channel.logo) series.poster = channel.logo;
  }
  const series = Array.from(byId.values());
  for (const item of series) {
    item.seasons = Object.keys(item.episodesBySeason).map(Number).sort((a, b) => a - b);
    for (const season of item.seasons) {
      item.episodesBySeason[season].sort((a, b) => a.episode - b.episode
        || a.channel.name.localeCompare(b.channel.name));
    }
  }
  series.sort((a, b) => a.name.localeCompare(b.name));
  return { series, flat };
}
