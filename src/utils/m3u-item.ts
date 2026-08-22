import type { Channel } from '../types';
import { channelKey } from './channel';

// M3U VOD entries often omit tvg-id. Keep their user-data identity independent
// of provider ordering and rotating access-token query parameters.
export function m3uAccountId(channel: Channel): string {
  const sources = channel.playlistIds.slice().sort().join(',') || 'm3u';
  return `m3u:${sources}`;
}

export function m3uItemKey(channel: Channel): string {
  return `${m3uAccountId(channel)}:${channelKey(channel)}`;
}
