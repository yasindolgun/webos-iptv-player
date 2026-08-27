import { CONFIG } from '../config';
import {
  isValidOverlayStyle,
  isValidTextSize,
  isValidTheme,
} from '../config/themes';
import { isLocalePreference } from '../i18n';
import type {
  AudioPref,
  RecentlyWatchedLiveEntry,
  ResumeEntry,
  SubtitlePref,
  WatchlistEntry,
} from '../types';
import {
  type UserDataStore,
} from './idb-database';
import {
  loadAllUserRecords,
  replaceAllUserData,
  type UserDataRecord,
} from './idb-user-data';
import { StorageService } from './storage-service';

export const BACKUP_SCHEMA = 'webos-iptv-player-backup';
export const BACKUP_VERSION = 1;
export const BACKUP_MAX_BYTES = 2 * 1024 * 1024;

export const BACKUP_GROUPS = [
  'favorites',
  'customization',
  'epg',
  'watchlist',
  'preferences',
  'recentlyWatched',
  'playback',
] as const;

export type BackupGroup = typeof BACKUP_GROUPS[number];
export type BackupImportMode = 'merge' | 'replace';

interface BackupPreferences {
  autoPlay: boolean;
  locale: string;
  theme: string;
  textSize: string;
  overlayStyle: string;
  showHiddenChannels: boolean;
  playbackTracks: {
    audioLanguage: string;
    subtitleMode: 'off' | 'forced' | 'language';
    subtitleLanguage: string;
  };
}

interface BackupEpg {
  offsets: Record<string, number>;
  tzMode: 'device' | 'feed';
  tzOffset: number | null;
  mappings: UserDataRecord[];
}

type BackupData = Partial<{
  favorites: UserDataRecord<string>[];
  customization: UserDataRecord[];
  epg: BackupEpg;
  watchlist: UserDataRecord<WatchlistEntry>[];
  preferences: BackupPreferences;
  recentlyWatched: {
    live: UserDataRecord<RecentlyWatchedLiveEntry>[];
    catchup: UserDataRecord[];
  };
  playback: UserDataRecord[];
}>;

export interface BackupArchive {
  schema: typeof BACKUP_SCHEMA;
  version: typeof BACKUP_VERSION;
  appVersion: string;
  exportedAt: number;
  data: BackupData;
}

export interface BackupPreview {
  exportedAt: number;
  appVersion: string;
  groups: Array<{ id: BackupGroup; count: number }>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, max = 1024): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid ${label}`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}`);
  return value;
}

function stringArray(value: unknown, label: string, maxItems = 50_000): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Invalid ${label}`);
  return value.map((item, index) => stringValue(item, `${label} ${index}`, 1024));
}

function recordArray(value: unknown, label: string, maxItems = 50_000): UserDataRecord[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Invalid ${label}`);
  return value.map((item, index) => {
    const input = objectValue(item, `${label} record ${index}`);
    return {
      key: stringValue(input.key, `${label} key`, 2048),
      value: input.value,
      ...(input.scope === undefined ? {} : { scope: stringValue(input.scope, `${label} scope`) }),
      ...(input.updatedAt === undefined
        ? {}
        : { updatedAt: numberValue(input.updatedAt, `${label} updatedAt`) }),
      ...(input.expiresAt === undefined
        ? {}
        : { expiresAt: numberValue(input.expiresAt, `${label} expiresAt`) }),
    };
  });
}

function safeUrlKey(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === '' && parsed.password === ''
      && parsed.search === '' && parsed.hash === '';
  } catch {
    return false;
  }
}

function sanitizeResume(value: unknown): ResumeEntry {
  const item = objectValue(value, 'playback entry');
  const kind = item.kind;
  if (kind !== 'vod' && kind !== 'episode') throw new Error('Invalid playback kind');
  return {
    accountId: stringValue(item.accountId, 'playback account', 120),
    kind,
    itemId: stringValue(item.itemId, 'playback item', 120),
    name: stringValue(item.name, 'playback name', 512),
    poster: '',
    ext: stringValue(item.ext, 'playback extension', 32),
    position: numberValue(item.position, 'playback position'),
    duration: numberValue(item.duration, 'playback duration'),
    updatedAt: numberValue(item.updatedAt, 'playback timestamp'),
    ...(item.seriesId === undefined
      ? {}
      : { seriesId: stringValue(item.seriesId, 'playback series', 120) }),
    ...(item.watchlistOwner && objectValue(item.watchlistOwner, 'watchlist owner').kind === 'series'
      ? { watchlistOwner: {
          kind: 'series' as const,
          itemId: stringValue(
            objectValue(item.watchlistOwner, 'watchlist owner').itemId,
            'watchlist owner item',
            120,
          ),
        } }
      : {}),
  };
}

function sanitizeWatchlist(value: unknown): WatchlistEntry {
  const item = objectValue(value, 'watchlist entry');
  const kind = item.kind;
  if (kind !== 'vod' && kind !== 'series' && kind !== 'm3u-vod' && kind !== 'm3u-series') {
    throw new Error('Invalid watchlist kind');
  }
  return {
    accountId: stringValue(item.accountId, 'watchlist account', 120),
    kind,
    itemId: stringValue(item.itemId, 'watchlist item', 120),
    name: stringValue(item.name, 'watchlist name', 512),
    poster: '',
    rating: stringValue(item.rating, 'watchlist rating', 32),
    categoryId: stringValue(item.categoryId, 'watchlist category', 120),
    ...(item.containerExtension === undefined
      ? {}
      : { containerExtension: stringValue(item.containerExtension, 'watchlist extension', 32) }),
    addedAt: numberValue(item.addedAt, 'watchlist timestamp'),
  };
}

function validateCustomizationRecord(record: UserDataRecord): UserDataRecord {
  if (record.key === 'custom:meta') {
    const value = objectValue(record.value, 'customization metadata');
    return {
      key: record.key,
      value: {
        version: numberValue(value.version, 'customization version'),
        order: stringArray(value.order, 'channel order'),
        groupOrder: stringArray(value.groupOrder, 'group order'),
        customGroups: stringArray(value.customGroups, 'custom groups', 1000),
      },
    };
  }
  if (record.key.indexOf('custom:channel:') === 0) {
    const value = objectValue(record.value, 'channel override');
    const result: Record<string, unknown> = {};
    if (value.name !== undefined) result.name = stringValue(value.name, 'channel name', 512);
    if (value.group !== undefined) result.group = stringValue(value.group, 'channel group', 512);
    if (value.epgChannelId !== undefined) {
      result.epgChannelId = stringValue(value.epgChannelId, 'EPG channel id', 512);
    }
    if (value.epgOffsetDeltaMinutes !== undefined) {
      result.epgOffsetDeltaMinutes = numberValue(value.epgOffsetDeltaMinutes, 'EPG offset');
    }
    if (value.hidden !== undefined) result.hidden = booleanValue(value.hidden, 'hidden state');
    return { key: record.key, value: result };
  }
  if (record.key.indexOf('custom:group:') === 0) {
    const value = objectValue(record.value, 'group override');
    const result: Record<string, unknown> = {};
    if (value.name !== undefined) result.name = stringValue(value.name, 'group name', 512);
    if (value.hidden !== undefined) result.hidden = booleanValue(value.hidden, 'group hidden state');
    return { key: record.key, value: result };
  }
  if (record.key.indexOf('audio:') === 0) {
    const value = objectValue(record.value, 'audio preference');
    const pref: AudioPref = {
      name: stringValue(value.name, 'audio name', 256),
      lang: stringValue(value.lang, 'audio language', 32),
    };
    return { key: record.key, value: pref };
  }
  if (record.key.indexOf('subtitle:') === 0) {
    const value = objectValue(record.value, 'subtitle preference');
    const pref: SubtitlePref = {
      off: booleanValue(value.off, 'subtitle off state'),
      name: stringValue(value.name, 'subtitle name', 256),
      lang: stringValue(value.lang, 'subtitle language', 32),
      ...(value.cc === undefined ? {} : { cc: booleanValue(value.cc, 'caption state') }),
    };
    return { key: record.key, value: pref };
  }
  if (record.key.indexOf('offset:') === 0) {
    return { key: record.key, value: numberValue(record.value, 'subtitle offset') };
  }
  throw new Error('Invalid customization record key');
}

function parsePreferences(value: unknown): BackupPreferences {
  const item = objectValue(value, 'preferences');
  const tracks = objectValue(item.playbackTracks, 'playback track preferences');
  const subtitleMode = tracks.subtitleMode;
  if (subtitleMode !== 'off' && subtitleMode !== 'forced' && subtitleMode !== 'language') {
    throw new Error('Invalid subtitle mode');
  }
  const locale = stringValue(item.locale, 'locale', 32);
  const theme = stringValue(item.theme, 'theme', 64);
  const textSize = stringValue(item.textSize, 'text size', 32);
  const overlayStyle = stringValue(item.overlayStyle, 'overlay style', 64);
  if (!isLocalePreference(locale)) throw new Error('Invalid locale');
  if (!isValidTheme(theme)) throw new Error('Invalid theme');
  if (!isValidTextSize(textSize)) throw new Error('Invalid text size');
  if (!isValidOverlayStyle(overlayStyle)) throw new Error('Invalid overlay style');
  return {
    autoPlay: booleanValue(item.autoPlay, 'auto play'),
    locale,
    theme,
    textSize,
    overlayStyle,
    showHiddenChannels: booleanValue(item.showHiddenChannels, 'hidden-channel state'),
    playbackTracks: {
      audioLanguage: stringValue(tracks.audioLanguage, 'audio language', 32),
      subtitleMode,
      subtitleLanguage: stringValue(tracks.subtitleLanguage, 'subtitle language', 32),
    },
  };
}

function parseEpg(value: unknown): BackupEpg {
  const item = objectValue(value, 'EPG preferences');
  const rawOffsets = objectValue(item.offsets, 'EPG offsets');
  const offsets: Record<string, number> = {};
  for (const url of Object.keys(rawOffsets)) {
    if (!safeUrlKey(url)) throw new Error('Credential-bearing EPG URLs cannot be imported');
    const offset = numberValue(rawOffsets[url], 'EPG offset');
    if (Math.abs(offset) > CONFIG.EPG.OFFSET_MAX_MINUTES) throw new Error('Invalid EPG offset');
    offsets[url] = Math.round(offset);
  }
  if (item.tzMode !== 'device' && item.tzMode !== 'feed') throw new Error('Invalid EPG timezone mode');
  const mappings = recordArray(item.mappings, 'EPG mappings').map(record => {
    if (record.key.indexOf('custom:channel:') !== 0) throw new Error('Invalid EPG mapping key');
    const source = objectValue(record.value, 'EPG mapping');
    const mapping: Record<string, unknown> = {};
    if (source.epgChannelId !== undefined) {
      mapping.epgChannelId = stringValue(source.epgChannelId, 'EPG channel id', 512);
    }
    if (source.epgOffsetDeltaMinutes !== undefined) {
      mapping.epgOffsetDeltaMinutes = numberValue(source.epgOffsetDeltaMinutes, 'EPG mapping offset');
    }
    if (Object.keys(mapping).length === 0) throw new Error('Empty EPG mapping');
    return { key: record.key, value: mapping };
  });
  const tzOffset = item.tzOffset === null ? null : numberValue(item.tzOffset, 'EPG timezone offset');
  if (tzOffset !== null && Math.abs(tzOffset) > 24 * 60) {
    throw new Error('Invalid EPG timezone offset');
  }
  return {
    offsets,
    tzMode: item.tzMode,
    tzOffset,
    mappings,
  };
}

function parseArchiveObject(value: unknown): BackupArchive {
  const root = objectValue(value, 'backup archive');
  if (root.schema !== BACKUP_SCHEMA) throw new Error('Unsupported backup format');
  if (root.version !== BACKUP_VERSION) throw new Error('Unsupported backup version');
  const data = objectValue(root.data, 'backup data');
  const parsed: BackupData = {};
  if (data.favorites !== undefined) {
    parsed.favorites = recordArray(data.favorites, 'favorites').map(record => {
      if (record.key.indexOf('favorite:') !== 0) throw new Error('Invalid favorite key');
      const value = stringValue(record.value, 'favorite', 2048);
      if (!value) throw new Error('Invalid favorite');
      return { key: `favorite:${value}`, value };
    });
  }
  if (data.customization !== undefined) {
    parsed.customization = recordArray(data.customization, 'customization')
      .map(validateCustomizationRecord);
  }
  if (data.epg !== undefined) parsed.epg = parseEpg(data.epg);
  if (data.watchlist !== undefined) {
    parsed.watchlist = recordArray(data.watchlist, 'watchlist').map(record => {
      if (record.key.indexOf('watch:') !== 0) throw new Error('Invalid watchlist key');
      const entry = sanitizeWatchlist(record.value);
      return {
        key: `watch:${entry.accountId}|${entry.kind}|${entry.itemId}`,
        value: entry,
        scope: `${entry.accountId}|${entry.kind}`,
        updatedAt: entry.addedAt,
      };
    });
  }
  if (data.preferences !== undefined) parsed.preferences = parsePreferences(data.preferences);
  if (data.recentlyWatched !== undefined) {
    const recent = objectValue(data.recentlyWatched, 'recently watched');
    const live = recordArray(recent.live, 'recent live').map(record => {
      if (record.key.indexOf('live:') !== 0) throw new Error('Invalid recent-live key');
      const item = objectValue(record.value, 'recent-live entry');
      const entry = {
        channelKey: stringValue(item.channelKey, 'recent channel', 2048),
        updatedAt: numberValue(item.updatedAt, 'recent timestamp'),
      };
      return { key: `live:${entry.channelKey}`, value: entry, updatedAt: entry.updatedAt };
    });
    const catchup = recordArray(recent.catchup, 'catch-up history').map(record => {
      if (record.key.indexOf('catchup:') !== 0) throw new Error('Invalid catch-up key');
      const item = objectValue(record.value, 'catch-up entry');
      const channelKey = stringValue(item.channelKey, 'catch-up channel', 2048);
      const progStart = numberValue(item.progStart, 'catch-up start');
      const progEnd = numberValue(item.progEnd, 'catch-up end');
      const updatedAt = numberValue(item.updatedAt, 'catch-up timestamp');
      const expiresAt = numberValue(record.expiresAt, 'catch-up expiry');
      return {
        key: `catchup:${channelKey}|${progStart}`,
        value: {
          channelKey,
          progStart,
          progEnd,
          title: item.title === undefined ? undefined : stringValue(item.title, 'catch-up title', 512),
          description: item.description === undefined
            ? undefined
            : stringValue(item.description, 'catch-up description', 4096),
          icon: '',
          position: numberValue(item.position, 'catch-up position'),
          duration: numberValue(item.duration, 'catch-up duration'),
          updatedAt,
          completed: booleanValue(item.completed, 'catch-up completed state'),
          expiresAt,
        },
        updatedAt,
        expiresAt,
      };
    });
    parsed.recentlyWatched = { live, catchup };
  }
  if (data.playback !== undefined) {
    parsed.playback = recordArray(data.playback, 'playback').map(record => {
      if (record.key.indexOf('completed:') === 0) {
        const item = objectValue(record.value, 'episode completion');
        const accountId = stringValue(item.accountId, 'completion account', 120);
        const seriesId = stringValue(item.seriesId, 'completion series', 120);
        const itemId = stringValue(item.itemId, 'completion item', 120);
        const completedAt = numberValue(item.completedAt, 'completion timestamp');
        return {
          key: `completed:${accountId}|${itemId}`,
          value: { accountId, seriesId, itemId, completedAt },
          updatedAt: completedAt,
        };
      }
      const prefix = record.key.indexOf('resume:') === 0
        ? 'resume:'
        : record.key.indexOf('history:') === 0 ? 'history:' : '';
      if (!prefix) throw new Error('Invalid playback key');
      const entry = sanitizeResume(record.value);
      return {
        key: `${prefix}${entry.accountId}|${entry.kind}|${entry.itemId}`,
        value: entry,
        updatedAt: entry.updatedAt,
      };
    });
  }
  return {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    appVersion: stringValue(root.appVersion, 'app version', 32),
    exportedAt: numberValue(root.exportedAt, 'export timestamp'),
    data: parsed,
  };
}

function selectedGroups(archive: BackupArchive, groups?: readonly BackupGroup[]): BackupGroup[] {
  const allowed = new Set(groups ?? BACKUP_GROUPS);
  return BACKUP_GROUPS.filter(group => allowed.has(group) && archive.data[group] !== undefined);
}

function recordCount(group: BackupGroup, value: unknown): number {
  if (group === 'preferences' || group === 'epg') return 1;
  if (group === 'recentlyWatched') {
    const recent = value as NonNullable<BackupData['recentlyWatched']>;
    return recent.live.length + recent.catchup.length;
  }
  return (value as unknown[]).length;
}

function mergeRecords(current: UserDataRecord[], incoming: UserDataRecord[]): UserDataRecord[] {
  const byKey = new Map(current.map(item => [item.key, item]));
  for (const item of incoming) byKey.set(item.key, item);
  return [...byKey.values()];
}

function replacePrefix(
  current: UserDataRecord[],
  incoming: UserDataRecord[],
  prefixes: readonly string[],
): UserDataRecord[] {
  return [
    ...current.filter(item => !prefixes.some(prefix => item.key.indexOf(prefix) === 0)),
    ...incoming,
  ];
}

function backupPreferences(): BackupPreferences {
  return {
    autoPlay: StorageService.getAutoPlay(),
    locale: StorageService.getLocalePreference(),
    theme: StorageService.getTheme(),
    textSize: StorageService.getTextSize(),
    overlayStyle: StorageService.getOverlayStyle(),
    showHiddenChannels: StorageService.getShowHiddenChannels(),
    playbackTracks: StorageService.getPlaybackTrackPreferences(),
  };
}

function backupEpg(channelState: UserDataRecord[]): BackupEpg {
  const offsets = StorageService.getEpgOffsets();
  const safe: Record<string, number> = {};
  for (const url of Object.keys(offsets)) {
    if (safeUrlKey(url)) safe[url] = offsets[url];
  }
  return {
    offsets: safe,
    tzMode: StorageService.getTzMode(),
    tzOffset: StorageService.getEpgTzOffset(),
    mappings: channelState
      .filter(record => record.key.indexOf('custom:channel:') === 0)
      .map(record => {
        const value = objectValue(record.value, 'channel override');
        const mapping: Record<string, unknown> = {};
        if (typeof value.epgChannelId === 'string') mapping.epgChannelId = value.epgChannelId;
        if (typeof value.epgOffsetDeltaMinutes === 'number') {
          mapping.epgOffsetDeltaMinutes = value.epgOffsetDeltaMinutes;
        }
        return { key: record.key, value: mapping };
      })
      .filter(record => Object.keys(record.value).length > 0),
  };
}

function mergeEpgMappings(
  channelState: UserDataRecord[],
  mappings: UserDataRecord[],
  replace: boolean,
): UserDataRecord[] {
  const byKey = new Map(channelState.map(record => [record.key, clone(record)]));
  if (replace) {
    for (const [key, record] of byKey) {
      if (key.indexOf('custom:channel:') !== 0) continue;
      const value = objectValue(record.value, 'channel override');
      delete value.epgChannelId;
      delete value.epgOffsetDeltaMinutes;
      record.value = value;
    }
  }
  if (mappings.length > 0 && !byKey.has('custom:meta')) {
    byKey.set('custom:meta', {
      key: 'custom:meta',
      value: {
        version: CONFIG.CHANNEL_CUSTOMIZATION_VERSION,
        order: [],
        groupOrder: [],
        customGroups: [],
      },
    });
  }
  for (const mapping of mappings) {
    const existing = byKey.get(mapping.key);
    const current = existing ? objectValue(existing.value, 'channel override') : {};
    byKey.set(mapping.key, {
      key: mapping.key,
      value: { ...current, ...objectValue(mapping.value, 'EPG mapping') },
    });
  }
  return [...byKey.values()];
}

function applyPreferences(value: BackupPreferences): boolean {
  const writes: Array<[string, unknown]> = [
    ['auto_play', value.autoPlay],
    ['locale', value.locale],
    ['theme', value.theme],
    ['text_size', value.textSize],
    ['overlay_style', value.overlayStyle],
    ['show_hidden_channels', value.showHiddenChannels],
    ['playback_track_preferences', value.playbackTracks],
  ];
  return writes.every(item => StorageService.set(item[0], item[1]));
}

function applyEpg(value: BackupEpg): boolean {
  return StorageService.set('epg_offsets', value.offsets)
    && StorageService.set('tz_mode', value.tzMode)
    && StorageService.set('epg_tz_offset', value.tzOffset);
}

export const BackupService = {
  async createArchive(groups: readonly BackupGroup[] = BACKUP_GROUPS): Promise<BackupArchive> {
    await StorageService.flush();
    const records = await loadAllUserRecords();
    const requested = new Set(groups);
    const data: BackupData = {};
    if (requested.has('favorites')) {
      data.favorites = records.favorites.map(item => ({
        key: item.key,
        value: stringValue(item.value, 'favorite', 2048),
      }));
    }
    if (requested.has('customization')) {
      data.customization = clone(records['channel-state']);
    }
    if (requested.has('epg')) data.epg = backupEpg(records['channel-state']);
    if (requested.has('watchlist')) {
      data.watchlist = records.watchlist.map(item => ({
        ...item,
        value: sanitizeWatchlist(item.value),
      }));
    }
    if (requested.has('preferences')) data.preferences = backupPreferences();
    if (requested.has('recentlyWatched')) {
      data.recentlyWatched = {
        live: records['recently-watched'].map(item => {
          const value = objectValue(item.value, 'recent-live entry');
          const entry: RecentlyWatchedLiveEntry = {
            channelKey: stringValue(value.channelKey, 'recent channel', 2048),
            updatedAt: numberValue(value.updatedAt, 'recent timestamp'),
          };
          return { key: `live:${entry.channelKey}`, value: entry, updatedAt: entry.updatedAt };
        }),
        catchup: records['playback-progress']
          .filter(item => item.key.indexOf('catchup:') === 0)
          .map(item => {
            const value = objectValue(item.value, 'catch-up entry');
            return {
              ...item,
              value: { ...value, epgSourceUrl: undefined, icon: '' },
            };
          }),
      };
    }
    if (requested.has('playback')) {
      data.playback = records['playback-progress']
        .filter(item => item.key.indexOf('resume:') === 0
          || item.key.indexOf('history:') === 0
          || item.key.indexOf('completed:') === 0)
        .map(item => item.key.indexOf('completed:') === 0
          ? clone(item)
          : { ...item, value: sanitizeResume(item.value) });
    }
    return {
      schema: BACKUP_SCHEMA,
      version: BACKUP_VERSION,
      appVersion: CONFIG.VERSION,
      exportedAt: Date.now(),
      data,
    };
  },

  parse(raw: string | unknown): BackupArchive {
    if (typeof raw === 'string') {
      if (raw.length > BACKUP_MAX_BYTES) throw new Error('Backup archive is too large');
      try {
        return parseArchiveObject(JSON.parse(raw));
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('Invalid backup JSON');
        throw error;
      }
    }
    return parseArchiveObject(raw);
  },

  preview(raw: string | unknown): BackupPreview {
    const archive = this.parse(raw);
    return {
      exportedAt: archive.exportedAt,
      appVersion: archive.appVersion,
      groups: selectedGroups(archive).map(id => ({
        id,
        count: recordCount(id, archive.data[id]),
      })),
    };
  },

  async importArchive(
    raw: string | unknown,
    mode: BackupImportMode,
    requestedGroups?: readonly BackupGroup[],
  ): Promise<BackupPreview> {
    if (mode !== 'merge' && mode !== 'replace') throw new Error('Invalid import mode');
    const archive = this.parse(raw);
    const groups = selectedGroups(archive, requestedGroups);
    if (groups.length === 0) throw new Error('No backup data groups selected');
    const original = await loadAllUserRecords();
    const next = clone(original) as Record<UserDataStore, UserDataRecord[]>;
    const oldLocal: Record<string, string | null> = {};
    const localKeys = [
      'auto_play', 'locale', 'theme', 'text_size', 'overlay_style',
      'show_hidden_channels', 'playback_track_preferences',
      'epg_offsets', 'tz_mode', 'epg_tz_offset',
    ];
    for (const key of localKeys) oldLocal[key] = localStorage.getItem(CONFIG.STORAGE_PREFIX + key);

    for (const group of groups) {
      if (group === 'favorites') {
        next.favorites = mode === 'replace'
          ? clone(archive.data.favorites!)
          : mergeRecords(next.favorites, archive.data.favorites!);
      } else if (group === 'customization') {
        next['channel-state'] = mode === 'replace'
          ? replacePrefix(next['channel-state'], archive.data.customization!, [
              'custom:', 'audio:', 'subtitle:', 'offset:',
            ])
          : mergeRecords(next['channel-state'], archive.data.customization!);
      } else if (group === 'watchlist') {
        next.watchlist = mode === 'replace'
          ? clone(archive.data.watchlist!)
          : mergeRecords(next.watchlist, archive.data.watchlist!);
      } else if (group === 'epg') {
        next['channel-state'] = mergeEpgMappings(
          next['channel-state'],
          archive.data.epg!.mappings,
          mode === 'replace',
        );
      } else if (group === 'recentlyWatched') {
        const recent = archive.data.recentlyWatched!;
        next['recently-watched'] = mode === 'replace'
          ? clone(recent.live)
          : mergeRecords(next['recently-watched'], recent.live);
        next['playback-progress'] = mode === 'replace'
          ? replacePrefix(next['playback-progress'], recent.catchup, ['catchup:'])
          : mergeRecords(next['playback-progress'], recent.catchup);
      } else if (group === 'playback') {
        next['playback-progress'] = mode === 'replace'
          ? replacePrefix(next['playback-progress'], archive.data.playback!, [
              'resume:', 'history:', 'completed:',
            ])
          : mergeRecords(next['playback-progress'], archive.data.playback!);
      }
    }

    await StorageService.flush();
    try {
      await replaceAllUserData(next);
      if (groups.indexOf('preferences') >= 0 && !applyPreferences(archive.data.preferences!)) {
        throw new Error('Could not save imported preferences');
      }
      if (groups.indexOf('epg') >= 0 && !applyEpg(archive.data.epg!)) {
        throw new Error('Could not save imported EPG preferences');
      }
      await StorageService.reloadUserData();
    } catch (error) {
      await replaceAllUserData(original);
      for (const key of localKeys) {
        const previous = oldLocal[key];
        if (previous === null) localStorage.removeItem(CONFIG.STORAGE_PREFIX + key);
        else localStorage.setItem(CONFIG.STORAGE_PREFIX + key, previous);
      }
      await StorageService.reloadUserData();
      throw error;
    }
    return this.preview(archive);
  },
};
