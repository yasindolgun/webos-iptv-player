import {
  UNCATEGORIZED_GROUP,
  type Channel,
  type ChannelGroupId,
  type EpgSource,
  type ParsedPlaylist,
  type PlaylistEntry,
  type PlaylistTab,
} from '../types';
import { fetchPlaylistBytes } from '../utils/fetch-helper';
import { parseM3UOffThread } from '../workers/m3u-parser-client';
import {
  xtreamPlaylistUrl,
  xtreamEpgUrl,
  xtreamCatchupSources,
  xtreamLiveUrl,
  xtreamLiveStreamId,
  resolveXtreamLiveOutput,
  type XtreamCredentials,
  type XtreamLiveOutput,
} from '../utils/xtream-url';
import {
  channelKey,
  legacyChannelKey,
  stableStreamUrl,
} from '../utils/channel';
import {
  prepareSearchItem,
  rankPreparedTopK,
  type PreparedSearchItem,
  type RankedSearchResult,
} from '../utils/channel-search';
import { createLogger } from '../utils/logger';
import { StorageService } from './storage-service';
import { ChannelCustomizationService, groupKeyOf } from './channel-customization';
import {
  createXtreamClient,
  type XtreamLiveCategory,
  type XtreamLiveStream,
} from './xtream-client';
import { getCachedPlaylist, scheduleCachedPlaylist } from './idb-cache';
import { isSourceEnabled } from '../utils/playlist';
import { m3uContentKind, type M3uContentKind } from '../utils/m3u-content-kind';
import { getCachedM3uCatalog, setCachedM3uCatalog } from './m3u-catalog-cache';

const log = createLogger('Playlist');

export interface PlaylistRefreshProgress {
  completed: number;
  total: number;
  phase: 'download' | 'parse' | 'merge' | 'cache';
  sourceId?: string;
}

export interface PlaylistRefreshReport {
  channels: Channel[];
  sourceCount: number;
  failedSourceIds: string[];
  restoredSourceIds: string[];
}

function usableDirectSource(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : '';
  } catch {
    return '';
  }
}

function isXtreamLiveEntry(channel: Channel): boolean {
  try {
    const firstPathPart = new URL(channel.url).pathname.split('/').filter(Boolean)[0]
      ?.toLowerCase();
    if (firstPathPart === 'movie' || firstPathPart === 'series') return false;
    if (firstPathPart === 'live') return true;
  } catch {
    // Fall back to the M3U group classification for non-standard stream routes.
  }
  return (channel.contentKind ?? m3uContentKind(channel.sourceGroup ?? channel.group)) === 'live';
}

function xtreamLivePlaylist(
  credentials: XtreamCredentials,
  output: XtreamLiveOutput,
  categories: XtreamLiveCategory[],
  streams: XtreamLiveStream[],
): ParsedPlaylist {
  const categoryNames = new Map(categories.map(category => [category.id, category.name]));
  const channels: Channel[] = streams.map(stream => ({
    id: stream.epgChannelId || stream.streamId,
    name: stream.name || stream.streamId,
    logo: stream.icon,
    group: categoryNames.get(stream.categoryId) || UNCATEGORIZED_GROUP,
    url: usableDirectSource(stream.directSource)
      || xtreamLiveUrl(credentials, stream.streamId, output),
    extras: null,
    playlistIds: [],
    catchup: '',
    catchupSource: '',
    catchupDays: 0,
    catchupStreamId: stream.streamId,
    contentKind: 'live',
  }));
  const groups = Array.from(new Set(channels.map(channel => channel.group)));
  return {
    channels,
    groups,
    epgUrl: '',
    epgUrls: [],
    headerAttributes: {},
    format: 'unknown',
    issues: [],
  };
}

class PlaylistServiceImpl {
  /** Every parsed channel, hidden ones included. Edit mode reads this. */
  allChannels: Channel[] = [];
  /** Visible channels in effective (customized) order. Everything else reads this. */
  channels: Channel[] = [];
  groups: string[] = [];
  groupsRevision = 0;
  playlistTabs: PlaylistTab[] = [];
  epgSources: EpgSource[] = [];
  private indexMap = new Map<Channel, number>(); // channel -> global index, O(1) indexOf
  private channelsByGroup = new Map<string, Channel[]>();
  private channelsByContentKind = new Map<M3uContentKind, Channel[]>();
  private channelsByPlaylist = new Map<string, Channel[]>();
  private channelsByPlaylistGroup = new Map<string, Map<string, Channel[]>>();
  private groupsByPlaylist = new Map<string, string[]>();
  private groupKeyByDisplay = new Map<string, string>();
  private channelByKey = new Map<string, Channel>();
  private channelByLegacyKey = new Map<string, Channel | null>();
  private channelSearchIndex: PreparedSearchItem<Channel>[] = [];
  private channelSearchByPlaylist = new Map<string, PreparedSearchItem<Channel>[]>();
  private indexedChannels: Channel[] | null = null;
  private indexedChannelCount = -1;
  private searchIndexedChannels: Channel[] | null = null;
  private searchIndexedChannelCount = -1;
  private includeHidden = false;

  get allSourcesDisabled(): boolean {
    const sources = StorageService.getPlaylists();
    return sources.length > 0 && !sources.some(isSourceEnabled);
  }

  /**
   * Clear all in-memory state. Called when the user removes every configured
   * playlist so stale channels do not survive navigation back to the channel
   * list view.
   */
  reset(): void {
    this.allChannels = [];
    this.channels = [];
    this.groups = [];
    this.groupsRevision++;
    this.playlistTabs = [];
    this.epgSources = [];
    this.indexMap = new Map();
    this.channelsByGroup = new Map();
    this.channelsByContentKind = new Map();
    this.channelsByPlaylist = new Map();
    this.channelsByPlaylistGroup = new Map();
    this.groupsByPlaylist = new Map();
    this.groupKeyByDisplay = new Map();
    this.channelByKey = new Map();
    this.channelByLegacyKey = new Map();
    this.channelSearchIndex = [];
    this.channelSearchByPlaylist = new Map();
    this.indexedChannels = null;
    this.indexedChannelCount = -1;
    this.searchIndexedChannels = null;
    this.searchIndexedChannelCount = -1;
  }

  async load(): Promise<Channel[]> {
    const enabledSources = StorageService.getPlaylists().filter(isSourceEnabled);
    const enabledIds = new Set(enabledSources.map(source => source.id));
    const xtreamIds = new Set(enabledSources
      .filter(source => source.source === 'xtream')
      .map(source => source.id));
    if (!enabledIds.size) {
      this.reset();
      this.logLoadCompleted('none', 0, 0);
      return [];
    }
    // A configured M3U source is manually refreshed by default. Keep its last
    // successful snapshot at startup until the user explicitly asks for a refresh.
    const cached = await getCachedPlaylist(true);
    if (cached) {
      let compactedXtreamEntries = 0;
      let channelsChanged = false;
      const filteredChannels: Channel[] = [];
      for (const channel of cached.channels) {
        const keepXtreamMembership = isXtreamLiveEntry(channel);
        const playlistIds = channel.playlistIds.filter(id =>
          enabledIds.has(id) && (!xtreamIds.has(id) || keepXtreamMembership));
        if (playlistIds.length !== channel.playlistIds.length) {
          channelsChanged = true;
          if (!keepXtreamMembership
              && channel.playlistIds.some(id => xtreamIds.has(id))) {
            compactedXtreamEntries++;
          }
        }
        if (!playlistIds.length) continue;
        filteredChannels.push(playlistIds.length === channel.playlistIds.length
          ? channel
          : { ...channel, playlistIds });
      }
      this.allChannels = channelsChanged ? filteredChannels : cached.channels;
      const epgSourcesNeedFiltering = cached.epgSources
        .some(source => source.playlistIds.some(id => !enabledIds.has(id)));
      this.epgSources = epgSourcesNeedFiltering
        ? cached.epgSources
            .map(source => ({
              ...source,
              playlistIds: source.playlistIds.filter(id => enabledIds.has(id)),
            }))
            .filter(source => source.playlistIds.length > 0)
        : cached.epgSources;
      log.info('Cache hit:', this.allChannels.length, 'channels,', this.epgSources.length, 'epg sources');
      if (compactedXtreamEntries) {
        log.info(
          'Compacted non-live Xtream entries from the startup cache',
          'event=xtream.playlist.cache.compacted',
          `entries=${compactedXtreamEntries}`,
        );
        scheduleCachedPlaylist(this.allChannels, this.epgSources);
      }
      this.applyCustomization();
      this.buildPlaylistTabs();
      StorageService.migrateFavoriteKeys(this.channels);
      this.logLoadCompleted('cache', enabledIds.size, 0);
      return this.channels;
    }
    log.info('Refreshing playlist sources after a cache miss');
    return this.refresh();
  }

  async refresh(): Promise<Channel[]> {
    return (await this.refreshWithReport()).channels;
  }

  async refreshWithReport(
    onProgress?: (progress: PlaylistRefreshProgress) => void,
  ): Promise<PlaylistRefreshReport> {
    return this.refreshConfiguredSources(undefined, onProgress);
  }

  async refreshSources(
    sourceIds: readonly string[],
    onProgress?: (progress: PlaylistRefreshProgress) => void,
  ): Promise<PlaylistRefreshReport> {
    return this.refreshConfiguredSources(sourceIds, onProgress);
  }

  private async refreshConfiguredSources(
    sourceIds: readonly string[] | undefined,
    onProgress?: (progress: PlaylistRefreshProgress) => void,
  ): Promise<PlaylistRefreshReport> {
    const done = log.time('refresh');
    const allConfigured = StorageService.getPlaylists().filter(isSourceEnabled);
    let playlists = allConfigured;
    let skippedPlaylists: PlaylistEntry[] = [];
    if (sourceIds) {
      const requestedIds = Array.from(new Set(sourceIds));
      const configuredById = new Map(allConfigured.map(source => [source.id, source]));
      const unavailableIds = requestedIds.filter(id => !configuredById.has(id));
      if (!requestedIds.length || unavailableIds.length) {
        throw new Error(!requestedIds.length
          ? 'No playlist sources requested'
          : `Playlist sources unavailable: ${unavailableIds.join(', ')}`);
      }
      playlists = requestedIds.map(id => configuredById.get(id)!);
      const requestedSet = new Set(requestedIds);
      skippedPlaylists = allConfigured.filter(source => !requestedSet.has(source.id));
    }
    if (!playlists.length) {
      log.info('No playlist sources enabled');
      this.reset();
      this.logLoadCompleted('none', 0, 0);
      done();
      return {
        channels: [],
        sourceCount: 0,
        failedSourceIds: [],
        restoredSourceIds: [],
      };
    }

    const allChannels: Channel[] = [];
    const byUrl = new Map<string, Channel>();
    const epgSources: EpgSource[] = [];
    const previousChannelsByPlaylist = new Map<string, Channel[]>();
    const previousEpgSourcesByPlaylist = new Map<string, EpgSource[]>();
    for (const channel of this.allChannels) {
      for (const playlistId of channel.playlistIds) {
        this.appendIndexed(previousChannelsByPlaylist, playlistId, channel);
      }
    }
    for (const source of this.epgSources) {
      for (const playlistId of source.playlistIds) {
        this.appendIndexed(previousEpgSourcesByPlaylist, playlistId, source);
      }
    }
    const failedPlaylistIds = new Set<string>();
    const catalogCacheRestoredIds = new Set<string>();
    let failedPlaylists = 0;
    let completedPlaylists = 0;
    const reportProgress = (
      phase: PlaylistRefreshProgress['phase'],
      sourceId?: string,
    ): void => onProgress?.({
      completed: completedPlaylists,
      total: playlists.length,
      phase,
      ...(sourceId ? { sourceId } : {}),
    });
    const addEpgSource = (url: string, playlistId: string, kind: EpgSource['kind']): void => {
      const existing = epgSources.find((source) => source.url === url);
      if (existing) {
        if (!existing.playlistIds.includes(playlistId)) existing.playlistIds.push(playlistId);
        return;
      }
      epgSources.push({ url, playlistIds: [playlistId], kind });
    };

    for (const pl of playlists) {
      // Tag channels by the playlist's stable id, not its name or position, so
      // two playlists sharing a name/URL stay distinct and deleting/reordering
      // one never re-points another's channels.
      const plKey = pl.id;
      // An xtream account derives get.php (playlist) and xmltv.php (EPG) from its
      // credentials; everything downstream is the existing M3U path.
      let fetchUrl = pl.url;
      let xtreamCredentials: XtreamCredentials | null = null;
      let xtreamOutput: XtreamLiveOutput = 'ts';
      if (pl.source === 'xtream' && pl.xtream) {
        const credentials = { baseUrl: pl.url, ...pl.xtream };
        xtreamCredentials = credentials;
        let allowedOutputFormats: string[] = [];
        if (pl.xtream.liveOutput === 'auto') {
          allowedOutputFormats =
            (await createXtreamClient(credentials).getAccountInfo())?.allowedOutputFormats ?? [];
        }
        xtreamOutput = resolveXtreamLiveOutput(pl.xtream.liveOutput, allowedOutputFormats);
        fetchUrl = xtreamPlaylistUrl(
          credentials,
          xtreamOutput,
        );
      }
      const plDone = log.time(`fetch '${pl.name || pl.url}'`);
      try {
        let parsed: ParsedPlaylist | null = null;
        let playlistError: unknown;
        try {
          reportProgress('download', plKey);
          const buffer = await fetchPlaylistBytes(fetchUrl, 60000);
          log.info('Fetched', pl.name || pl.url, '|', buffer.byteLength, 'bytes');
          reportProgress('parse', plKey);
          parsed = await parseM3UOffThread(buffer, fetchUrl);
        } catch (err) {
          playlistError = err;
          if (!xtreamCredentials) throw err;
          log.warn(
            'Xtream playlist failed; trying the Player API live catalog',
            'event=xtream.live_fallback.used',
            'reason=request_failed',
          );
        }

        let fallbackStreams: XtreamLiveStream[] | undefined;
        if (xtreamCredentials) {
          const hasLivePlaylistEntries = parsed?.channels.some(isXtreamLiveEntry) ?? false;
          if (!hasLivePlaylistEntries) {
            log.warn(
              'Xtream playlist contained no live channels; trying the Player API live catalog',
              'event=xtream.live_fallback.used',
              `reason=${parsed?.channels.length ? 'no_live_channels' : parsed ? 'no_channels' : 'request_failed'}`,
            );
            try {
              const client = createXtreamClient(xtreamCredentials);
              const [categories, streams] = await Promise.all([
                client.getLiveCategories(),
                client.getLiveStreams(),
              ]);
              fallbackStreams = streams;
              log.info(
                'Xtream Player API live catalog completed',
                'event=xtream.live_api.completed',
                `categories=${categories.length}`,
                `streams=${streams.length}`,
              );
              if (streams.length) {
                parsed = xtreamLivePlaylist(
                  xtreamCredentials,
                  xtreamOutput,
                  categories,
                  streams,
                );
              }
            } catch (err) {
              if (!parsed || !parsed.channels.length) throw playlistError ?? err;
              log.warn(
                'Xtream Player API live catalog unavailable; keeping get.php channels',
                'event=xtream.live_api.fallback',
                err,
              );
            }
          }
          if ((!parsed || !parsed.channels.length) && playlistError) throw playlistError;
        }
        if (!parsed) throw new Error('Xtream source returned no playlist or live catalog');

        if (xtreamCredentials) {
          const parsedCount = parsed.channels.length;
          parsed.channels = parsed.channels.filter(isXtreamLiveEntry);
          parsed.groups = Array.from(new Set(parsed.channels.map(channel => channel.group)));
          const omitted = parsedCount - parsed.channels.length;
          if (omitted) {
            log.info(
              'Omitted non-live entries from the Xtream channel playlist',
              'event=xtream.playlist.non_live_omitted',
              `entries=${omitted}`,
            );
          }
        }

        reportProgress('merge', plKey);

        if (pl.source !== 'xtream') {
          for (const kind of ['movie', 'series', 'other'] as const) {
            void setCachedM3uCatalog(pl, kind, parsed.channels).catch(err => log.warn(
              'M3U catalog cache write failed',
              'event=m3u.catalog.cache.write.failed',
              `source=${plKey}`,
              `kind=${kind}`,
              err,
            ));
          }
        }

        if (xtreamCredentials) {
          await this.applyXtreamCatchup(
            parsed.channels,
            xtreamCredentials,
            plKey,
            xtreamOutput,
            fallbackStreams,
          );
        }
        if (parsed.issues.length) {
          log.warn('Playlist diagnostics:',
            parsed.issues.slice(0, 5).map(issue => `${issue.code}@${issue.line}`).join(', '));
        }
        log.info('Parsed', parsed.channels.length, 'channels,', parsed.groups.length, 'groups',
          parsed.epgUrl ? `| epg: ${parsed.epgUrl}` : '');
        let added = 0, dupes = 0;
        for (const ch of parsed.channels) {
          const existing = byUrl.get(ch.url);
          if (existing) {
            // Same stream in an earlier playlist: keep the one channel object
            // (so "All" stays de-duplicated), but record this playlist too so
            // its own tab still appears and shows the channel.
            if (!existing.playlistIds.includes(plKey)) existing.playlistIds.push(plKey);
            dupes++;
          } else {
            ch.playlistIds = [plKey];
            byUrl.set(ch.url, ch);
            allChannels.push(ch);
            added++;
          }
        }
        log.debug(`Added ${added} channels (${dupes} duplicates skipped)`);
        if (pl.source === 'xtream' && pl.xtream) {
          // The panel's own XMLTV endpoint; the get.php url-tvg (if any) is added below too.
          const epg = xtreamEpgUrl({ baseUrl: pl.url, ...pl.xtream });
          addEpgSource(epg, plKey, 'xtream');
        }
        for (const parsedEpgUrl of parsed.epgUrls) {
          // Resolve localhost/127.0.0.1 in embedded EPG URL to the playlist's host
          let epg = parsedEpgUrl;
          try {
            const epgParsed = new URL(epg);
            if (epgParsed.hostname === 'localhost' || epgParsed.hostname === '127.0.0.1') {
              const plParsed = new URL(pl.url);
              epgParsed.hostname = plParsed.hostname;
              epg = epgParsed.toString();
              log.info('Rewrote loopback EPG host to', epgParsed.hostname);
            }
          } catch (e) { log.warn('Could not parse EPG URL:', epg, e); }
          addEpgSource(epg, plKey, 'm3u');
        }
      } catch (err) {
        failedPlaylists++;
        failedPlaylistIds.add(plKey);
        if (pl.source !== 'xtream' && !previousChannelsByPlaylist.has(plKey)) {
          const cachedCatalogs = await Promise.all(
            (['movie', 'series', 'other'] as const)
              .map(kind => getCachedM3uCatalog(pl, kind)),
          );
          const cachedChannels = cachedCatalogs
            .filter((catalog): catalog is Channel[] => catalog !== null)
            .reduce((channels, catalog) => channels.concat(catalog), []);
          if (cachedChannels.length) {
            previousChannelsByPlaylist.set(plKey, cachedChannels);
            catalogCacheRestoredIds.add(plKey);
            log.warn(
              'Restoring M3U catalog cache after refresh failure',
              'event=m3u.catalog.cache.restored',
              `source=${plKey}`,
              `channels=${cachedChannels.length}`,
            );
          }
        }
        if (pl.source === 'xtream') {
          log.error(
            `Failed to load Xtream playlist '${pl.name || pl.url}'`,
            'event=xtream.playlist.load.failed',
            err,
          );
        } else {
          log.error(`Failed to load playlist '${pl.name || pl.url}':`, err);
        }
      }
      plDone();
      completedPlaylists++;
    }

    const playlistRanks = new Map(allConfigured.map((playlist, index) => [playlist.id, index]));
    let restoredPlaylists = 0;
    const restoreSource = (playlistId: string): boolean => {
      const previousChannels = previousChannelsByPlaylist.get(playlistId) ?? [];
      const previousSources = previousEpgSourcesByPlaylist.get(playlistId) ?? [];
      if (!previousChannels.length && !previousSources.length) return false;
      for (const previous of previousChannels) {
        const existing = byUrl.get(previous.url);
        if (existing) {
          const existingRank = existing.playlistIds.reduce(
            (rank, id) => Math.min(rank, playlistRanks.get(id) ?? rank),
            Infinity,
          );
          const restoredRank = playlistRanks.get(playlistId) ?? Infinity;
          if (!existing.playlistIds.includes(playlistId)) existing.playlistIds.push(playlistId);
          if (restoredRank < existingRank) {
            const restored = { ...previous, playlistIds: existing.playlistIds.slice() };
            const index = allChannels.indexOf(existing);
            if (index >= 0) allChannels[index] = restored;
            byUrl.set(restored.url, restored);
          }
        } else {
          const restored = { ...previous, playlistIds: [playlistId] };
          byUrl.set(restored.url, restored);
          allChannels.push(restored);
        }
      }
      for (const previous of previousSources) {
        addEpgSource(previous.url, playlistId, previous.kind);
      }
      return true;
    };
    for (const skipped of skippedPlaylists) restoreSource(skipped.id);
    for (const playlistId of failedPlaylistIds) {
      if (!restoreSource(playlistId)) continue;
      restoredPlaylists++;
      const previousChannels = previousChannelsByPlaylist.get(playlistId) ?? [];
      log.warn(
        'Using last successful playlist data after refresh failure',
        'event=playlist.refresh.stale_used',
        `source=${playlistId}`,
        `channels=${previousChannels.length}`,
      );
    }

    for (const channel of allChannels) {
      channel.playlistIds.sort((a, b) => (playlistRanks.get(a) ?? 0) - (playlistRanks.get(b) ?? 0));
    }
    const orderedChannels = allChannels.map((channel, index) => ({
      channel,
      index,
      rank: channel.playlistIds.reduce(
        (rank, id) => Math.min(rank, playlistRanks.get(id) ?? rank),
        Infinity,
      ),
    })).sort((a, b) => a.rank - b.rank || a.index - b.index);
    allChannels.splice(0, allChannels.length, ...orderedChannels.map(entry => entry.channel));

    this.allChannels = allChannels;
    this.epgSources = epgSources;
    // Cache the raw parse: customization is a view over it, so an edit re-sorts
    // memory instead of forcing a re-fetch.
    reportProgress('cache');
    if (!failedPlaylists
        || (restoredPlaylists === failedPlaylists && !catalogCacheRestoredIds.size)) {
      scheduleCachedPlaylist(allChannels, epgSources);
    } else {
      log.warn('Skipping cache write because one or more playlists failed');
    }
    this.applyCustomization();
    this.buildPlaylistTabs();
    StorageService.migrateFavoriteKeys(this.channels);
    log.info('Refresh complete:', allChannels.length, 'total channels,', epgSources.length, 'epg sources');
    this.logLoadCompleted('network', playlists.length, failedPlaylists);
    done();
    return {
      channels: this.channels,
      sourceCount: playlists.length,
      failedSourceIds: Array.from(failedPlaylistIds),
      restoredSourceIds: Array.from(failedPlaylistIds)
        .filter(playlistId => previousChannelsByPlaylist.has(playlistId)
          || previousEpgSourcesByPlaylist.has(playlistId)),
    };
  }

  /**
   * One structured line per load so a diagnostics report can tie an empty
   * channel list to the sources that produced it — the rendered list is
   * virtualized, so its DOM row count says nothing about the catalog.
   */
  private logLoadCompleted(
    source: 'cache' | 'network' | 'none',
    sources: number,
    failed: number,
  ): void {
    const level = failed || (sources && !this.channels.length) ? 'warn' : 'info';
    log[level](
      'Playlist load completed',
      'event=playlist.load.completed',
      `source=${source}`,
      `channels=${this.channels.length}`,
      `all=${this.allChannels.length}`,
      `groups=${this.groups.length}`,
      `epg=${this.epgSources.length}`,
      `sources=${sources}`,
      `failed=${failed}`,
    );
  }

  private async applyXtreamCatchup(
    channels: Channel[],
    credentials: XtreamCredentials,
    accountId: string,
    output: XtreamLiveOutput,
    knownStreams?: XtreamLiveStream[],
  ): Promise<void> {
    const client = createXtreamClient(credentials);
    const streams = knownStreams ?? await client.getLiveStreams();
    const archived = new Map(streams
      .filter(stream => stream.archive)
      .map(stream => [stream.streamId, stream]));
    if (!archived.size) return;

    const clock = await client.getServerClock();
    const knownIds = new Set(streams.map(stream => stream.streamId));
    const streamByDirectSource = new Map(streams
      .filter(stream => usableDirectSource(stream.directSource))
      .map(stream => [stableStreamUrl(stream.directSource), stream]));
    let enabled = 0;
    let unmatched = 0;
    for (const channel of channels) {
      const extractedId = channel.catchupStreamId || xtreamLiveStreamId(channel.url, knownIds);
      const streamId = (extractedId && knownIds.has(extractedId) ? extractedId : '')
        || streamByDirectSource.get(stableStreamUrl(channel.url))?.streamId
        || '';
      const stream = archived.get(streamId);
      if (!stream) {
        if (!streamId) unmatched++;
        continue;
      }
      channel.catchupStreamId = streamId;
      channel.catchupAccountId = accountId;
      if (!channel.catchupSource) {
        const sources = xtreamCatchupSources(credentials, streamId, output);
        channel.catchup = 'xtream';
        channel.catchupSource = sources[0].url;
        channel.catchupFallbackSource = sources[3].url;
        channel.catchupSources = sources;
        channel.catchupDays = stream.archiveDurationDays;
        enabled++;
      }
      if (clock?.timeZone) channel.catchupTimeZone = clock.timeZone;
      if (clock?.offsetMinutes != null) channel.catchupTimeOffsetMinutes = clock.offsetMinutes;
    }
    log.info(
      'Xtream catch-up matching completed',
      'event=xtream.catchup.matched',
      `streams=${streams.length}`,
      `archived=${archived.size}`,
      `enabled=${enabled}`,
      `unmatched=${unmatched}`,
    );
    if (unmatched) {
      log.warn(
        'Xtream catch-up streams could not be matched',
        'event=xtream.catchup.unmatched',
        `channels=${unmatched}`,
      );
    }
  }

  /**
   * Rebuild `channels` from `allChannels` through the user's customization:
   * hidden channels drop out, the rest take the custom order, and renames and
   * group assignments are applied to the channel objects. Cheap enough to re-run
   * after every edit — no network, no re-parse.
   */
  applyCustomization(): void {
    const includeHidden = this.includeHidden || StorageService.getShowHiddenChannels();
    this.channels = ChannelCustomizationService.applyTo(this.allChannels, includeHidden);
    this.buildDerivedIndexes();
  }

  /** Edit mode reveals hidden channels so they can be un-hidden again. */
  setIncludeHidden(include: boolean): void {
    if (this.includeHidden === include) return;
    this.includeHidden = include;
    this.applyCustomization();
  }

  private buildDerivedIndexes(): void {
    const groupSet = new Set<string>();
    const groupSetsByPlaylist = new Map<string, Set<string>>();
    this.indexMap = new Map();
    this.channelsByGroup = new Map();
    this.channelsByContentKind = new Map();
    this.channelsByPlaylist = new Map();
    this.channelsByPlaylistGroup = new Map();
    this.groupKeyByDisplay = new Map();
    this.channelByKey = new Map();
    this.channelByLegacyKey = new Map();
    this.channelSearchIndex = [];
    this.channelSearchByPlaylist = new Map();
    this.searchIndexedChannels = null;
    this.searchIndexedChannelCount = -1;

    for (const key of ChannelCustomizationService.customGroups) {
      this.groupKeyByDisplay.set(ChannelCustomizationService.groupLabel(key), key);
    }

    for (let i = 0; i < this.channels.length; i++) {
      const ch = this.channels[i];
      this.indexMap.set(ch, i);
      this.channelByKey.set(channelKey(ch), ch);
      const legacyKey = legacyChannelKey(ch);
      this.channelByLegacyKey.set(
        legacyKey,
        this.channelByLegacyKey.has(legacyKey) ? null : ch,
      );
      if (ch.group) {
        groupSet.add(ch.group);
        if (!this.groupKeyByDisplay.has(ch.group)) {
          this.groupKeyByDisplay.set(ch.group, groupKeyOf(ch));
        }
        this.appendIndexed(this.channelsByGroup, ch.group, ch);
      }
      const contentKind = ch.contentKind ?? m3uContentKind(ch.sourceGroup ?? ch.group);
      ch.contentKind = contentKind;
      this.appendIndexed(this.channelsByContentKind, contentKind, ch);
      for (const playlistId of ch.playlistIds) {
        this.appendIndexed(this.channelsByPlaylist, playlistId, ch);
        if (!ch.group) continue;
        let byGroup = this.channelsByPlaylistGroup.get(playlistId);
        if (!byGroup) {
          byGroup = new Map();
          this.channelsByPlaylistGroup.set(playlistId, byGroup);
        }
        this.appendIndexed(byGroup, ch.group, ch);
        let playlistGroups = groupSetsByPlaylist.get(playlistId);
        if (!playlistGroups) {
          playlistGroups = new Set();
          groupSetsByPlaylist.set(playlistId, playlistGroups);
        }
        playlistGroups.add(ch.group);
      }
    }
    for (const key of ChannelCustomizationService.customGroups) {
      const label = ChannelCustomizationService.groupLabel(key);
      groupSet.add(label);
      this.groupKeyByDisplay.set(label, key);
    }
    this.groups = this.orderGroups(Array.from(groupSet));
    this.groupsByPlaylist = new Map();
    groupSetsByPlaylist.forEach((playlistGroups, playlistId) => {
      this.groupsByPlaylist.set(playlistId, this.orderGroups(Array.from(playlistGroups)));
    });
    this.indexedChannels = this.channels;
    this.indexedChannelCount = this.channels.length;
    this.groupsRevision++;
  }

  private appendIndexed<T>(map: Map<string, T[]>, key: string, channel: T): void {
    const existing = map.get(key);
    if (existing) existing.push(channel);
    else map.set(key, [channel]);
  }

  private ensureDerivedIndexes(): void {
    if (this.indexedChannels !== this.channels || this.indexedChannelCount !== this.channels.length) {
      this.buildDerivedIndexes();
    }
  }

  private ensureLocalSearchIndexes(): void {
    this.ensureDerivedIndexes();
    if (this.searchIndexedChannels === this.channels
        && this.searchIndexedChannelCount === this.channels.length) return;
    this.channelSearchIndex = [];
    this.channelSearchByPlaylist = new Map();
    for (const channel of this.channels) {
      const searchItem = prepareSearchItem(
        channel,
        item => [item.name, item.group, item.sourceName ?? ''],
      );
      this.channelSearchIndex.push(searchItem);
      for (const playlistId of channel.playlistIds) {
        this.appendIndexed(this.channelSearchByPlaylist, playlistId, searchItem);
      }
    }
    this.searchIndexedChannels = this.channels;
    this.searchIndexedChannelCount = this.channels.length;
  }

  /** Sort display group names into the custom group order (keyed by group key). */
  private orderGroups(displayNames: string[]): string[] {
    return displayNames
      .map((name, index) => ({
        name,
        rank: ChannelCustomizationService.groupRank(
          this.groupKeyByDisplay.get(name) ?? name,
          index,
        ),
        index,
      }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.name);
  }

  private buildPlaylistTabs(): void {
    // One tab per configured playlist, in config order, keyed by its stable id —
    // including a playlist that loaded zero channels (empty/unreachable feed), so
    // it stays visible. Derived from the registry, not the cached channels, so a
    // stale/desynced channel cache can never blank out the tab bar.
    const configured = StorageService.getPlaylists().filter(isSourceEnabled);
    this.playlistTabs = configured.map(pl => ({ id: pl.id, name: pl.name || pl.url }));
  }

  getByGroup(group: ChannelGroupId, playlist?: string): Channel[] {
    this.ensureDerivedIndexes();
    const all = playlist ? this.channelsByPlaylist.get(playlist) ?? [] : this.channels;
    if (group === 'builtin:all' || group === 'builtin:recently-watched') return all;
    if (group === 'builtin:favorites') {
      const favorites = StorageService.getFavorites()
        .map(key => this.channelByKey.get(key))
        .filter((channel): channel is Channel =>
          !!channel && (!playlist || channel.playlistIds.includes(playlist)));
      favorites.sort((a, b) => this.indexOf(a) - this.indexOf(b));
      return favorites;
    }
    const sourceGroup = group.slice('source:'.length);
    return playlist
      ? this.channelsByPlaylistGroup.get(playlist)?.get(sourceGroup) ?? []
      : this.channelsByGroup.get(sourceGroup) ?? [];
  }

  getByContentKind(kind: M3uContentKind, playlist?: string): Channel[] {
    this.ensureDerivedIndexes();
    const entries = this.channelsByContentKind.get(kind) ?? [];
    return playlist
      ? entries.filter(channel => channel.playlistIds.includes(playlist))
      : entries;
  }

  getContentKindCount(kind: M3uContentKind, playlist?: string): number {
    return this.getByContentKind(kind, playlist).length;
  }

  getGroupCount(group: ChannelGroupId, playlist?: string): number {
    this.ensureDerivedIndexes();
    if (group === 'builtin:all' || group === 'builtin:recently-watched') {
      return playlist ? this.channelsByPlaylist.get(playlist)?.length ?? 0 : this.channels.length;
    }
    if (group === 'builtin:favorites') return this.getByGroup(group, playlist).length;
    const sourceGroup = group.slice('source:'.length);
    return playlist
      ? this.channelsByPlaylistGroup.get(playlist)?.get(sourceGroup)?.length ?? 0
      : this.channelsByGroup.get(sourceGroup)?.length ?? 0;
  }

  searchLocalRanked(
    query: string,
    limit: number,
    playlist?: string,
  ): RankedSearchResult<Channel> {
    if (!query.trim()) return { items: [], hasMore: false };
    this.ensureLocalSearchIndexes();
    const index = playlist
      ? this.channelSearchByPlaylist.get(playlist) ?? []
      : this.channelSearchIndex;
    return rankPreparedTopK(index, query, limit);
  }

  getGroupsForPlaylist(playlist?: string): string[] {
    this.ensureDerivedIndexes();
    return (playlist ? this.groupsByPlaylist.get(playlist) ?? [] : this.groups).slice();
  }

  getGroupKeyForDisplay(display: string): string {
    this.ensureDerivedIndexes();
    return this.groupKeyByDisplay.get(display) ?? display;
  }

  getByIndex(index: number): Channel | null {
    return this.channels[index] ?? null;
  }

  indexOf(channel: Channel): number {
    return this.indexMap.get(channel) ?? -1;
  }

  resolveChannelKey(key: string): { channel: Channel; channelIndex: number } | null {
    const channel = this.channelByKey.get(key) ?? this.channelByLegacyKey.get(key);
    if (!channel) return null;
    const channelIndex = this.indexOf(channel);
    return channelIndex < 0 ? null : { channel, channelIndex };
  }

  /** Index of the channel carrying this per-stream key, or -1. Used to re-resolve
   *  the playing channel after a customization changes the ordering. */
  indexOfKey(key: string): number {
    if (!key) return -1;
    for (let i = 0; i < this.channels.length; i++) {
      if (channelKey(this.channels[i]) === key) return i;
    }
    return -1;
  }

  private indexOfUniqueKey(key: string): number {
    let match = -1;
    for (let i = 0; i < this.channels.length; i++) {
      const channel = this.channels[i];
      if (channelKey(channel) !== key && legacyChannelKey(channel) !== key) continue;
      if (match >= 0) return -1;
      match = i;
    }
    return match;
  }

  resolveLastChannelIndex(stableKey: string, legacyIndex: number): number {
    if (!stableKey) return legacyIndex;
    return this.indexOfUniqueKey(stableKey);
  }
}

export const PlaylistService = new PlaylistServiceImpl();
