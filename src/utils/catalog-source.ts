import type { PlaylistEntry } from '../types';
import type { M3uContentKind } from './m3u-content-kind';
import { isSourceEnabled } from './playlist';

export type CatalogSection = 'movies' | 'series';

export type CatalogSource = {
  kind: 'xtream' | 'm3u';
  playlistId: string;
};

export function catalogSourceKey(source: CatalogSource): string {
  return `${source.kind}:${source.playlistId}`;
}

export function parseCatalogSource(value: string | null): CatalogSource | null {
  if (!value) return null;
  const separator = value.indexOf(':');
  if (separator < 1 || separator === value.length - 1) return null;
  const kind = value.slice(0, separator);
  if (kind !== 'xtream' && kind !== 'm3u') return null;
  return { kind, playlistId: value.slice(separator + 1) };
}

export function availableCatalogSources(
  playlists: PlaylistEntry[],
  section: CatalogSection,
  getM3uCount: (kind: M3uContentKind, playlistId: string) => number,
): CatalogSource[] {
  const kind: M3uContentKind = section === 'movies' ? 'movie' : 'series';
  const sources: CatalogSource[] = [];
  for (const playlist of playlists) {
    if (!isSourceEnabled(playlist)) continue;
    if (playlist.source === 'xtream' && playlist.xtream) {
      sources.push({ kind: 'xtream', playlistId: playlist.id });
    } else if (getM3uCount(kind, playlist.id) > 0) {
      sources.push({ kind: 'm3u', playlistId: playlist.id });
    }
  }
  return sources;
}

export function resolveCatalogSource(
  available: CatalogSource[],
  selected: CatalogSource | null,
  preferredXtreamId: string | null,
): CatalogSource | null {
  const matches = (candidate: CatalogSource, expected: CatalogSource): boolean =>
    candidate.kind === expected.kind && candidate.playlistId === expected.playlistId;
  if (selected) {
    const saved = available.find(candidate => matches(candidate, selected));
    if (saved) return saved;
  }
  if (preferredXtreamId) {
    const preferred = available.find(source =>
      source.kind === 'xtream' && source.playlistId === preferredXtreamId);
    if (preferred) return preferred;
  }
  return available[0] ?? null;
}
