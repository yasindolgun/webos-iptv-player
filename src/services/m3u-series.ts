import type { Channel } from '../types';
import { m3uCatalogCategoryId } from './m3u-catalog';
import { runInFrameSlices } from '../utils/frame-slices';
import {
  is247SeriesStream,
  parseM3uSeriesEpisodeName,
  type ParsedEpisodeName,
} from '../utils/m3u-episode';

export { is247SeriesStream, parseM3uSeriesEpisodeName, type ParsedEpisodeName };

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

export function m3uSeriesCatalog(channels: Channel[]): M3uSeriesCatalog {
  const byId = new Map<string, M3uSeries>();
  const flat: Channel[] = [];
  for (const channel of channels) {
    addSeriesChannel(channel, byId, flat);
  }
  return finalizeSeriesCatalog(byId, flat);
}

export async function m3uSeriesCatalogInFrames(
  channels: Channel[],
  shouldContinue: () => boolean,
): Promise<M3uSeriesCatalog | null> {
  const byId = new Map<string, M3uSeries>();
  const flat: Channel[] = [];
  let index = 0;
  const complete = channels.length === 0 || await runInFrameSlices(() => {
    addSeriesChannel(channels[index], byId, flat);
    index++;
    return index >= channels.length;
  }, { shouldContinue });
  return complete ? finalizeSeriesCatalog(byId, flat) : null;
}

function addSeriesChannel(
  channel: Channel,
  byId: Map<string, M3uSeries>,
  flat: Channel[],
): void {
  const parsed = parseM3uSeriesEpisodeName(channel.name);
  if (!parsed) {
    flat.push(channel);
    return;
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

function finalizeSeriesCatalog(
  byId: Map<string, M3uSeries>,
  flat: Channel[],
): M3uSeriesCatalog {
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
