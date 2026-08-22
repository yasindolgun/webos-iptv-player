import type { Channel, PlaylistEntry } from '../types';
import { CONFIG } from '../config';
import { getCachedCatalog, setCachedCatalog } from './idb-cache';
import { m3uContentKind, type M3uContentKind } from '../utils/m3u-content-kind';

const CACHE_VERSION = 1;
const KEY_PREFIX = 'm3u-catalog';

interface StoredM3uCatalog {
  version: number;
  sourceSignature: string;
  kind: M3uContentKind;
  channels: Channel[];
}

export function m3uSourceSignature(source: PlaylistEntry): string {
  return `${source.source ?? 'url'}\n${source.url}`;
}

function cacheKey(sourceId: string, kind: M3uContentKind): string {
  return `${KEY_PREFIX}|${sourceId}|${kind}`;
}

function contentKind(channel: Channel): M3uContentKind {
  return channel.contentKind ?? m3uContentKind(channel.sourceGroup ?? channel.group);
}

export async function getCachedM3uCatalog(
  source: PlaylistEntry,
  kind: M3uContentKind,
): Promise<Channel[] | null> {
  const cached = await getCachedCatalog<StoredM3uCatalog>(cacheKey(source.id, kind));
  const payload = cached?.data;
  if (!payload
      || payload.version !== CACHE_VERSION
      || payload.kind !== kind
      || payload.sourceSignature !== m3uSourceSignature(source)) return null;
  return payload.channels;
}

export function setCachedM3uCatalog(
  source: PlaylistEntry,
  kind: M3uContentKind,
  channels: Channel[],
): Promise<void> {
  const catalog = channels
    .filter(channel => contentKind(channel) === kind)
    .map(channel => ({ ...channel, playlistIds: [source.id] }));
  return setCachedCatalog(cacheKey(source.id, kind), {
    version: CACHE_VERSION,
    sourceSignature: m3uSourceSignature(source),
    kind,
    channels: catalog,
  } satisfies StoredM3uCatalog, CONFIG.PLAYLIST_REFRESH_INTERVAL);
}
