import type { Channel } from '../types';
import type { M3uContentKind } from '../utils/m3u-content-kind';

export interface M3uCatalogCategory {
  id: string;
  name: string;
  count: number;
}

export interface M3uCatalogItem {
  id: string;
  name: string;
  poster: string;
  categoryId: string;
  playlistIds: string[];
  url: string;
}

function categoryName(channel: Channel): string {
  return channel.sourceGroup || channel.group || 'Other';
}

function categoryId(name: string): string {
  return name.toLowerCase();
}

export function m3uCatalogCategoryId(channel: Channel): string {
  return categoryId(categoryName(channel));
}

export function m3uCatalogCategories(channels: Channel[]): M3uCatalogCategory[] {
  const counts = new Map<string, M3uCatalogCategory>();
  for (const channel of channels) {
    const name = categoryName(channel);
    const id = m3uCatalogCategoryId(channel);
    const existing = counts.get(id);
    if (existing) existing.count++;
    else counts.set(id, { id, name, count: 1 });
  }
  return Array.from(counts.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function m3uCatalogItems(channels: Channel[], category?: string): M3uCatalogItem[] {
  return channels
    .filter(channel => !category || m3uCatalogCategoryId(channel) === category)
    .map(channel => ({
      id: channel.id,
      name: channel.name,
      poster: channel.logo,
      categoryId: categoryId(categoryName(channel)),
      playlistIds: channel.playlistIds.slice(),
      url: channel.url,
    }));
}

export function m3uCatalogForKind(
  channels: Channel[],
  kind: M3uContentKind,
): M3uCatalogItem[] {
  return m3uCatalogItems(channels.filter(channel => channel.contentKind === kind));
}
