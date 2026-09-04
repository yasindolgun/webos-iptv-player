import type { Channel, PlaylistEntry } from '../types';
import { CONFIG } from '../config';
import { getCachedCatalog, setCachedCatalog } from './idb-cache';
import { channelContentKind, normalizeChannelContentKind, type M3uContentKind } from '../utils/m3u-content-kind';

const CACHE_VERSION = 2;
const KEY_PREFIX = 'm3u-catalog';

interface StoredM3uCatalog {
  version: number;
  sourceSignature: string;
  kind: M3uContentKind;
  channels: Channel[];
}

export function m3uSourceSignature(source: PlaylistEntry): string {
  const identity = `${source.source ?? 'url'}\n${source.url}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < identity.length; i++) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function cacheKey(sourceId: string, kind: M3uContentKind): string {
  return `${KEY_PREFIX}|${sourceId}|${kind}`;
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
  return payload.channels.map(normalizeChannelContentKind);
}

export function setCachedM3uCatalog(
  source: PlaylistEntry,
  kind: M3uContentKind,
  channels: Channel[],
): Promise<void> {
  const catalog = channels
    .filter(channel => channelContentKind(channel) === kind)
    .map(channel => ({ ...channel, playlistIds: [source.id] }));
  return setCachedCatalog(cacheKey(source.id, kind), {
    version: CACHE_VERSION,
    sourceSignature: m3uSourceSignature(source),
    kind,
    channels: catalog,
  } satisfies StoredM3uCatalog, CONFIG.PLAYLIST_REFRESH_INTERVAL).then(() => undefined);
}
