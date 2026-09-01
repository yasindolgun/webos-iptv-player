import type { Action, PlaylistEntry, SeriesCategory, SeriesItem, SeriesInfo, Episode, ResumeEntry, ResumeKind, VodQueueItem, WatchlistEntry } from '../types';
import { html, raw, Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import { loadAllSeries, loadSeriesCategories, loadSeries, loadSeriesInfo } from '../services/xtream-catalog';
import { xtreamEpisodeUrl, type XtreamCredentials } from '../utils/xtream-url';
import { CatalogView, type CatalogHandlers } from './catalog-view';
import { CHECK_ICON, PLAY_ICON, TRASH_ICON, watchlistIcon } from './icons';
import { showToast } from './toast';
import { t } from '../i18n';
import { VirtualList } from '../utils/virtual-list';
import { formatSourceDate } from '../utils/time';

const EPISODE_GAP = 16;
const EPISODE_NO_PLOT_ESTIMATE = 138;
const EPISODE_PLOT_ESTIMATE = 216;
const EPISODE_OVERSCAN = 5;
// The whole detail page scrolls, so the fallback is the page viewport, not the
// space left under the header.
const EPISODE_VIEWPORT_FALLBACK = 984;

// The Series section: browse (Continue rail of resumed episodes + per-category
// rails + an "all categories" drill-in) → per-category poster grid → a detail
// screen with a season selector over an episode list. The browse/grid/nav
// machinery lives in CatalogView.
export class Series extends CatalogView<SeriesCategory, SeriesItem> {
  protected get kicker(): string { return t('common.series'); }
  protected readonly resumeKind: ResumeKind = 'episode';
  protected get emptyMessage(): string { return t('catalog.noSeries'); }
  protected get gridEmptyMessage(): string { return t('catalog.noSeriesCategory'); }

  private currentSeries: SeriesItem | null = null;
  private currentInfo: SeriesInfo | null = null;
  private selectedSeason = 0;
  private detailLoading = false;
  private episodeFocusIndex = 0;
  private episodeSource: Episode[] | null = null;
  private measuredEpisodes = new Set<number>();
  private detailController: AbortController | null = null;
  private uncategorizedItems: SeriesItem[] | null = null;
  private readonly episodeVirtualizer = new VirtualList({
    overscan: EPISODE_OVERSCAN,
    fallbackViewportSize: EPISODE_VIEWPORT_FALLBACK,
  });
  private episodeScrollFrame: number | null = null;

  constructor(container: HTMLElement, handlers: CatalogHandlers) {
    super(container, handlers);
    container.addEventListener('click', (event: MouseEvent) => {
      const button = (event.target as HTMLElement)
        .closest<HTMLElement>('[data-toggle-episode-watched]');
      if (!button || !container.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      this.toggleEpisodeWatched(button.dataset.toggleEpisodeWatched ?? '');
    });
  }

  override handleAction(action: Action): void {
    if (action === 'blue' && this.mode === 'detail') {
      const episodeId = this.nav.focused?.dataset.episodeId ?? '';
      if (episodeId) this.toggleEpisodeWatched(episodeId);
      return;
    }
    super.handleAction(action);
  }

  protected async loadCategories(
    account: PlaylistEntry,
    signal: AbortSignal,
  ): Promise<SeriesCategory[]> {
    this.uncategorizedItems = null;
    const categories = await loadSeriesCategories(account, signal);
    if (categories.length) return categories;
    const items = await loadAllSeries(account, signal);
    if (!items.length) return [];
    this.uncategorizedItems = items;
    return [{ id: '', name: t('common.series') }];
  }
  protected loadItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<SeriesItem[]> {
    if (categoryId === '' && this.uncategorizedItems) return Promise.resolve(this.uncategorizedItems);
    return loadSeries(account, categoryId, signal);
  }
  protected itemId(s: SeriesItem): string { return s.seriesId; }
  protected itemName(s: SeriesItem): string { return s.name; }
  protected itemPoster(s: SeriesItem): string { return s.poster; }
  protected itemCategoryId(s: SeriesItem): string { return s.categoryId; }
  protected clearDetail(): void {
    this.detailController?.abort();
    this.detailController = null;
    this.currentSeries = null;
  }
  protected onRequestSessionReset(): void {
    this.detailController?.abort();
    this.detailController = null;
  }

  protected continueRail(): Safe | '' {
    return this.resume.length
      ? this.rail(t('catalog.continueWatching'), this.resume.map((r) => this.resumeTile(r)))
      : '';
  }

  protected watchlistRail(): Safe | '' {
    const entries = StorageService.getWatchlist(this.account!.id, 'series');
    return entries.length
      ? this.rail(t('common.watchlist'), entries.map((entry) => this.tile(this.watchlistEntryToSeries(entry))))
      : '';
  }

  protected fallbackItem(seriesId: string): SeriesItem | null {
    const entry = StorageService.getWatchlist(this.account!.id, 'series')
      .find((item) => item.itemId === seriesId);
    return entry ? this.watchlistEntryToSeries(entry) : null;
  }

  protected heroFallback(): SeriesItem | null {
    const entry = StorageService.getWatchlist(this.account!.id, 'series')[0];
    return entry ? this.watchlistEntryToSeries(entry) : null;
  }

  private watchlistEntryToSeries(entry: WatchlistEntry): SeriesItem {
    return {
      accountId: entry.accountId,
      seriesId: entry.itemId,
      name: entry.name,
      poster: entry.poster,
      rating: entry.rating,
      categoryId: entry.categoryId,
    };
  }

  openWatchlistEntry(
    account: PlaylistEntry,
    entry: WatchlistEntry,
    onDetailBack: () => void,
  ): Promise<void> {
    return this.openItem(account, this.watchlistEntryToSeries(entry), onDetailBack);
  }

  protected selectExtra(el: HTMLElement): boolean {
    if (el.dataset.action === 'watchlist') { this.toggleWatchlist(); return true; }
    if (el.dataset.action === 'clear-episode-history') { this.clearEpisodeHistory(); return true; }
    if (el.dataset.primaryEpisode !== undefined) {
      this.playEpisode(el.dataset.primaryEpisode);
      return true;
    }
    if (el.dataset.resumeEpisode !== undefined) { this.playResume(el.dataset.resumeEpisode); return true; }
    if (el.dataset.season !== undefined) { this.selectSeason(Number(el.dataset.season)); return true; }
    if (el.dataset.episodeId !== undefined) { this.playEpisode(el.dataset.episodeId); return true; }
    return false;
  }

  private toggleWatchlist(): void {
    const series = this.currentSeries;
    const account = this.account;
    if (!series || !account) return;
    const added = StorageService.toggleWatchlist({
      accountId: account.id,
      kind: 'series',
      itemId: series.seriesId,
      name: series.name,
      poster: series.poster,
      rating: series.rating,
      categoryId: series.categoryId,
      addedAt: Date.now(),
    });
    showToast(t(added ? 'catalog.watchlistAdded' : 'catalog.watchlistRemoved'));
    this.renderDetail();
  }

  protected async openDetail(series: SeriesItem): Promise<void> {
    const account = this.account;
    if (!account || !this.requestSignal) return;
    this.detailController?.abort();
    this.detailController = new AbortController();
    const signal = this.detailController.signal;
    this.currentSeries = series;
    this.mode = 'detail';
    this.currentInfo = null;
    this.selectedSeason = 0;
    this.episodeFocusIndex = 0;
    this.episodeSource = null;
    this.episodeVirtualizer.setScrollOffset(0);
    this.detailLoading = true;
    this.renderDetail();
    try {
      this.currentInfo = await loadSeriesInfo(account, series.seriesId, signal);
    } catch (err) {
      if (!this.requestFailed('Series detail load', err, signal)) return;
      this.currentInfo = null;
    }
    if (this.mode === 'detail' && this.currentSeries === series) {
      this.detailLoading = false;
      const next = this.nextUnwatchedEpisode();
      this.selectedSeason = next?.season ?? this.currentInfo?.seasons[0] ?? 0;
      const seasonEpisodes = this.currentInfo?.episodesBySeason[this.selectedSeason] ?? [];
      this.episodeFocusIndex = next
        ? Math.max(0, seasonEpisodes.findIndex(episode => episode.id === next.id))
        : 0;
      this.renderDetail();
    }
  }

  private selectSeason(season: number): void {
    this.selectedSeason = season;
    this.episodeFocusIndex = 0;
    this.episodeSource = null;
    this.episodeVirtualizer.setScrollOffset(0);
    this.renderDetail();
  }

  private findEpisode(episodeId: string): Episode | null {
    const info = this.currentInfo;
    if (!info) return null;
    for (const season of info.seasons) {
      const ep = (info.episodesBySeason[season] ?? []).find((e) => e.id === episodeId);
      if (ep) return ep;
    }
    return null;
  }

  private completionIds(): Set<string> {
    const account = this.account;
    const series = this.currentSeries;
    if (!account || !series) return new Set();
    return new Set(StorageService.getEpisodeCompletions(account.id, series.seriesId)
      .map(entry => entry.itemId));
  }

  private nextUnwatchedEpisode(): Episode | null {
    const info = this.currentInfo;
    if (!info) return null;
    const completed = this.completionIds();
    for (const season of info.seasons) {
      const episode = (info.episodesBySeason[season] ?? [])
        .find(item => !completed.has(item.id));
      if (episode) return episode;
    }
    return null;
  }

  private primaryEpisode(): { episode: Episode; resume: boolean } | null {
    const info = this.currentInfo;
    const account = this.account;
    if (!info || !account) return null;
    for (const saved of StorageService.getResumeList(account.id)) {
      if (saved.kind !== 'episode') continue;
      const episode = this.findEpisode(saved.itemId);
      if (episode) return { episode, resume: true };
    }
    const episode = this.nextUnwatchedEpisode();
    return episode ? { episode, resume: false } : null;
  }

  private toggleEpisodeWatched(episodeId: string): void {
    const account = this.account;
    const series = this.currentSeries;
    if (!account || !series || !this.findEpisode(episodeId)) return;
    const watched = StorageService.getEpisodeCompletion(account.id, episodeId) !== null;
    StorageService.setEpisodeCompleted(
      account.id,
      series.seriesId,
      episodeId,
      !watched,
    );
    showToast(t(watched ? 'catalog.episodeMarkedUnwatched' : 'catalog.episodeMarkedWatched'));
    this.renderDetail();
  }

  private clearEpisodeHistory(): void {
    const account = this.account;
    const series = this.currentSeries;
    if (!account || !series) return;
    StorageService.clearSeriesEpisodeHistory(account.id, series.seriesId);
    this.resume = this.resume.filter(entry => entry.seriesId !== series.seriesId
      && entry.watchlistOwner?.itemId !== series.seriesId);
    showToast(t('catalog.episodeHistoryCleared'));
    this.renderDetail();
  }

  private episodeLabel(series: SeriesItem, ep: Episode): string {
    const code = `S${ep.season}E${ep.episode}`;
    return ep.title ? `${series.name} — ${code} — ${ep.title}` : `${series.name} — ${code}`;
  }

  private episodePlayback(series: SeriesItem, ep: Episode): VodQueueItem {
    const a = this.account!;
    return {
      url: xtreamEpisodeUrl(this.creds(), ep.id, ep.containerExtension || 'mp4'),
      title: this.episodeLabel(series, ep),
      poster: ep.poster || series.poster,
      accountId: a.id,
      itemId: ep.id,
      kind: 'episode',
      seriesId: series.seriesId,
      subtitles: ep.subtitles,
      searchMeta: { season: ep.season, episode: ep.episode },
      watchlistOwner: { kind: 'series', itemId: series.seriesId },
    };
  }

  private episodesAfter(episodeId: string, series: SeriesItem): VodQueueItem[] {
    const info = this.currentInfo;
    if (!info) return [];
    const episodes = info.seasons.reduce<Episode[]>(
      (all, season) => all.concat(info.episodesBySeason[season] ?? []), []);
    const index = episodes.findIndex((ep) => ep.id === episodeId);
    return index < 0 ? [] : episodes.slice(index + 1).map((ep) => this.episodePlayback(series, ep));
  }

  private playEpisode(episodeId: string): void {
    const ep = this.findEpisode(episodeId);
    const series = this.currentSeries;
    const a = this.account;
    if (!ep || !series || !a) return;
    const saved = StorageService.getResume(a.id, 'episode', ep.id);
    this.handlers.onPlayVod({
      ...this.episodePlayback(series, ep),
      resumeSecs: saved ? saved.position : 0,
      episodeQueue: this.episodesAfter(ep.id, series),
    });
  }

  private creds(): XtreamCredentials {
    const a = this.account!;
    return { baseUrl: a.url, username: a.xtream!.username, password: a.xtream!.password };
  }

  // A Continue-rail tile carries only the resume entry (episode id + composed
  // label + poster + stored container extension), not the owning series, so it
  // resumes the episode directly using the stored ext (falling back to mp4).
  private playResume(episodeId: string): void {
    const a = this.account;
    const r = this.resume.find((e) => e.itemId === episodeId);
    if (!a || !r) return;
    this.handlers.onPlayVod({
      url: xtreamEpisodeUrl(this.creds(), r.itemId, r.ext || 'mp4'),
      title: r.name,
      poster: r.poster,
      accountId: a.id,
      itemId: r.itemId,
      kind: 'episode',
      seriesId: r.seriesId ?? r.watchlistOwner?.itemId,
      resumeSecs: r.position,
      subtitles: [],
      episodeQueue: r.episodeQueue,
      watchlistOwner: r.watchlistOwner,
    });
  }

  private resumeTile(r: ResumeEntry): Safe {
    return html`
      <div class="catalog-tile" data-focusable data-key="r:${r.itemId}" data-resume-episode="${r.itemId}">
        <div class="catalog-poster-wrap">${this.posterCell(r.name, r.poster)}</div>
        <div class="catalog-tile-name">${r.name}</div>
      </div>
    `;
  }

  private episodeRow(
    accountId: string,
    ep: Episode,
    completed: ReadonlySet<string>,
    nextEpisodeId: string,
  ): Safe {
    const saved = StorageService.getResume(accountId, 'episode', ep.id);
    const watched = completed.has(ep.id);
    const inProgress = !watched && saved !== null;
    const mins = ep.durationSecs > 0 ? t('catalog.minutes', { count: Math.floor(ep.durationSecs / 60) }) : '';
    return html`
      <div class="episode-row ${watched ? 'watched' : ''} ${inProgress ? 'in-progress' : ''}
                  ${ep.id === nextEpisodeId ? 'next-unwatched' : ''}"
           data-focusable data-key="ep:${ep.id}" data-episode-id="${ep.id}">
        <span class="episode-badge">${raw(PLAY_ICON)}</span>
        <div class="episode-body">
          <div class="episode-title">
            <span class="episode-num">E${ep.episode}</span>
            <span class="episode-name">${ep.title}</span>
            ${watched
              ? html`<span class="episode-state watched">${t('catalog.watched')}</span>`
              : inProgress
                ? html`<span class="episode-resume episode-state in-progress">${t('catalog.inProgress')}</span>`
                : ''}
            ${ep.id === nextEpisodeId
              ? html`<span class="episode-next">${t('catalog.nextEpisode')}</span>`
              : ''}
          </div>
          ${mins ? html`<div class="episode-meta">${mins}</div>` : ''}
          ${ep.plot ? html`<p class="episode-plot">${ep.plot}</p>` : ''}
        </div>
        <button class="episode-state-toggle" type="button" data-self-activate
                data-toggle-episode-watched="${ep.id}"
                aria-label="${t(watched ? 'catalog.markEpisodeUnwatched' : 'catalog.markEpisodeWatched')}">
          <span class="episode-toggle-key" aria-hidden="true"></span>
          <span class="episode-toggle-icon">${watched ? raw(CHECK_ICON) : ''}</span>
          <span>${t(watched ? 'catalog.markEpisodeUnwatched' : 'catalog.markEpisodeWatched')}</span>
        </button>
      </div>
    `;
  }

  protected renderDetail(restoreFocus = true): void {
    const series = this.currentSeries;
    const a = this.account;
    if (!series || !a) return;
    const info = this.currentInfo;
    const episodes = info ? (info.episodesBySeason[this.selectedSeason] ?? []) : [];
    const completed = this.completionIds();
    const nextEpisodeId = this.nextUnwatchedEpisode()?.id ?? '';
    if (episodes !== this.episodeSource) {
      this.episodeSource = episodes;
      this.measuredEpisodes.clear();
      this.episodeVirtualizer.setItemSizes(episodes.map(ep =>
        ep.plot ? EPISODE_PLOT_ESTIMATE : EPISODE_NO_PLOT_ESTIMATE));
    }
    const prevKey = this.nav.focused?.getAttribute('data-key') ?? null;
    const watchlisted = StorageService.isWatchlisted(a.id, 'series', series.seriesId);
    const primary = this.primaryEpisode();
    const releaseDate = info?.releaseDate ? formatSourceDate(info.releaseDate) : '';
    const facts = [
      [t('catalog.releaseDate'), releaseDate],
      [t('catalog.genre'), info?.genre ?? ''],
      [t('catalog.rating'), info?.rating || series.rating],
    ].filter((fact) => !!fact[1]);
    const poster = info?.poster || series.poster;
    const backdrop = this.cssImageUrl(info?.backdrop ?? '');
    const previousScroller = this.container.querySelector<HTMLElement>('.series-detail');
    const previousEpisodes = this.container.querySelector<HTMLElement>('.series-episodes');
    this.episodeVirtualizer.setLeadingSize(
      this.episodeListStart(previousScroller, previousEpisodes),
    );
    if (restoreFocus && previousScroller) {
      this.episodeVirtualizer.setScrollOffset(previousScroller.scrollTop);
    }
    const episodeViewport = previousScroller?.clientHeight || EPISODE_VIEWPORT_FALLBACK;
    const focusedEpisodeIndex = this.nav.focused
      ?.closest<HTMLElement>('[data-episode-index]')
      ?.dataset.episodeIndex;
    if (restoreFocus && focusedEpisodeIndex !== undefined) {
      this.episodeFocusIndex = parseInt(focusedEpisodeIndex, 10);
    }
    this.episodeFocusIndex = Math.max(0, Math.min(this.episodeFocusIndex, episodes.length - 1));
    if (restoreFocus && prevKey?.indexOf('ep:') === 0 && episodes.length) {
      this.episodeVirtualizer.ensureVisible(this.episodeFocusIndex, episodeViewport);
    }
    const episodeRange = this.episodeVirtualizer.getRange(episodes.length, episodeViewport);

    morph(this.container, html`
      <div class="catalog-view catalog-detail series-detail" data-nav-container>
        ${backdrop ? html`
          <div class="detail-backdrop" style="background-image: url('${backdrop}')">
            <div class="detail-backdrop-scrim"></div>
          </div>
        ` : ''}
        <div class="series-detail-head detail-layout">
          <div class="detail-poster-wrap series-detail-poster">${this.posterCell(series.name, poster)}</div>
          <div class="detail-body">
            <h1 class="detail-title">${series.name}</h1>
            ${facts.length ? html`
              <div class="detail-facts">
                ${facts.map(([label, value]) => html`
                  <span class="detail-fact">
                    <small>${label}</small><strong>${value}</strong>
                  </span>
                `)}
              </div>
            ` : ''}
            ${info?.plot ? html`<p class="detail-plot series-detail-plot">${info.plot}</p>` : ''}
            ${info?.cast ? html`<div class="detail-cast"><span class="detail-label">${t('catalog.cast')}</span> ${info.cast}</div>` : ''}
            ${info?.director ? html`<div class="detail-cast"><span class="detail-label">${t('catalog.director')}</span> ${info.director}</div>` : ''}
            <div class="detail-actions">
              ${primary ? html`
                <button class="detail-btn detail-btn-primary" data-focusable data-key="primary-play"
                        data-primary-episode="${primary.episode.id}">
                  <span class="detail-btn-icon">${raw(PLAY_ICON)}</span>
                  <span>${t(primary.resume ? 'common.resume' : 'catalog.play')}</span>
                </button>
              ` : ''}
              <button class="detail-btn detail-btn-secondary" data-focusable data-key="watchlist"
                      data-action="watchlist">
                <span class="detail-btn-icon">${raw(watchlistIcon(watchlisted))}</span>
                <span>${t(watchlisted ? 'catalog.removeWatchlist' : 'catalog.addWatchlist')}</span>
              </button>
              <button class="detail-btn detail-btn-tertiary" data-focusable data-key="episode-history"
                      data-action="clear-episode-history">
                <span class="detail-btn-icon">${raw(TRASH_ICON)}</span>
                <span>${t('catalog.clearEpisodeHistory')}</span>
              </button>
            </div>
            ${this.detailLoading
              ? html`<p class="catalog-hint">${t('common.loading')}</p>`
              : !info
                ? html`<p class="catalog-hint">${t('catalog.loadEpisodesFailed')}</p>`
                : info.seasons.length === 0
                  ? html`<p class="catalog-hint">${t('catalog.noEpisodes')}</p>`
                  : html`
                  <div class="series-seasons">
                    ${info.seasons.map((n) => html`
                      <button class="series-season-btn ${n === this.selectedSeason ? 'active' : ''}"
                              data-focusable data-key="season:${n}" data-season="${n}">${t('catalog.season', { number: n })}</button>
                    `)}
                  </div>
                `}
          </div>
        </div>
        ${info && info.seasons.length > 0 ? html`
          <div class="series-episodes">
            ${episodes.length === 0
              ? html`<p class="catalog-hint">${t('catalog.noSeasonEpisodes')}</p>`
              : html`
                <div class="series-episodes-spacer"
                     style="height:${this.episodeVirtualizer.getTotalSize(episodes.length)}px">
                  ${episodes.slice(episodeRange.start, episodeRange.end).map((ep, offset) => {
                    const index = episodeRange.start + offset;
                    return html`
                      <div class="series-episode-cell"
                           data-key="episode-cell:${ep.id}"
                           data-episode-index="${index}"
                           style="top:${this.episodeVirtualizer.getItemOffset(index)}px">
                        ${this.episodeRow(a.id, ep, completed, nextEpisodeId)}
                      </div>
                    `;
                  })}
                </div>
              `}
          </div>
        ` : ''}
      </div>
    `);
    const measuredSizes = Array.from(
      this.container.querySelectorAll<HTMLElement>('.series-episode-cell'),
    ).map(cell => ({
      cell,
      index: parseInt(cell.dataset.episodeIndex || '-1', 10),
    })).filter(item => item.index >= 0 && !this.measuredEpisodes.has(item.index))
      .map((item) => {
        this.measuredEpisodes.add(item.index);
        const row = item.cell.querySelector<HTMLElement>('.episode-row');
        return {
          index: item.index,
          size: row ? row.getBoundingClientRect().height + EPISODE_GAP : 0,
        };
      }).filter(item => item.index >= 0 && item.size > EPISODE_GAP);
    if (this.episodeVirtualizer.updateItemSizes(measuredSizes)) {
      this.renderDetail(restoreFocus);
      return;
    }
    const episodeList = this.container.querySelector<HTMLElement>('.series-episodes');
    const scroller = this.container.querySelector<HTMLElement>('.series-detail');
    if (scroller) {
      this.episodeVirtualizer.setLeadingSize(this.episodeListStart(scroller, episodeList));
      this.scrollGuard.syncOffset(
        scroller,
        'vertical',
        this.episodeVirtualizer.scrollOffset,
      );
    }
    if (!restoreFocus) {
      this.nav.clearDetachedFocus();
      return;
    }
    const restore = prevKey
      ? this.container.querySelector<HTMLElement>(`[data-focusable][data-key="${prevKey}"]`)
      : null;
    if (restore) this.nav.focus(restore);
    else if (this.detailLoading) this.nav.focus(null);
    else if (!this.nav.focusFirst()) this.nav.focus(null);
  }

  protected moveExtraFocus(action: Action): boolean {
    if (this.mode !== 'detail' || (action !== 'up' && action !== 'down')) return false;
    const focused = this.nav.focused;
    const rawIndex = focused?.closest<HTMLElement>('[data-episode-index]')?.dataset.episodeIndex;
    if (rawIndex === undefined) return false;
    const episodes = this.currentInfo?.episodesBySeason[this.selectedSeason] ?? [];
    const current = parseInt(rawIndex, 10);
    const next = current + (action === 'up' ? -1 : 1);
    if (next < 0 || next >= episodes.length) return false;
    const list = this.container.querySelector<HTMLElement>('.series-detail');
    this.episodeFocusIndex = next;
    this.episodeVirtualizer.ensureVisible(
      next,
      list?.clientHeight || EPISODE_VIEWPORT_FALLBACK,
    );
    this.renderDetail(false);
    this.nav.focus(
      this.container.querySelector<HTMLElement>(
        `[data-episode-index="${next}"] [data-focusable]`,
      ),
    );
    return true;
  }

  protected handleExtraScroll(target: HTMLElement): boolean {
    if (this.mode !== 'detail' || !target.classList.contains('series-detail')) return false;
    const offset = this.scrollGuard.readUserOffset(target, 'vertical');
    if (offset === null) return true;
    this.episodeVirtualizer.setScrollOffset(offset);
    if (this.episodeScrollFrame === null) {
      this.episodeScrollFrame = requestAnimationFrame(() => {
        this.episodeScrollFrame = null;
        if (this.mode === 'detail') this.renderDetail(false);
      });
    }
    return true;
  }

  // Where the episode list starts inside the scrolling detail page, i.e. the
  // header the virtualizer has to skip before item 0. Both share an
  // offsetParent (the page is statically positioned), so the difference is the
  // in-content distance and stays correct while the page is scrolled.
  private episodeListStart(
    scroller: HTMLElement | null,
    list: HTMLElement | null,
  ): number {
    if (!scroller || !list) return 0;
    const top = list.offsetParent === scroller
      ? list.offsetTop
      : list.offsetTop - scroller.offsetTop;
    return Math.max(0, top);
  }
}
