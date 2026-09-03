import './polyfills';
import { CONFIG } from './config';
import { KeyHandler } from './navigation/key-handler';
import { ViewNavigator } from './navigation/view-navigator';
import { PlaylistService } from './services/playlist-service';
import { EpgService } from './services/epg-service';
import { ChannelHealthService } from './services/channel-health';
import { StorageService } from './services/storage-service';
import {
  clearAllCachedData,
  flushCacheWrites,
} from './services/idb-cache';
import { SetupClient } from './services/setup-client';
import { BackupClient } from './services/backup-client';
import { setServicePort } from './services/service-http';
import { isLunaAvailable, lunaRequest, type LunaRequestHandle } from './services/luna';
import { ChannelList } from './components/channel-list';
import { Player } from './components/player';
import { EpgGrid } from './components/epg-grid';
import { Settings, type SaveAction } from './components/settings';
import { Sidebar } from './components/sidebar';
import { PlayerMenu } from './components/player-menu';
import { TabBar, type Section, sectionForView } from './components/tab-bar';
import { Movies } from './components/movies';
import { Series } from './components/series';
import { M3uCatalog } from './components/m3u-catalog';
import { Search } from './components/search';
import { Home, type HomeAction, type HomeItem, type HomeState } from './components/home';
import { showToast } from './components/toast';
import { showNumberEntry, hideNumberEntry } from './components/number-entry';
import { ReminderService } from './services/reminder-service';
import { RecentlyWatchedService } from './services/recently-watched';
import { ReminderPrompt } from './components/reminder-prompt';
import { ReminderManager } from './components/reminder-manager';
import { setDisplayTz } from './utils/time';
import { initTheme, applyTheme, applyOverlayStyle, applyTextSize } from './services/theme-service';
import { channelKey } from './utils/channel';
import { m3uAccountId, m3uItemKey } from './utils/m3u-item';
import { isSourceEnabled } from './utils/playlist';
import { xtreamEpisodeUrl, xtreamVodUrl } from './utils/xtream-url';
import {
  availableCatalogSources,
  catalogSourceKey,
  parseCatalogSource,
  resolveCatalogSource,
  type CatalogSection,
  type CatalogSource,
} from './utils/catalog-source';
import { truncate } from './utils/text';
import { $, show, hide } from './utils/dom';
import { createLogger, installGlobalErrorHandlers, logEnvironment } from './utils/logger';
import { Telemetry } from './services/telemetry';
import type {
  Action,
  ActionEvent,
  CatchupInfo,
  Channel,
  EpgSource,
  PlaylistEntry,
  ResumeEntry,
  WatchlistEntry,
} from './types';
import { getLocale, initLocale, resolveLocale, setLocale, t, tp } from './i18n';
import {
  refreshXtreamAccountStatus,
  XTREAM_ACCOUNT_STATUS_EVENT,
} from './services/xtream-account-status';

const log = createLogger('App');

type ViewName = 'home' | 'channels' | 'player' | 'epg' | 'settings' | 'reminders'
  | 'loading' | 'movies' | 'series' | 'search';

class App {
  private views!: Record<ViewName, HTMLElement>;
  private navigator = new ViewNavigator<ViewName>('home');
  private backPressTime = 0;
  private viewBeforeSearch: ViewName | null = null;
  private epgOrigin: ViewName = 'home';
  private settingsOrigin: ViewName = 'home';
  private channelList!: ChannelList;
  private home!: Home;
  private player!: Player;
  private epgGrid!: EpgGrid;
  private settings!: Settings;
  private sidebar!: Sidebar;
  private menu!: PlayerMenu;
  private reminderPrompt = new ReminderPrompt();
  private reminderManager!: ReminderManager;
  private reminderManagerOrigin: 'home' | 'settings' | 'epg' = 'settings';
  private tabBar!: TabBar;
  private search!: Search;
  private movies!: Movies;
  private series!: Series;
  private m3uMovies!: M3uCatalog;
  private m3uSeries!: M3uCatalog;
  private m3uCatalogSection: 'movies' | 'series' | null = null;
  private lastSearchQuery = '';
  private loadChannelsAfterUploadSync = false;
  private remindersInitialized = false;
  private bundledServiceStarting = false;
  private serviceEventsSubscription: LunaRequestHandle | null = null;
  private deviceSetupSync = Promise.resolve();
  private epgRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private dataRefreshPromise: Promise<import('./components/settings').SettingsRefreshResult> | null = null;

  async init(): Promise<void> {
    const done = log.time('init');
    log.info('Initializing app');
    await StorageService.init();
    initLocale(StorageService.getLocalePreference());
    const initialLoadingText = $('#loading-text');
    if (initialLoadingText) initialLoadingText.textContent = t('common.loading');
    initTheme();
    this.views = {
      home: $('#view-home')!,
      channels: $('#view-channels')!,
      player: $('#view-player')!,
      epg: $('#view-epg')!,
      settings: $('#view-settings')!,
      reminders: $('#view-reminders')!,
      movies: $('#view-movies')!,
      series: $('#view-series')!,
      search: $('#view-search')!,
      loading: $('#view-loading')!,
    };

    this.channelList = new ChannelList(
      this.views.channels,
      (idx, catchup) => this.playChannel(idx, catchup),
      () => this.player.syncCurrentIndex(),
      () => {
        const sources = this.epgSources();
        if (!sources.length) return;
        void EpgService.load(
          sources,
          PlaylistService.allChannels,
          undefined,
          () => this.refreshEpgDependentViews(),
        )
          .then(() => {
            this.refreshEpgDependentViews();
          })
          .catch(err => log.error('EPG mapping reload failed:', err));
      },
      () => {
        void this.search.refreshPrograms();
      },
    );
    this.home = new Home(this.views.home, {
      onAction: (action) => this.handleHomeAction(action),
      onItem: (item) => this.handleHomeItem(item),
      onBack: () => this.requestExit(),
    });
    this.player = new Player(
      this.views.player,
      () => {
        this.channelList.render();
        this.goBack('channels');
      },
      (idx, catchupStart) => this.channelList.setPlaying(idx, catchupStart),
      () => !this.sidebar.visible && !this.menu.visible,
      () => {
        this.sidebar.refresh();
      },
      () => this.menu.show(),
    );
    this.epgGrid = new EpgGrid(
      this.views.epg,
      (idx, catchup) => this.playChannel(idx, catchup),
      () => this.tabBar.focus(),
      () => this.openReminderManager('epg'),
    );
    this.reminderManager = new ReminderManager(this.views.reminders, () => {
      if (this.reminderManagerOrigin === 'epg') {
        this.goBackTo('epg');
        this.epgGrid.focusReminderEntry();
      } else if (this.reminderManagerOrigin === 'home') {
        this.goHome();
      } else {
        this.goBackTo('settings');
        this.settings.focusReminderEntry();
      }
    });
    this.settings = new Settings(
      this.views.settings,
      (action) => this.onSettingsSaved(action),
      () => this.player.syncCurrentIndex(),
      () => this.openReminderManager('settings'),
      (onProgress, sourceIds) => this.refreshDataFromSettings(onProgress, sourceIds),
    );

    this.player.init($('#video-player') as HTMLVideoElement);

    this.sidebar = new Sidebar(
      this.views.player,
      () => this.player.getCurrentIndex(),
      (idx, catchup) => this.playChannel(idx, catchup),
      () => this.player.getCurrentCatchupStart(),
    );
    this.menu = new PlayerMenu(
      this.views.player,
      () => this.player.getCurrentChannel(),
      (action) => this.onMenuAction(action),
      () => this.player.getAudioTracks(),
      (index) => this.player.selectAudioTrack(index),
      () => this.player.getSubtitleTracks(),
      (index) => this.player.selectSubtitleTrack(index),
      () => this.player.subtitleOffsetState(),
      () => this.player.openSubtitleOffset(),
      () => this.player.getPlaybackDiagnostics(),
    );

    this.movies = new Movies(this.views.movies, {
      onRevealTabBar: () => this.tabBar.focus(),
      onBack: () => this.goHome(),
      onPlayVod: (req) => {
        this.navigateTo('player');
        this.player.playVod({
          ...req,
          onBack: () => {
            this.goBack('movies');
            this.movies.refreshPlaybackState();
          },
        });
      },
    });
    this.series = new Series(this.views.series, {
      onRevealTabBar: () => this.tabBar.focus(),
      onBack: () => this.goHome(),
      onPlayVod: (req) => {
        this.navigateTo('player');
        this.player.playVod({
          ...req,
          onBack: () => {
            this.goBack('series');
            this.series.refreshPlaybackState();
          },
        });
      },
    });
    this.m3uMovies = new M3uCatalog(this.views.movies, (channel, resume) => {
      this.playM3uVod(channel, resume, 'movies');
    }, () => this.refreshCatalogSource('movies'));
    this.m3uSeries = new M3uCatalog(this.views.series, (channel, resume) => {
      this.playM3uVod(channel, resume, 'series');
    }, () => this.refreshCatalogSource('series'));
    this.search = new Search(this.views.search, {
      onRevealTabBar: () => this.tabBar.focus(),
      onBack: () => this.goLive(),
      onPlayChannel: (idx, catchup) => { this.tabBar.blur(); this.playChannel(idx, catchup); },
      onOpenMovie: (account, vod) => {
        this.tabBar.blur();
        this.navigateTo('movies');
        this.movies.openItem(account, vod, () => this.goBack('search'))
          .catch((err) => log.error(
            'Open movie failed',
            'event=xtream.view.open.failed',
            'operation=movie_detail',
            err,
          ));
      },
      onOpenSeries: (account, series) => {
        this.tabBar.blur();
        this.navigateTo('series');
        this.series.openItem(account, series, () => this.goBack('search'))
          .catch((err) => log.error(
            'Open series failed',
            'event=xtream.view.open.failed',
            'operation=series_detail',
            err,
          ));
      },
      onPlayM3u: (channel) => this.playM3uVod(channel, true, 'search'),
    });
    this.tabBar = new TabBar({
      onSwitch: (section) => this.switchSection(section),
      onEnter: (section) => this.enterSection(section),
      onSearchQuery: (query) => this.handleSearchQuery(query),
      onSearchLeave: () => this.search.focusFirstResult(),
      onSearchClose: () => this.handleSearchClose(),
      onSelectAccount: (id) => this.selectXtreamAccount(id),
    });
    this.tabBar.init();
    window.addEventListener(XTREAM_ACCOUNT_STATUS_EVENT, () => this.syncAccountStatusViews());

    KeyHandler.init();
    KeyHandler.setHandler((action, event) => this.handleKey(action, event));
    KeyHandler.setChannelCount(() => PlaylistService.channels.length);

    this.initSidebarTrigger();

    done();
    this.loadChannelsAfterUploadSync = StorageService.getPlaylists().length === 0;
    this.bindBundledServiceLifecycle();
    this.bindReminderLifecycle();
    // Register a retail-safe callback immediately. If Developer Mode is
    // detected below, the same named activities are replaced with alerts.
    ReminderService.reschedulePending();
    await this.loadData();
    // Cold launch from a "Watch now" alert: channels are loaded now, so tune.
    this.handleLaunchParams(this.coldLaunchParams());
    // Spawning the service process can synchronously stall Luna on a cold TV.
    // Keep LAN setup off the critical path so cached channels render first.
    const bundledServiceReady = this.startBundledService();
    void bundledServiceReady
      .then((started) => started ? this.finishBundledServiceInit() : undefined)
      .catch(err => log.error('Bundled service initialization failed:', err));
  }

  /**
   * Tie the bundled service's lifetime to the app's foreground state. The
   * service holds an open LAN HTTP port and a Luna keepAlive activity, so we
   * stop it when the app is backgrounded (visibility → hidden) so neither
   * the port nor the service process lingers across the rest of webOS. On
   * visibility → visible we restart it and resubscribe.
   *
   * visibilitychange is reliable on this firmware (verified empirically; the
   * Player module's suspend/resume listens to the same event).
   */
  private bindBundledServiceLifecycle(): void {
    let lastVisibility = document.visibilityState;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === lastVisibility) return;
      lastVisibility = document.visibilityState;
      if (document.visibilityState === 'hidden') {
        void this.flushUserData('background');
        log.info('App backgrounded — stopping bundled service');
        this.stopBundledService();
      } else if (document.visibilityState === 'visible') {
        if (this.bundledServiceStarting) {
          log.info('App foregrounded while bundled service start is pending');
          return;
        }

        log.info('App foregrounded — restarting bundled service');
        void this.startBundledService()
          .then((started) => started ? this.finishBundledServiceInit() : undefined)
          .catch(err => log.error('Bundled service restart failed:', err));
      }
    });
  }

  private async flushUserData(reason: 'background' | 'exit'): Promise<boolean> {
    try {
      await Promise.all([StorageService.flush(), flushCacheWrites()]);
      log.info(
        'User data flush completed',
        'event=persistence.user.flush.completed',
        'operation=flush',
        `reason=${reason}`,
      );
      return true;
    } catch (err) {
      log.error(
        'User data flush failed',
        'event=persistence.user.flush.failed',
        'operation=flush',
        `reason=${reason}`,
        err,
      );
      return false;
    }
  }

  private async exitApp(): Promise<void> {
    if (!await this.flushUserData('exit')) {
      this.backPressTime = 0;
      showToast(t('app.saveFailed'));
      return;
    }
    this.stopBundledService();
    window.close();
  }

  private cancelServiceEventsSubscription(): void {
    if (!this.serviceEventsSubscription) return;
    try {
      this.serviceEventsSubscription.cancel();
    } catch (e) {
      log.warn('serviceEvents cancellation threw:', e);
    }
    this.serviceEventsSubscription = null;
  }

  /**
   * Fire-and-forget Luna call to gracefully shut down the bundled service.
   * The service closes its HTTP listener, releases its keepAlive activity,
   * and lets the Node process exit so neither the port nor the process
   * persists in the background.
   */
  private stopBundledService(): void {
    this.cancelServiceEventsSubscription();
    if (!isLunaAvailable()) {
      setServicePort(null);
      return;
    }
    try {
      lunaRequest(`luna://${CONFIG.SERVICE_ID}`, {
        method: 'stop',
        parameters: {},
        onSuccess: (resp: unknown) => log.info('Bundled service stop onSuccess:', JSON.stringify(resp)),
        onFailure: (err: unknown) => log.warn('Bundled service stop onFailure:', JSON.stringify(err)),
      });
    } catch (e) {
      log.warn('stopBundledService threw:', e);
    }
    // Forget the runtime port — next start will set it again via setServicePort.
    setServicePort(null);
  }

  /**
   * Ask the webOS Luna service bus to start the bundled webOS JS service
   * (see bundled-service/). On non-webOS environments (desktop preview, e2e)
   * this is a no-op — the bundled service is only available on device.
   *
   * We log onSuccess/onFailure explicitly so device logs (ares-inspect or
   * ares-monitor-log) show what happened, instead of guessing from silence.
   */
  private async startBundledService(): Promise<boolean> {
    if (this.bundledServiceStarting) return false;
    this.bundledServiceStarting = true;
    if (!isLunaAvailable()) {
      this.bundledServiceStarting = false;
      log.debug('webOS Luna service bus not available — skipping bundled service start');
      return false;
    }
    log.info('Calling luna://' + CONFIG.SERVICE_ID + '/start ...');
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (started: boolean, why: string): void => {
        if (settled) return;
        settled = true;
        this.bundledServiceStarting = false;
        log.info('startBundledService settled:', why);
        resolve(started);
      };
      const timer = setTimeout(() => finish(false, 'timeout after 3s'), 3000);
      // NOTE: no trailing '/' on the URI — the Luna client appends '/' + method,
      // so a trailing slash here produces 'luna://.../service//start' (double
      // slash) which Luna treats as a missing method and returns onFailure.
      try {
        lunaRequest(`luna://${CONFIG.SERVICE_ID}`, {
          method: 'start',
          parameters: {},
          onSuccess: (resp: unknown) => {
            clearTimeout(timer);
            const lateSuccess = settled;
            if (document.visibilityState === 'hidden') {
              log.info('Bundled service started after app was hidden — stopping it');
              this.stopBundledService();
              finish(false, 'stopped after app hidden');
              return;
            }
            if (resp && typeof resp === 'object' &&
                (resp as { running?: unknown }).running === false) {
              log.warn('Bundled service reported it is not running:', JSON.stringify(resp));
              finish(false, 'service reported not running');
              return;
            }
            if (resp && typeof resp === 'object' && 'port' in resp) {
              const p = (resp as { port?: unknown }).port;
              if (typeof p === 'number') setServicePort(p);
            }
            log.info('Bundled service start onSuccess:', JSON.stringify(resp));
            finish(true, 'onSuccess');
            if (lateSuccess) {
              void this.finishBundledServiceInit()
                .catch(err => log.error('Late bundled service initialization failed:', err));
            }
          },
          onFailure: (err: unknown) => {
            clearTimeout(timer);
            log.error('Bundled service start onFailure:', JSON.stringify(err));
            finish(false, 'onFailure');
          },
        });
      } catch (e) {
        clearTimeout(timer);
        log.error('Bundled service start threw:', e);
        finish(false, 'threw');
      }
    });
  }

  private async finishBundledServiceInit(): Promise<void> {
    if (document.visibilityState === 'hidden') return;
    this.subscribeToServiceEvents();
    if (!this.remindersInitialized) {
      const initialized = await this.queryDevMode();
      ReminderService.reschedulePending();
      this.remindersInitialized = initialized;
    }
    await this.queueDeviceSetupSync();
    void SetupClient.publishState();
    await BackupClient.publishArchive();
    if (await BackupClient.applyPendingImports()) {
      location.reload();
      return;
    }
    await this.settings.refreshSetupInfo();
    await this.settings.refreshUploads();
    await this.loadChannelsAfterFirstUpload();
  }

  private queueDeviceSetupSync(): Promise<void> {
    this.deviceSetupSync = this.deviceSetupSync
      .then(async () => {
        if (await SetupClient.applyPendingActions()) {
          await this.onSettingsSaved('reload');
        }
      })
      .catch(err => log.error('Device setup sync failed:', err));
    return this.deviceSetupSync;
  }

  private async loadChannelsAfterFirstUpload(): Promise<void> {
    if (this.loadChannelsAfterUploadSync &&
        StorageService.getPlaylists().length > 0) {
      this.loadChannelsAfterUploadSync = false;
      const current = this.navigator.current;
      await this.loadData(false, current);
    }
  }

  /**
   * Ask the bundled service whether Developer Mode is on. In dev mode reminders
   * fire an interactive system alert instead of the passive toast + in-app
   * prompt. Guarded: with no Luna bus (desktop/e2e) dev-mode stays false and we
   * keep the retail in-app path.
   */
  private async queryDevMode(): Promise<boolean> {
    ReminderService.setDevMode(false);
    if (!isLunaAvailable()) {
      log.debug('Luna unavailable — dev-mode alert disabled, using in-app prompt');
      return false;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (initialized: boolean): void => {
        if (!settled) {
          settled = true;
          resolve(initialized);
        }
      };
      const timer = setTimeout(() => finish(false), 3000);
      try {
        lunaRequest(`luna://${CONFIG.SERVICE_ID}`, {
          method: 'getDevMode',
          parameters: {},
          onSuccess: (resp: unknown) => {
            clearTimeout(timer);
            const lateSuccess = settled;
            if (document.visibilityState === 'hidden') {
              finish(false);
              return;
            }
            const dev = !!(resp && typeof resp === 'object' && (resp as { devmode?: unknown }).devmode);
            ReminderService.setDevMode(dev);
            log.info('getDevMode:', dev);
            finish(true);
            if (lateSuccess) {
              this.remindersInitialized = true;
              ReminderService.reschedulePending();
            }
          },
          onFailure: (err: unknown) => {
            clearTimeout(timer);
            log.warn('getDevMode onFailure:', JSON.stringify(err));
            finish(false);
          },
        });
      } catch (e) {
        clearTimeout(timer);
        log.warn('getDevMode threw:', e);
        finish(false);
      }
    });
  }

  /**
   * Subscribe to the bundled service's `serviceEvents` push channel. Upload
   * changes refresh the managed upload list; phone setup changes consume the
   * queued Playlist, Xtream, or EPG action and reload channel data. No polling.
   *
   * Subscription is best-effort: if Luna isn't available (desktop/e2e) or
   * the subscribe call fails, we silently fall back to the explicit
   * refresh calls that bundled-service initialization runs on open.
   */
  private subscribeToServiceEvents(): void {
    if (!isLunaAvailable()) {
      log.debug('Luna unavailable — service event subscription skipped');
      return;
    }
    this.cancelServiceEventsSubscription();
    log.info('Subscribing to luna://' + CONFIG.SERVICE_ID + '/serviceEvents ...');
    try {
      this.serviceEventsSubscription = lunaRequest(`luna://${CONFIG.SERVICE_ID}`, {
        method: 'serviceEvents',
        subscribe: true,
        parameters: {},
        onSuccess: (resp: unknown) => {
          log.info('serviceEvents push:', JSON.stringify(resp));
          if (resp && typeof resp === 'object' &&
              (resp as { subscribed?: unknown }).subscribed === true) return;
          if (resp && typeof resp === 'object' &&
              (resp as { event?: unknown }).event === 'setup-changed') {
            void this.queueDeviceSetupSync();
            return;
          }
          if (resp && typeof resp === 'object' &&
              (resp as { event?: unknown }).event === 'backup-changed') {
            void BackupClient.applyPendingImports().then((applied) => {
              if (applied) location.reload();
            }).catch(err => log.error('Backup import sync failed:', err));
            return;
          }
          void this.settings.refreshUploads()
            .then(() => this.loadChannelsAfterFirstUpload())
            .catch(err => log.error('Upload event refresh failed:', err));
        },
        onFailure: (err: unknown) => {
          log.warn('serviceEvents subscription failed:', JSON.stringify(err));
        },
      });
    } catch (e) {
      log.warn('serviceEvents subscribe threw:', e);
    }
  }

  /**
   * Push the saved display-timezone mode + the EPG's source offset into the
   * time formatter. Display only; safe to re-run any time. Prefers the offset
   * from the freshly-loaded feed, persists it, and falls back to the last-known
   * value — so feed mode renders correctly before the EPG has reloaded. The
   * formatter degrades 'feed' to 'device' while the offset is still unknown.
   */
  private applyDisplayTz(): void {
    const offset = EpgService.tzOffsetMinutes ?? StorageService.getEpgTzOffset();
    if (EpgService.tzOffsetMinutes != null) StorageService.setEpgTzOffset(EpgService.tzOffsetMinutes);
    setDisplayTz(StorageService.getTzMode(), offset);
  }

  private epgSources(): EpgSource[] {
    if (!StorageService.getPlaylists().some(isSourceEnabled)) return [];
    const manualUrl = StorageService.getEpgUrl();
    const discovered = PlaylistService.epgSources;
    const sources: EpgSource[] = manualUrl && !discovered.some((source) => source.url === manualUrl)
      ? [{ url: manualUrl, playlistIds: [], kind: 'manual' }, ...discovered]
      : discovered;
    const offsets = StorageService.getEpgOffsets();
    return sources.map(source => ({ ...source, offsetMinutes: offsets[source.url] ?? 0 }));
  }

  private stopEpgRefresh(): void {
    if (this.epgRefreshTimer === null) return;
    clearInterval(this.epgRefreshTimer);
    this.epgRefreshTimer = null;
  }

  private async loadData(
    forceRefresh = false,
    destination?: ViewName,
  ): Promise<void> {
    const done = log.time('loadData');
    show(this.views.loading);
    this.stopEpgRefresh();

    this.applyDisplayTz();
    this.epgGrid.resetDay(); // re-pick today; a tz change invalidates the remembered day index

    try {
      const playlists = StorageService.getPlaylists();
      log.info('Configured playlists:', playlists.length);
      if (!playlists.length) {
        log.info('No playlists configured — opening settings');
        // Clear in-memory state so the channel list does not show stale
        // channels if the user navigates back from settings (e.g. with BACK).
        PlaylistService.reset();
        EpgService.reset();
        // No account at all: drop Movies/Series (Xtream-only) and any stale
        // account avatars so the docked tab bar shows Live/Settings/Search only.
        this.tabBar.setSections(false);
        this.tabBar.setAccounts([], '');
        this.channelList.render();
        this.resetView('settings');
        this.settings.render();
        showToast(t('app.welcome'));
        return;
      }

      const loadingText = $('#loading-text');
      if (loadingText) loadingText.textContent = t('app.loadingChannels');
      if (forceRefresh) await PlaylistService.refresh();
      else await PlaylistService.load();
      // Health history only decorates channel rows. Do not hold the initial
      // channel view behind a potentially large IndexedDB getAll().
      void ChannelHealthService.initialize()
        .then(() => this.channelList.render())
        .catch(err => log.warn('Channel health initialization failed:', err));
      log.info('Channels loaded:', PlaylistService.channels.length,
        '| groups:', PlaylistService.groups.length,
        '| epgSources:', PlaylistService.epgSources);
      const epgSources = this.epgSources();
      if (epgSources.length) log.info('Using EPG sources:', epgSources);
      else {
        log.warn('No EPG sources configured');
        EpgService.reset();
      }

      const hasXtream = StorageService.getPlaylists()
        .some((p) => p.source === 'xtream' && isSourceEnabled(p));
      const hasM3uCatalog = PlaylistService.getContentKindCount('movie') > 0
        || PlaylistService.getContentKindCount('series') > 0;
      this.tabBar.setSections(hasXtream || hasM3uCatalog);
      const xtreamAccounts = StorageService.getPlaylists()
        .filter((p) => p.source === 'xtream' && p.xtream && isSourceEnabled(p));
      this.tabBar.setAccounts(this.xtreamAccountOptions(xtreamAccounts),
        this.activeXtreamAccount()?.id ?? '');
      this.refreshXtreamAccountStatuses();

      this.channelList.render();
      this.returnToView(destination ?? 'home');

      showToast(tp('app.channelsLoaded', PlaylistService.channels.length));

      this.scanReminders();
      ReminderService.reschedulePending();

      if (StorageService.getAutoPlay()) {
        // The per-stream key survives customization and provider reshuffles.
        const lastCh = PlaylistService.resolveLastChannelIndex(
          StorageService.getLastChannelKey(),
          StorageService.getLastChannel(),
        );
        if (lastCh >= 0 && lastCh < PlaylistService.channels.length) {
          log.info('Auto-play resuming last channel index', lastCh);
          this.playChannel(lastCh);
        }
      }

      if (epgSources.length) {
        EpgService.load(
          epgSources,
          PlaylistService.allChannels,
          undefined,
          () => this.refreshEpgDependentViews(),
        )
          .then(() => {
            this.refreshEpgDependentViews();
          })
          .catch(err => log.error('EPG load failed:', err));
        this.epgRefreshTimer = setInterval(() =>
          EpgService.refresh(() => this.refreshEpgDependentViews())
          .then(() => {
            this.refreshEpgDependentViews();
          })
          .catch(err => log.error('EPG refresh failed:', err)),
        CONFIG.EPG_REFRESH_INTERVAL);
      }
    } catch (err) {
      log.error('loadData failed:', err);
      this.resetView('settings');
      this.settings.render();
      showToast(t('app.loadFailed'));
    } finally {
      hide(this.views.loading);
      done();
    }
  }

  private showView(name: ViewName): void {
    if (name !== 'channels' && this.channelList.isEditing) this.channelList.exitEditMode();
    // Re-assert the persisted theme on every view transition. This reverts any
    // unsaved live preview when Settings closes (Back / section switch / Cancel)
    // while keeping a just-saved theme, since save() persists before this runs.
    applyTheme(StorageService.getTheme());
    applyOverlayStyle(StorageService.getOverlayStyle());
    applyTextSize(StorageService.getTextSize());
    this.player.closeSubtitleSearch(); // never let the subtitle overlay linger across a view change
    this.player.closeSubtitleOffset(); // never let the subtitle-sync overlay linger across a view change
    this.epgGrid.dismissPrompt(); // never let the catch-up prompt linger across a view change
    this.search.dismissPrompt();
    this.settings.dismissPrompt();
    for (const [key, el] of Object.entries(this.views)) {
      if (key === 'loading') continue;
      if (key === name) show(el);
      else hide(el);
    }
    this.channelList.setActive(name === 'channels');

    // The docked tab bar shows on the section views and hides on the full-screen
    // player / EPG (and the loading splash), which render edge-to-edge.
    const section = sectionForView(name);
    this.tabBar.setShown(section !== null);

    // Focus the channel entry point on entry — but not while the tab bar holds
    // focus (a live Left/Right preview updates the view beneath it without
    // stealing the focus ring). No-op on first load (render runs after).
    if (name === 'channels' && !this.tabBar.focused) this.channelList.highlightEntryPoint();

    // Keep the active tab bound to the shown section view (so returning from
    // Settings, EPG, the player, etc. updates the underline). Skipped while the
    // search box is open — it overlays other views but stays "Search".
    if (section && !this.tabBar.searchOpen) this.tabBar.setActive(section);
    if (name === 'search' && this.lastSearchQuery) {
      this.tabBar.restoreSearch(this.lastSearchQuery);
    }
  }

  private navigateTo(name: ViewName): void {
    this.navigator.navigateTo(name);
    this.showView(name);
  }

  private replaceView(name: ViewName): void {
    this.navigator.replaceView(name);
    this.showView(name);
  }

  private resetView(name: ViewName): void {
    this.navigator.resetTo(name);
    this.showView(name);
  }

  private goBackTo(fallback: ViewName): void {
    const history = this.navigator.history;
    const previous = history.length > 1 ? history[history.length - 2] : null;
    const target = previous === fallback
      ? this.navigator.goBack(fallback)
      : fallback;
    if (target === 'home') {
      this.goHome();
      return;
    }
    if (previous !== fallback) {
      this.replaceView(target);
      return;
    }
    this.showView(target);
  }

  private goBack(fallback: ViewName): void {
    const target = this.navigator.goBack(fallback);
    if (target === 'home') {
      this.goHome();
      return;
    }
    this.showView(target);
  }

  private homeState(): HomeState {
    const account = this.activeXtreamAccount();
    const accountIds = new Set<string>();
    if (account) accountIds.add(account.id);
    for (const channel of PlaylistService.getByContentKind('movie')) {
      accountIds.add(m3uAccountId(channel));
    }
    for (const channel of PlaylistService.getByContentKind('series')) {
      accountIds.add(m3uAccountId(channel));
    }
    let resume: HomeState['resume'] = null;
    for (const accountId of accountIds) {
      const entry = StorageService.getResumeList(accountId)[0];
      if (entry && (!resume || entry.updatedAt > resume.updatedAt)) resume = entry;
    }
    const watchlist: WatchlistEntry[] = [];
    if (account) {
      watchlist.push(
        ...StorageService.getWatchlist(account.id, 'vod'),
        ...StorageService.getWatchlist(account.id, 'series'),
      );
    }
    for (const accountId of accountIds) {
      if (!accountId.startsWith('m3u:')) continue;
      watchlist.push(
        ...StorageService.getWatchlist(accountId, 'm3u-vod'),
        ...StorageService.getWatchlist(accountId, 'm3u-series'),
      );
    }
    watchlist.sort((a, b) => b.addedAt - a.addedAt);
    return {
      hasMovies: !!account || PlaylistService.getContentKindCount('movie') > 0,
      hasSeries: !!account || PlaylistService.getContentKindCount('series') > 0,
      resume,
      lastRefreshAt: StorageService.getLastPlaylistRefreshAt(),
      accountName: account?.name ?? '',
      accountStatus: account ? StorageService.getXtreamAccountStatus(account.id) : null,
      recent: RecentlyWatchedService.getItems(),
      watchlist,
      reminders: ReminderService.listManageable(),
    };
  }

  private goHome(): void {
    this.movies.deactivate();
    this.series.deactivate();
    this.search.deactivate();
    this.player.stop();
    this.backPressTime = 0;
    this.resetView('home');
    this.home.open(this.homeState());
  }

  private returnToView(view: ViewName): void {
    if (view === 'home') {
      this.goHome();
      return;
    }
    if (view === 'channels') {
      this.goLive();
      return;
    }
    this.goBackTo(view);
  }

  private requestExit(): void {
    const now = Date.now();
    if (this.backPressTime > 0 && now - this.backPressTime < 3000) {
      void this.exitApp();
    } else {
      this.backPressTime = now;
      showToast(t('app.exitHint'));
    }
  }

  private handleHomeAction(action: HomeAction): void {
    if (action === 'live') { this.switchSection('live'); return; }
    if (action === 'movies') { this.switchSection('movies'); return; }
    if (action === 'series') { this.switchSection('series'); return; }
    if (action === 'epg') { this.switchSection('epg'); return; }
    if (action === 'settings') { this.switchSection('settings'); return; }
    if (action === 'continue') {
      const resume = this.homeState().resume;
      if (resume && !this.playHomeResume(resume)) {
        this.switchSection(resume.kind === 'vod' ? 'movies' : 'series');
      }
      return;
    }
    if (action === 'refresh') void this.refreshDataFromHome();
  }

  private handleHomeItem(selection: HomeItem): void {
    if (selection.kind === 'recent') {
      const item = selection.item;
      if (item.kind === 'live') {
        this.playChannel(item.channelIndex);
      } else {
        void RecentlyWatchedService.catchupInfo(item).then(info => {
          if (info) this.playChannel(item.channelIndex, info);
        });
      }
      return;
    }
    if (selection.kind === 'reminder') {
      this.openReminderManager('home');
      return;
    }
    this.openHomeWatchlist(selection.item);
  }

  private openHomeWatchlist(entry: WatchlistEntry): void {
    const section: CatalogSection = entry.kind === 'vod' || entry.kind === 'm3u-vod'
      ? 'movies'
      : 'series';
    this.resetView(section);
    if (entry.kind === 'vod' || entry.kind === 'series') {
      const account = StorageService.getPlaylists().find(source =>
        source.id === entry.accountId && source.source === 'xtream' && source.xtream);
      if (!account) {
        this.goHome();
        return;
      }
      const source: CatalogSource = { kind: 'xtream', playlistId: account.id };
      StorageService.setSelectedCatalogSource(section, source);
      StorageService.setSelectedXtreamAccountId(account.id);
      this.setCatalogSwitcher(section, source);
      this.m3uCatalogSection = null;
      const opened = section === 'movies'
        ? this.movies.openWatchlistEntry(account, entry, () => this.goHome())
        : this.series.openWatchlistEntry(account, entry, () => this.goHome());
      opened.catch(err => log.error(
        'Home Watchlist detail failed',
        'event=home.watchlist.open.failed',
        `operation=${section}`,
        err,
      ));
      return;
    }
    const available = this.catalogSources(section);
    const playlistId = entry.accountId.slice('m3u:'.length).split(',').find(id =>
      available.some(source => source.kind === 'm3u' && source.playlistId === id));
    if (!playlistId) {
      this.goHome();
      return;
    }
    const source: CatalogSource = { kind: 'm3u', playlistId };
    StorageService.setSelectedCatalogSource(section, source);
    this.openCatalog(section);
  }

  private async refreshDataFromHome(): Promise<void> {
    this.home.setRefreshing(true);
    try {
      await this.refreshDataFromSettings(() => undefined);
    } catch (err) {
      log.error('Home data refresh failed', err);
      showToast(t('settings.refreshFailed'));
    } finally {
      this.home.setRefreshing(false);
      this.home.update(this.homeState());
    }
  }

  // Map a tab-bar section to its view and show it (Live = the channels view).
  private switchSection(section: Section): void {
    if (section !== 'live' && this.channelList.isEditing) this.channelList.exitEditMode();
    if (section !== 'movies' && section !== 'search') this.movies.deactivate();
    if (section !== 'series' && section !== 'search') this.series.deactivate();
    if (section !== 'movies') this.m3uMovies.deactivate();
    if (section !== 'series') this.m3uSeries.deactivate();
    if (section !== 'search') this.search.deactivate();
    // Leaving the player via the tab bar (the pointer can reveal it over the
    // player) must tear down playback, like Back / red / blue do.
    this.player.stop();
    this.m3uCatalogSection = null;
    if (section === 'live') { this.resetView('channels'); this.channelList.render(); return; }
    if (section === 'epg') { this.openEpg(); return; }
    if (section === 'movies') {
      this.resetView('movies');
      this.openCatalog('movies');
      return;
    }
    if (section === 'series') {
      this.resetView('series');
      this.openCatalog('series');
      return;
    }
    if (section === 'settings') {
      this.openSettings();
      return;
    }
    // Search: keep the current view; the results view only covers it once a
    // query is typed (handleSearchQuery). Remember where to return to.
    if (this.navigator.current !== 'search') {
      this.viewBeforeSearch = this.navigator.current;
    }
    // Prep the results (loads the catalog once) into the still-hidden search view.
    this.search.open(this.activeXtreamAccount())
      .catch((err) => log.error(
        'Search open failed',
        'event=xtream.view.open.failed',
        'operation=search',
        err,
      ));
  }

  // The tab bar's search box query changed: show the results view over the
  // current one while non-empty; restore the underlying view when cleared.
  private handleSearchQuery(query: string): void {
    this.lastSearchQuery = query;
    this.search.scheduleQuery(query);
    const hasQuery = query.trim().length > 0;
    const onSearch = this.navigator.current === 'search';
    if (hasQuery && !onSearch) this.navigateTo('search');
    else if (!hasQuery && onSearch) this.goBackTo(this.viewBeforeSearch ?? 'channels');
  }

  // The search box was closed: clear it and return to the view it opened from
  // (showView re-syncs the active tab, since the box is already collapsed).
  private handleSearchClose(): void {
    this.search.deactivate();
    this.search.setQuery('');
    const rv = this.viewBeforeSearch ?? 'channels';
    this.viewBeforeSearch = null;
    this.goBackTo(rv);
  }

  // Show the guide and refresh its data in the background (shared by the EPG
  // tab and the red-key shortcut).
  private openEpg(): void {
    // Record the origin view so Back/Escape returns to the caller (channels,
    // home, etc.) — this follows the navigation contract and makes tests and
    // UX deterministic across entry paths.
    const current = this.navigator.current ?? 'home';
    if (current !== 'epg') this.epgOrigin = current;
    this.epgGrid.focusChannel(this.player.getCurrentIndex());
    this.navigateTo('epg');
    this.epgGrid.render();
    const renderEpg = () => {
      this.refreshEpgDependentViews();
      this.epgGrid.render();
    };
    EpgService.refresh(renderEpg).then(() => {
      renderEpg();
    });
  }

  private refreshEpgDependentViews(): void {
    this.applyDisplayTz();
    this.channelList.render();
    this.settings.refreshEpgSourceDiagnostics();
    void this.search.refreshPrograms();
  }

  private openReminderManager(origin: 'home' | 'settings' | 'epg'): void {
    this.reminderManagerOrigin = origin;
    this.navigateTo('reminders');
    this.reminderManager.open();
  }

  // Down/Select from the bar: switch to the section and drop focus into content.
  private enterSection(section: Section): void {
    this.tabBar.setActive(section);
    this.switchSection(section);
  }

  private goLive(): void {
    this.movies.deactivate();
    this.series.deactivate();
    this.search.deactivate();
    this.player.stop();
    this.tabBar.setActive('live');
    this.resetView('channels');
    this.channelList.render();
  }

  private refreshDataFromSettings(
    onProgress: (progress: import('./services/playlist-service').PlaylistRefreshProgress) => void,
    sourceIds?: readonly string[],
  ): Promise<import('./components/settings').SettingsRefreshResult> {
    if (this.dataRefreshPromise) {
      return Promise.reject(new Error('Data refresh already in progress'));
    }
    const promise = this.performDataRefresh(onProgress, sourceIds);
    this.dataRefreshPromise = promise;
    const clear = () => {
      if (this.dataRefreshPromise === promise) this.dataRefreshPromise = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  private async performDataRefresh(
    onProgress: (progress: import('./services/playlist-service').PlaylistRefreshProgress) => void,
    sourceIds?: readonly string[],
  ): Promise<import('./components/settings').SettingsRefreshResult> {
    const done = log.time('refreshDataFromSettings');
    this.stopEpgRefresh();
    try {
      const report = sourceIds
        ? await PlaylistService.refreshSources(sourceIds, onProgress)
        : await PlaylistService.refreshWithReport(onProgress);
      await ChannelHealthService.initialize();
      const epgSources = this.epgSources();
      if (epgSources.length) {
        await EpgService.load(epgSources, PlaylistService.allChannels, sourceIds);
        this.applyDisplayTz();
        void this.search.refreshPrograms();
      } else {
        EpgService.reset();
      }

      const hasXtream = StorageService.getPlaylists()
        .some((p) => p.source === 'xtream' && isSourceEnabled(p));
      const hasM3uCatalog = PlaylistService.getContentKindCount('movie') > 0
        || PlaylistService.getContentKindCount('series') > 0;
      this.tabBar.setSections(hasXtream || hasM3uCatalog);
      const xtreamAccounts = StorageService.getPlaylists()
        .filter((p) => p.source === 'xtream' && p.xtream && isSourceEnabled(p));
      this.tabBar.setAccounts(this.xtreamAccountOptions(xtreamAccounts),
        this.activeXtreamAccount()?.id ?? '');
      this.refreshXtreamAccountStatuses(sourceIds);
      this.channelList.render();
      this.scanReminders();
      ReminderService.reschedulePending();
      if (epgSources.length) {
        this.epgRefreshTimer = setInterval(() => EpgService.refresh()
          .then(() => {
            this.applyDisplayTz();
            this.channelList.render();
            this.settings.refreshEpgSourceDiagnostics();
            void this.search.refreshPrograms();
          })
          .catch(err => log.error('EPG refresh failed:', err)),
        CONFIG.EPG_REFRESH_INTERVAL);
      }

      const completedAt = Date.now();
      if (!sourceIds && !report.failedSourceIds.length && report.sourceCount) {
        StorageService.setLastPlaylistRefreshAt(completedAt);
      }
      return { report, completedAt };
    } finally {
      done();
    }
  }

  private playHomeResume(resume: ResumeEntry): boolean {
    const account = StorageService.getPlaylists().find(entry =>
      entry.id === resume.accountId
      && entry.source === 'xtream'
      && entry.xtream
      && isSourceEnabled(entry));
    if (account?.xtream) {
      const credentials = {
        baseUrl: account.url,
        username: account.xtream.username,
        password: account.xtream.password,
      };
      const extension = resume.ext || 'mp4';
      const url = resume.kind === 'vod'
        ? xtreamVodUrl(credentials, resume.itemId, extension)
        : xtreamEpisodeUrl(credentials, resume.itemId, extension);
      this.tabBar.blur();
      this.navigateTo('player');
      this.player.playVod({
        url,
        title: resume.name,
        poster: resume.poster,
        accountId: resume.accountId,
        itemId: resume.itemId,
        kind: resume.kind,
        seriesId: resume.seriesId,
        resumeSecs: resume.position,
        subtitles: [],
        episodeQueue: resume.episodeQueue,
        watchlistOwner: resume.watchlistOwner,
        onBack: () => this.goHome(),
      });
      return true;
    }

    const section = resume.kind === 'vod' ? 'movies' : 'series';
    const contentKind = resume.kind === 'vod' ? 'movie' : 'series';
    const channel = PlaylistService.getByContentKind(contentKind).find(item =>
      m3uAccountId(item) === resume.accountId && m3uItemKey(item) === resume.itemId);
    if (!channel) return false;
    this.playM3uVod(channel, true, section, true);
    return true;
  }

  private playM3uVod(
    channel: Channel,
    resume: boolean,
    origin: 'movies' | 'series' | 'search',
    returnHome = false,
  ): void {
    const accountId = m3uAccountId(channel);
    const kind = channel.contentKind === 'series' ? 'episode' : 'vod';
    const itemId = m3uItemKey(channel);
    const saved = StorageService.getResume(accountId, kind, itemId);
    this.tabBar.blur();
    this.navigateTo('player');
    this.player.playVod({
      url: channel.url,
      title: channel.name,
      poster: channel.logo,
      accountId,
      itemId,
      kind,
      resumeSecs: resume && saved ? saved.position : 0,
      subtitles: [],
      onBack: () => {
        if (returnHome) {
          this.goHome();
          return;
        }
        this.goBack(origin);
        if (origin === 'movies') this.m3uMovies.refreshPlaybackState();
        else if (origin === 'series') this.m3uSeries.refreshPlaybackState();
      },
    });
  }

  private openSettings(): void {
    const current = this.navigator.current ?? 'home';
    if (current !== 'settings') this.settingsOrigin = current;
    this.settings.render();
    void BackupClient.publishArchive();
    this.navigateTo('settings');
  }

  private catalogSources(section: CatalogSection): CatalogSource[] {
    return availableCatalogSources(
      StorageService.getPlaylists(),
      section,
      (kind, playlistId) => PlaylistService.getContentKindCount(kind, playlistId),
    );
  }

  private activeCatalogSource(section: CatalogSection): CatalogSource | null {
    const selected = StorageService.getSelectedCatalogSource(section);
    const resolved = resolveCatalogSource(
      this.catalogSources(section),
      selected,
      StorageService.getSelectedXtreamAccountId(),
    );
    if (resolved && (!selected || catalogSourceKey(resolved) !== catalogSourceKey(selected))) {
      StorageService.setSelectedCatalogSource(section, resolved);
    }
    return resolved;
  }

  private setCatalogSwitcher(section: CatalogSection, selected: CatalogSource): void {
    const names = new Map(StorageService.getPlaylists().map(source => [source.id, source.name]));
    this.tabBar.setAccounts(this.catalogSources(section).map(source => ({
      id: catalogSourceKey(source),
      name: names.get(source.playlistId) ?? source.playlistId,
      status: source.kind === 'xtream'
        ? StorageService.getXtreamAccountStatus(source.playlistId)
        : null,
    })), catalogSourceKey(selected));
  }

  private openCatalog(section: CatalogSection): void {
    const source = this.activeCatalogSource(section);
    if (!source) return;
    this.setCatalogSwitcher(section, source);
    this.m3uCatalogSection = null;
    if (source.kind === 'xtream') {
      if (section === 'movies') this.m3uMovies.deactivate();
      else this.m3uSeries.deactivate();
      StorageService.setSelectedXtreamAccountId(source.playlistId);
      const account = StorageService.getPlaylists().find(entry =>
        entry.id === source.playlistId && entry.source === 'xtream' && entry.xtream);
      if (!account) return;
      this.refreshXtreamAccountStatuses([account.id]);
      const view = section === 'movies' ? this.movies : this.series;
      view.open(account).catch((err) => log.error(
        `${section === 'movies' ? 'Movies' : 'Series'} open failed`,
        'event=xtream.view.open.failed',
        `operation=${section}`,
        err,
      ));
      return;
    }
    this.m3uCatalogSection = section;
    const kind = section === 'movies' ? 'movie' : 'series';
    const channels = PlaylistService.getByContentKind(kind, source.playlistId);
    if (section === 'movies') this.m3uMovies.open(channels, kind);
    else this.m3uSeries.open(channels, kind);
  }

  private async refreshCatalogSource(section: CatalogSection): Promise<void> {
    const source = this.activeCatalogSource(section);
    if (!source || source.kind !== 'm3u') return;
    try {
      await this.refreshDataFromSettings(() => undefined, [source.playlistId]);
      this.openCatalog(section);
      showToast(t('settings.refreshComplete'));
    } catch (err) {
      log.error(
        'Catalog source refresh failed',
        'event=m3u.catalog.refresh.failed',
        `operation=${section}`,
        `source=${source.playlistId}`,
        err,
      );
      showToast(t('settings.refreshFailed'));
      throw err;
    }
  }

  private activeXtreamAccount(): PlaylistEntry | null {
    const accounts = StorageService.getPlaylists()
      .filter((p) => p.source === 'xtream' && p.xtream && isSourceEnabled(p));
    const selId = StorageService.getSelectedXtreamAccountId();
    return accounts.find((a) => a.id === selId) ?? accounts[0] ?? null;
  }

  private xtreamAccountOptions(accounts: PlaylistEntry[]) {
    return accounts.map(account => ({
      id: account.id,
      name: account.name,
      status: StorageService.getXtreamAccountStatus(account.id),
    }));
  }

  private syncAccountStatusViews(): void {
    const current = this.navigator.current;
    if (current === 'movies' || current === 'series') {
      const source = this.activeCatalogSource(current);
      if (source) this.setCatalogSwitcher(current, source);
    } else {
      const accounts = StorageService.getPlaylists()
        .filter(item => item.source === 'xtream' && item.xtream && isSourceEnabled(item));
      this.tabBar.setAccounts(this.xtreamAccountOptions(accounts),
        this.activeXtreamAccount()?.id ?? '');
    }
    if (current === 'home') this.home.update(this.homeState());
  }

  private refreshXtreamAccountStatuses(sourceIds?: readonly string[]): void {
    const requested = sourceIds ? new Set(sourceIds) : null;
    const accounts = StorageService.getPlaylists().filter(item =>
      item.source === 'xtream' && item.xtream && isSourceEnabled(item)
      && (!requested || requested.has(item.id)));
    for (const account of accounts) {
      void refreshXtreamAccountStatus(account).catch(err => log.warn(
        'Xtream account status refresh failed',
        'event=xtream.account_status.failed',
        `source=${account.id}`,
        err,
      ));
    }
  }

  // A different Xtream account was picked in the avatar dropdown: persist it and
  // reload whichever account-scoped section is showing. Live/Settings just store.
  private selectXtreamAccount(id: string): void {
    const catalogSource = parseCatalogSource(id);
    const current = this.navigator.current;
    if (catalogSource && (current === 'movies' || current === 'series')) {
      const section: CatalogSection = current;
      const available = this.catalogSources(section);
      if (!available.some(source => catalogSourceKey(source) === id)) return;
      StorageService.setSelectedCatalogSource(section, catalogSource);
      this.openCatalog(section);
      return;
    }
    StorageService.setSelectedXtreamAccountId(id);
    const account = this.activeXtreamAccount();
    if (!account) return;
    log.info('Xtream account switched to', account.name);
    this.tabBar.setAccounts(
      this.xtreamAccountOptions(StorageService.getPlaylists()
        .filter((p) => p.source === 'xtream' && p.xtream && isSourceEnabled(p))),
      account.id,
    );
    if (current === 'movies') {
      this.movies.open(account)
        .catch((err) => log.error(
          'Movies reopen failed',
          'event=xtream.view.open.failed',
          'operation=movies_reopen',
          err,
        ));
    } else if (current === 'series') {
      this.series.open(account)
        .catch((err) => log.error(
          'Series reopen failed',
          'event=xtream.view.open.failed',
          'operation=series_reopen',
          err,
        ));
    } else if (current === 'search') {
      this.search.open(account)
        .then(() => this.search.setQuery(this.lastSearchQuery))
        .catch((err) => log.error(
          'Search reopen failed',
          'event=xtream.view.open.failed',
          'operation=search_reopen',
          err,
        ));
    }
  }

  private playChannel(index: number, catchup?: CatchupInfo): void {
    this.navigateTo('player');
    this.player.play(index, catchup);
  }

  private bindReminderLifecycle(): void {
    setInterval(() => this.scanReminders(), CONFIG.REMINDER_SCAN_INTERVAL);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.scanReminders();
    });
    // "Watch now" on a dev-mode reminder alert relaunches us with a channel key.
    document.addEventListener('webOSRelaunch', (e) => {
      this.handleLaunchParams((e as CustomEvent).detail);
    });
  }

  private coldLaunchParams(): unknown {
    const w = window as unknown as { PalmSystem?: { launchParams?: string } };
    return w.PalmSystem?.launchParams;
  }

  private handleLaunchParams(raw: unknown): void {
    const idx = ReminderService.resolveLaunchChannel(raw);
    if (idx >= 0) {
      log.info('Reminder launch — tuning channel index', idx);
      this.playChannel(idx);
    }
  }

  private scanReminders(): void {
    ReminderService.prune();
    // Dev mode: the interactive system alert is the single notification path,
    // so skip the in-app prompt (prune still runs to clean up ended reminders).
    if (ReminderService.devMode) return;
    this.showNextReminder();
  }

  private showNextReminder(): void {
    if (this.reminderPrompt.visible) return;
    const due = ReminderService.dueNow();
    const r = due[0];
    if (!r) return;
    this.reminderPrompt.show(
      truncate(r.title, CONFIG.REMINDER.TITLE_MAX),
      truncate(r.channelName, CONFIG.REMINDER.CHANNEL_MAX),
      {
      onConfirm: () => {
        ReminderService.remove(r.channelKey, r.startMs);
        const idx = ReminderService.resolveChannelIndex(r.channelKey);
        if (idx >= 0) this.playChannel(idx);
        this.showNextReminder();
      },
      onCancel: () => {
        ReminderService.remove(r.channelKey, r.startMs);
        if (this.navigator.current === 'reminders') {
          this.reminderManager.open();
        }
        this.showNextReminder();
      },
    });
  }

  // Which modal/overlay is holding input, for the key diagnostic timeline: a
  // "button does nothing" report is usually an unexpected consumer, not a lost key.
  private keyConsumer(currentView: string): string {
    if (this.reminderPrompt.visible) return 'reminder_prompt';
    if (this.epgGrid.isPromptVisible) return 'epg_prompt';
    if (this.settings.isPromptVisible) return 'settings_prompt';
    if (this.reminderManager.isPromptVisible) return 'reminder_manager_prompt';
    if (this.tabBar.focused) return 'tab_bar';
    if (currentView === 'player' && this.player.subtitleOffsetOpen()) return 'subtitle_offset';
    return `view_${currentView}`;
  }

  private handleKey(action: Action, event?: ActionEvent): void {
    const currentView = this.navigator.current;

    log.debug('Key routed', 'event=key.action', `action=${action}`,
      `view=${currentView}`, `consumer=${this.keyConsumer(currentView)}`,
      `number=${event && 'number' in event ? String(event.number) : 'none'}`);

    // The digit OSD is body-mounted and outlives every view, so an abandoned
    // entry must be cleared before a modal gets a chance to swallow this.
    if (action === 'number_cancel') {
      hideNumberEntry();
      return;
    }

    // A reminder prompt overlays every view and consumes input first.
    if (this.reminderPrompt.visible) {
      this.reminderPrompt.handleAction(action);
      return;
    }

    // The catch-up resume prompt is body-mounted but logically inside the EPG;
    // consume all actions (including back/blue globals) while it is visible.
    if (this.epgGrid.isPromptVisible) {
      this.epgGrid.handleAction(action, event);
      return;
    }

    if (this.settings.isPromptVisible) {
      this.settings.handleAction(action);
      return;
    }
    if (this.reminderManager.isPromptVisible) {
      this.reminderManager.handleAction(action);
      return;
    }

    // The docked tab bar consumes input while it holds focus.
    if (this.tabBar.focused) {
      this.tabBar.handleAction(action);
      return;
    }

    // The subtitle-sync adjuster is modal over the player: it consumes all input.
    if (currentView === 'player' && this.player.subtitleOffsetOpen()) {
      this.player.handleSubtitleOffsetAction(action);
      return;
    }

    // Direct channel entry: echo the digits while KeyHandler buffers them, in
    // the two views that act on them (the guide and prompts ignore numbers).
    if (action === 'number_input') {
      if (currentView === 'channels' || currentView === 'player') {
        showNumberEntry(event && 'digits' in event ? event.digits ?? '' : '');
      }
      return;
    }
    if (action === 'number') hideNumberEntry();

    // Global shortcuts
    // While the channel list is in edit mode the color keys belong to the editor.
    const editingChannels = currentView === 'channels' && this.channelList.isEditing;
    if (action === 'red' && currentView !== 'epg' && !editingChannels) {
      this.sidebar.hide();
      this.menu.hide();
      this.player.stop();
      this.openEpg();
      return;
    }
    if (action === 'blue' && currentView !== 'settings' && !editingChannels) {
      if (currentView === 'epg') this.epgGrid.deactivateFilters();
      this.sidebar.hide();
      this.menu.hide();
      this.player.stop();
      this.openSettings();
      return;
    }
    if (action === 'green' && currentView === 'player' && (this.sidebar.visible || this.menu.visible)) {
      this.togglePlayingFavorite();
      return;
    }
    if (action === 'yellow' && currentView === 'player') {
      this.player.showOSD();
      return;
    }

    // Back handling
    if (action === 'back') {
      if (currentView === 'home') {
        this.home.handleAction(action);
        return;
      }
      if (currentView === 'player') {
        if (this.sidebar.visible) {
          if (!this.sidebar.handleBack()) this.sidebar.hide();
        } else if (this.menu.visible) {
          // Let the menu step out of its audio sub-menu before closing.
          if (!this.menu.handleBack()) this.menu.hide();
        } else {
          this.player.handleAction('back');
        }
        return;
      }
      if (currentView === 'movies') {
        if (this.m3uCatalogSection === 'movies') this.m3uMovies.handleAction('back');
        else this.movies.handleAction('back');
        return;
      }
      if (currentView === 'series') {
        if (this.m3uCatalogSection === 'series') this.m3uSeries.handleAction('back');
        else this.series.handleAction('back');
        return;
      }
      if (currentView === 'search') { this.search.handleAction('back'); return; }
      if (currentView === 'epg') {
        if (this.epgGrid.isFilterOpen) {
          this.epgGrid.handleAction('back');
          return;
        }
        this.epgGrid.deactivateFilters();
        this.returnToView(this.epgOrigin);
        return;
      }
      if (currentView === 'settings') {
        if (this.settings.dismissDropdown()) return;
        this.returnToView(this.settingsOrigin);
        return;
      }
      if (currentView === 'reminders') {
        this.reminderManager.handleAction('back');
        return;
      }
      if (currentView === 'channels') {
        if (this.channelList.handleBack()) return;
        this.goHome();
        return;
      }
    }

    // Delegate to active view
    switch (currentView) {
      case 'home':
        this.home.handleAction(action);
        break;
      case 'channels': {
        const moved = this.channelList.handleAction(action, event);
        if (action === 'up' && !moved && this.tabBar.shown) this.tabBar.focus();
        break;
      }
      case 'movies':
        if (this.m3uCatalogSection === 'movies') this.m3uMovies.handleAction(action);
        else this.movies.handleAction(action);
        break;
      case 'series':
        if (this.m3uCatalogSection === 'series') this.m3uSeries.handleAction(action);
        else this.series.handleAction(action);
        break;
      case 'search':
        this.search.handleAction(action);
        break;
      case 'player':
        if (this.player.isVod()) {
          // A VOD menu (opened with Down or the pointer) captures D-pad nav;
          // Left closes it. Otherwise D-pad drives VOD playback.
          if (this.menu.visible) {
            if (action === 'up' || action === 'down' || action === 'select') this.menu.handleAction(action);
            else if (action === 'left') this.menu.hide();
          } else {
            this.player.handleAction(action, event);
          }
          break;
        }
        // While the OSD is up on seekable catch-up, Left/Right seek instead of
        // opening the sidebar/menu (which stay reachable once the OSD hides).
        if ((action === 'left' || action === 'right')
            && !this.sidebar.visible && !this.menu.visible && this.player.canSeek()) {
          this.player.handleAction(action, event);
          break;
        }
        if (action === 'left') {
          if (this.menu.visible) this.menu.hide();
          else if (this.sidebar.visible) this.sidebar.handleAction(action);
          else this.sidebar.show();
        } else if (action === 'right') {
          if (this.sidebar.visible) this.sidebar.handleAction(action);
          else if (this.menu.visible) this.menu.hide();
          else this.menu.show();
        } else if (this.sidebar.visible && (
          action === 'up' || action === 'down' ||
          action === 'channel_up' || action === 'channel_down' ||
          action === 'select'
        )) {
          this.sidebar.handleAction(action);
        } else if (this.menu.visible && (
          action === 'up' || action === 'down' || action === 'select'
        )) {
          this.menu.handleAction(action);
        } else {
          this.player.handleAction(action, event);
        }
        break;
      case 'epg':
        this.epgGrid.handleAction(action, event);
        break;
      case 'settings':
        if (action === 'back') {
          // Same contract as the global Back handling above: close Settings to
          // Home for a consistent UX expected by the e2e suite.
          this.goHome();
        } else {
          this.settings.handleAction(action);
        }
        break;
      case 'reminders':
        this.reminderManager.handleAction(action);
        break;
    }
  }

  private initSidebarTrigger(): void {
    document.addEventListener('pointermove', (e: PointerEvent) => {
      const currentView = this.navigator.current;
      if (currentView !== 'player') return;

      const osd = $('#player-osd', this.views.player);
      const osdRect = osd?.getBoundingClientRect();
      const overOsd = !!osd && !osd.classList.contains('hidden') && !!osdRect
        && e.clientY >= osdRect.top;

      // VOD (movies/series) has no channels and no live menu — only the OSD
      // (title + seek bar) is pointer-revealable; suppress the channel sidebar
      // and the live player menu.
      const vod = this.player.isVod();

      // Protect the full-width area beside and below the OSD too: its edge
      // controls sit next to margins where an imprecise cursor can open a panel.
      if (!overOsd && !vod && e.clientX < 80 && !this.menu.visible) {
        this.sidebar.show();
        this.sidebar.handlePointerMove(e.clientX, false);
      } else if (this.sidebar.visible) {
        const overSidebar = !!(e.target as HTMLElement).closest('.player-sidebar');
        const delayingDismiss = this.sidebar.handlePointerMove(e.clientX, overSidebar);
        if (!delayingDismiss && !overSidebar
            && e.clientX > this.sidebar.pointerDismissX && !this.sidebar.keyboardOn) {
          // Never dismiss while the keyboard is on — the pointer naturally
          // leaves the sidebar on its way to the on-screen keyboard.
          this.sidebar.hide();
        }
      }

      // Right menu. Live/catch-up and VOD alike; for VOD it shows the VOD action
      // set (Info, Settings) plus any audio/subtitle tracks — the channel rows
      // are hidden, so it's never empty.
      if (!overOsd && e.clientX > 1840 && !this.sidebar.visible) {
        this.menu.show();
      } else if (this.menu.visible) {
        const overMenu = !!(e.target as HTMLElement).closest('.player-menu');
        if (overMenu) {
          this.menu.resetTimer();
        } else if (e.clientX < 1540) {
          this.menu.hide();
        }
      }

      // Bottom OSD info bar
      if (e.clientY > 900 && !this.sidebar.visible && !this.menu.visible) {
        this.player.showOSD();
      }
    });
  }

  private onMenuAction(action: Action): void {
    if (action === 'green') {
      this.togglePlayingFavorite();
    } else if (action === 'yellow') {
      this.player.showOSD();
    } else {
      this.handleKey(action);
    }
  }

  private togglePlayingFavorite(): void {
    const ch = this.player.getCurrentChannel();
    if (!ch) return;
    const key = channelKey(ch);
    StorageService.toggleFavorite(key);
    showToast(StorageService.getFavorites().includes(key)
      ? t('channel.favoriteAdded', { name: ch.name })
      : t('channel.favoriteRemoved', { name: ch.name }));
    this.channelList.render();
    this.sidebar.refresh();
  }


  private async onSettingsSaved(action: SaveAction): Promise<void> {
    if (action === 'edit-channels') {
      this.tabBar.setActive('live');
      this.resetView('channels');
      this.channelList.render();
      this.channelList.enterEditMode('builtin:all');
      return;
    }
    if (action === 'reset') {
      await clearAllCachedData();
      await StorageService.clearUserData();
      StorageService.clearAll();
      log.info(
        'App reset completed',
        'event=persistence.reset.completed',
        'operation=clear',
      );
      location.reload();
      return;
    }
    if (action !== 'cancel') {
      const locale = resolveLocale(StorageService.getLocalePreference());
      if (locale !== getLocale()) {
        setLocale(locale);
        this.tabBar.refresh();
        ReminderService.reschedulePending();
      }
      // Republish on 'apply' too: subtitle credentials and other display-only
      // settings never reach the phone page otherwise. Advisory, so it never
      // holds up closing Settings.
      void SetupClient.publishState();
      void BackupClient.publishArchive();
    }
    if (action === 'reload') {
      this.resetView('channels');
      await this.loadData(true, this.settingsOrigin);
      return;
    }
    // 'apply': only display settings changed — re-apply + re-render, no re-fetch.
    if (action === 'apply') {
      this.applyDisplayTz();
      this.epgGrid.resetDay();
    }
    this.channelList.render();
    if (action === 'cancel') {
      // Invalidate the most recent click token so any pending deferred select
      // for that click will be skipped by KeyHandler's token check.
      delete (window as Window & { __lastClickToken?: unknown }).__lastClickToken;
      this.returnToView(this.settingsOrigin);
      return;
    }
    if (action === 'apply') {
      this.returnToView(this.settingsOrigin);
      return;
    }
    this.returnToView(this.settingsOrigin);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  Telemetry.start();
  installGlobalErrorHandlers();
  logEnvironment(CONFIG.VERSION);
  const app = new App();
  app.init().catch(err => log.error('App init failed:', err));
});
