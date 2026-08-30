import { CONFIG } from '../config';
import type { Channel } from '../types';
import {
  channelKeyHash,
  legacyChannelKeyHash,
} from '../utils/channel-key';
import { m3uContentKind, type M3uContentKind } from '../utils/m3u-content-kind';

export interface PlaylistIndexDocument {
  url: string;
  group: string;
  groupKey: string;
  sourceGroup: string;
  contentKind: M3uContentKind | '';
  playlistIds: string[];
}

export interface PlaylistIndexPlan {
  channelKeys: CompactChannelKeyIndex;
  legacyChannelKeys: CompactChannelKeyIndex;
  groups: string[];
  groupKeyByDisplay: Map<string, string>;
  channelIndicesByGroup: Map<string, Uint32Array>;
  channelIndicesByContentKind: Map<M3uContentKind, Uint32Array>;
  channelIndicesByPlaylist: Map<string, Uint32Array>;
  channelIndicesByPlaylistGroup: Map<string, Map<string, Uint32Array>>;
  groupsByPlaylist: Map<string, string[]>;
  channelCount: number;
}

export interface CompactChannelKeyIndex {
  hashes: Uint32Array;
  values: Uint32Array;
}

export class PlaylistIndexBuilder {
  private readonly channelKeys: CompactChannelKeyIndex;
  private readonly legacyChannelKeys: CompactChannelKeyIndex;
  private readonly groupSet = new Set<string>();
  private readonly groupSetsByPlaylist = new Map<string, Set<string>>();
  private readonly groupKeyByDisplay = new Map<string, string>();
  private readonly channelIndicesByGroup = new Map<string, number[]>();
  private readonly channelIndicesByContentKind = new Map<M3uContentKind, number[]>();
  private readonly channelIndicesByPlaylist = new Map<string, number[]>();
  private readonly channelIndicesByPlaylistGroup = new Map<string, Map<string, number[]>>();
  private channelCount = 0;

  constructor(
    private readonly customGroups: Array<{ key: string; label: string }>,
    private readonly expectedChannelCount: number,
  ) {
    this.channelKeys = createCompactChannelKeys(expectedChannelCount);
    this.legacyChannelKeys = createCompactChannelKeys(expectedChannelCount);
    for (const group of customGroups) this.groupKeyByDisplay.set(group.label, group.key);
  }

  add(documents: PlaylistIndexDocument[]): void {
    for (const document of documents) {
      if (this.channelCount >= this.expectedChannelCount) {
        throw new Error('Playlist index received more channels than declared');
      }
      const index = this.channelCount++;
      const key = channelKeyHash(document);
      addCompactChannelKey(this.channelKeys, key, index);
      const legacyKey = legacyChannelKeyHash(document);
      addCompactChannelKey(this.legacyChannelKeys, legacyKey, index);

      if (document.group) {
        this.groupSet.add(document.group);
        if (!this.groupKeyByDisplay.has(document.group)) {
          this.groupKeyByDisplay.set(document.group, document.groupKey || document.group);
        }
        appendIndexed(this.channelIndicesByGroup, document.group, index);
      }

      const contentKind = document.contentKind
        || m3uContentKind(document.sourceGroup || document.group);
      appendIndexed(this.channelIndicesByContentKind, contentKind, index);

      for (const playlistId of document.playlistIds) {
        appendIndexed(this.channelIndicesByPlaylist, playlistId, index);
        if (!document.group) continue;
        let byGroup = this.channelIndicesByPlaylistGroup.get(playlistId);
        if (!byGroup) {
          byGroup = new Map();
          this.channelIndicesByPlaylistGroup.set(playlistId, byGroup);
        }
        appendIndexed(byGroup, document.group, index);
        let playlistGroups = this.groupSetsByPlaylist.get(playlistId);
        if (!playlistGroups) {
          playlistGroups = new Set();
          this.groupSetsByPlaylist.set(playlistId, playlistGroups);
        }
        playlistGroups.add(document.group);
      }
    }
  }

  finish(): PlaylistIndexPlan {
    for (const group of this.customGroups) {
      this.groupSet.add(group.label);
      this.groupKeyByDisplay.set(group.label, group.key);
    }
    const groupsByPlaylist = new Map<string, string[]>();
    this.groupSetsByPlaylist.forEach((groups, playlistId) => {
      groupsByPlaylist.set(playlistId, Array.from(groups));
    });
    return {
      channelKeys: this.channelKeys,
      legacyChannelKeys: this.legacyChannelKeys,
      groups: Array.from(this.groupSet),
      groupKeyByDisplay: this.groupKeyByDisplay,
      channelIndicesByGroup: compactIndexLists(this.channelIndicesByGroup),
      channelIndicesByContentKind: compactIndexLists(this.channelIndicesByContentKind),
      channelIndicesByPlaylist: compactIndexLists(this.channelIndicesByPlaylist),
      channelIndicesByPlaylistGroup: compactNestedIndexLists(
        this.channelIndicesByPlaylistGroup,
      ),
      groupsByPlaylist,
      channelCount: this.channelCount,
    };
  }
}

export function playlistIndexTransferables(plan: PlaylistIndexPlan): Transferable[] {
  const transfer: Transferable[] = [
    plan.channelKeys.hashes.buffer,
    plan.channelKeys.values.buffer,
    plan.legacyChannelKeys.hashes.buffer,
    plan.legacyChannelKeys.values.buffer,
  ];
  appendIndexTransfers(transfer, plan.channelIndicesByGroup);
  appendIndexTransfers(transfer, plan.channelIndicesByContentKind);
  appendIndexTransfers(transfer, plan.channelIndicesByPlaylist);
  plan.channelIndicesByPlaylistGroup.forEach(byGroup => {
    appendIndexTransfers(transfer, byGroup);
  });
  return transfer;
}

function createCompactChannelKeys(channelCount: number): CompactChannelKeyIndex {
  let capacity = 1;
  while (capacity < channelCount * 2) capacity *= 2;
  return {
    hashes: new Uint32Array(capacity),
    values: new Uint32Array(capacity),
  };
}

function addCompactChannelKey(
  index: CompactChannelKeyIndex,
  hash: number,
  channelIndex: number,
): void {
  const mask = index.hashes.length - 1;
  let slot = hash & mask;
  while (index.values[slot] !== 0 && index.hashes[slot] !== hash) {
    slot = (slot + 1) & mask;
  }
  if (index.values[slot] === 0) {
    index.hashes[slot] = hash;
    index.values[slot] = channelIndex + 1;
  } else {
    index.values[slot] = 0xffffffff;
  }
}

export function playlistIndexDocument(channel: Channel): PlaylistIndexDocument {
  return {
    url: channel.url,
    group: channel.group,
    groupKey: channel.groupKey ?? '',
    sourceGroup: channel.sourceGroup ?? '',
    contentKind: channel.contentKind ?? '',
    playlistIds: channel.playlistIds,
  };
}

export function buildPlaylistIndexPlan(
  channels: Channel[],
  customGroups: Array<{ key: string; label: string }>,
): PlaylistIndexPlan {
  const builder = new PlaylistIndexBuilder(customGroups, channels.length);
  for (let start = 0; start < channels.length; start += CONFIG.M3U.RESULT_BATCH_SIZE) {
    const end = Math.min(start + CONFIG.M3U.RESULT_BATCH_SIZE, channels.length);
    const documents = [];
    for (let index = start; index < end; index++) {
      documents.push(playlistIndexDocument(channels[index]));
    }
    builder.add(documents);
  }
  return builder.finish();
}

function appendIndexed<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function compactIndexLists<Key>(source: Map<Key, number[]>): Map<Key, Uint32Array> {
  const compact = new Map<Key, Uint32Array>();
  source.forEach((indices, key) => compact.set(key, new Uint32Array(indices)));
  return compact;
}

function compactNestedIndexLists(
  source: Map<string, Map<string, number[]>>,
): Map<string, Map<string, Uint32Array>> {
  const compact = new Map<string, Map<string, Uint32Array>>();
  source.forEach((byGroup, playlistId) => {
    compact.set(playlistId, compactIndexLists(byGroup));
  });
  return compact;
}

function appendIndexTransfers<Key>(
  transfer: Transferable[],
  source: Map<Key, Uint32Array>,
): void {
  source.forEach(indices => transfer.push(indices.buffer));
}
