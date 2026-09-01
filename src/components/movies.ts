import type { PlaylistEntry, VodCategory, VodItem, VodInfo, ResumeKind, WatchlistEntry, VodQueueItem } from '../types';
import { html, raw, Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import { loadAllVodStreams, loadVodCategories, loadVodStreams, loadVodInfo } from '../services/xtream-catalog';
import { xtreamVodUrl } from '../utils/xtream-url';
import { CatalogView } from './catalog-view';
import { PLAY_ICON, watchlistIcon } from './icons';
import { showToast } from './toast';
import { t } from '../i18n';
import { formatSourceDate } from '../utils/time';

// The Movies section: browse (Continue rail + per-category rails + an "all
// categories" drill-in) → per-category poster grid → a detail screen with
// Play / Resume. The browse/grid/nav machinery lives in CatalogView.
export class Movies extends CatalogView<VodCategory, VodItem> {
  protected get kicker(): string { return t('common.movies'); }
  protected readonly resumeKind: ResumeKind = 'vod';
  protected get emptyMessage(): string { return t('catalog.noMovies'); }
  protected get gridEmptyMessage(): string { return t('catalog.noMoviesCategory'); }

  private currentVod: VodItem | null = null;
  private currentInfo: VodInfo | null = null;
  private openedFromWatchlist = false;
  private detailController: AbortController | null = null;
  private uncategorizedItems: VodItem[] | null = null;

  protected async loadCategories(
    account: PlaylistEntry,
    signal: AbortSignal,
  ): Promise<VodCategory[]> {
    this.uncategorizedItems = null;
    const categories = await loadVodCategories(account, signal);
    if (categories.length) return categories;
    const items = await loadAllVodStreams(account, signal);
    if (!items.length) return [];
    this.uncategorizedItems = items;
    return [{ id: '', name: t('common.movies') }];
  }
  protected loadItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<VodItem[]> {
    if (categoryId === '' && this.uncategorizedItems) return Promise.resolve(this.uncategorizedItems);
    return loadVodStreams(account, categoryId, signal);
  }
  protected itemId(v: VodItem): string { return v.streamId; }
  protected itemName(v: VodItem): string { return v.name; }
  protected itemPoster(v: VodItem): string { return v.poster; }
  protected itemCategoryId(v: VodItem): string { return v.categoryId; }
  protected clearDetail(): void {
    this.detailController?.abort();
    this.detailController = null;
    this.currentVod = null;
    this.openedFromWatchlist = false;
  }
  protected onRequestSessionReset(): void {
    this.detailController?.abort();
    this.detailController = null;
  }

  // Continue and Watchlist tiles may not be in a preloaded category, so
  // synthesize the minimal item needed to open their detail screen.
  protected fallbackItem(streamId: string): VodItem | null {
    return this.resumeToVod(streamId) ?? this.watchlistToVod(streamId);
  }
  protected heroFallback(): VodItem | null {
    return this.resumeToVod(this.resume[0]?.itemId ?? '')
      ?? this.watchlistToVod(StorageService.getWatchlist(this.account!.id, 'vod')[0]?.itemId ?? '');
  }

  private resumeToVod(streamId: string): VodItem | null {
    const r = this.resume.find((e) => e.itemId === streamId);
    if (!r) return null;
    return { accountId: r.accountId, streamId: r.itemId, name: r.name, poster: r.poster, rating: '', categoryId: '', containerExtension: r.ext };
  }

  protected continueRail(): Safe | '' {
    return this.resume.length
      ? this.rail(t('catalog.continueWatching'), this.resume.map((r) => this.tile(this.resumeToVod(r.itemId)!)))
      : '';
  }

  protected watchlistRail(): Safe | '' {
    const entries = StorageService.getWatchlist(this.account!.id, 'vod');
    return entries.length
      ? this.rail(t('common.watchlist'), entries.map((entry) => this.watchlistTile(entry)))
      : '';
  }

  private watchlistTile(entry: WatchlistEntry): Safe {
    const vod = this.watchlistEntryToVod(entry);
    return html`
      <div class="catalog-tile" data-focusable data-key="w:${vod.streamId}"
           data-item-id="${vod.streamId}" data-category-id="${vod.categoryId}"
           data-watchlist-item="${vod.streamId}">
        <div class="catalog-poster-wrap">${this.posterCell(vod.name, vod.poster)}</div>
        <div class="catalog-tile-name">${vod.name}</div>
      </div>
    `;
  }

  private watchlistToVod(streamId: string): VodItem | null {
    const entry = StorageService.getWatchlist(this.account!.id, 'vod')
      .find((item) => item.itemId === streamId);
    return entry ? this.watchlistEntryToVod(entry) : null;
  }

  private watchlistEntryToVod(entry: WatchlistEntry): VodItem {
    return {
      accountId: entry.accountId,
      streamId: entry.itemId,
      name: entry.name,
      poster: entry.poster,
      rating: entry.rating,
      categoryId: entry.categoryId,
      containerExtension: entry.containerExtension ?? 'mp4',
    };
  }

  async openWatchlistEntry(
    account: PlaylistEntry,
    entry: WatchlistEntry,
    onDetailBack: () => void,
  ): Promise<void> {
    const opening = this.openItem(account, this.watchlistEntryToVod(entry), onDetailBack);
    this.openedFromWatchlist = true;
    await opening;
  }

  protected selectExtra(el: HTMLElement): boolean {
    if (el.dataset.watchlistItem !== undefined) {
      const vod = this.watchlistToVod(el.dataset.watchlistItem);
      if (vod) void this.openDetail(vod, true);
      return true;
    }
    if (el.dataset.action === 'play') {
      this.play(el.dataset.resume === 'true');
      return true;
    }
    if (el.dataset.action === 'watchlist') {
      this.toggleWatchlist();
      return true;
    }
    return false;
  }

  private toggleWatchlist(): void {
    const vod = this.currentVod;
    const account = this.account;
    if (!vod || !account) return;
    const added = StorageService.toggleWatchlist({
      accountId: account.id,
      kind: 'vod',
      itemId: vod.streamId,
      name: vod.name,
      poster: this.currentInfo?.poster || vod.poster,
      rating: vod.rating,
      categoryId: vod.categoryId,
      containerExtension: vod.containerExtension,
      addedAt: Date.now(),
    });
    showToast(t(added ? 'catalog.watchlistAdded' : 'catalog.watchlistRemoved'));
    this.renderDetail();
  }

  protected async openDetail(vod: VodItem, fromWatchlist = false): Promise<void> {
    const account = this.account;
    if (!account || !this.requestSignal) return;
    this.detailController?.abort();
    this.detailController = new AbortController();
    const signal = this.detailController.signal;
    this.openedFromWatchlist = fromWatchlist;
    this.currentVod = vod;
    this.mode = 'detail';
    this.currentInfo = null;
    this.renderDetail();
    try {
      this.currentInfo = await loadVodInfo(account, vod.streamId, signal);
    } catch (err) {
      if (!this.requestFailed('Movie detail load', err, signal)) return;
      this.currentInfo = null;
    }
    if (this.mode === 'detail' && this.currentVod === vod) this.renderDetail();
  }

  private play(resume: boolean): void {
    const vod = this.currentVod;
    const a = this.account;
    if (!vod || !a) return;
    const saved = StorageService.getResume(a.id, 'vod', vod.streamId);
    this.handlers.onPlayVod({
      url: this.vodUrl(vod),
      title: vod.name,
      poster: this.currentInfo?.poster || vod.poster,
      accountId: a.id,
      itemId: vod.streamId,
      kind: 'vod',
      resumeSecs: resume && saved ? saved.position : 0,
      subtitles: this.currentInfo?.subtitles ?? [],
      watchlistQueue: this.openedFromWatchlist ? this.movieWatchlistQueue(vod.streamId) : undefined,
      searchMeta: {
        imdbId: this.currentInfo?.imdbId || undefined,
        tmdbId: this.currentInfo?.tmdbId || undefined,
        year: this.currentInfo?.year || undefined,
      },
    });
  }

  private movieWatchlistQueue(streamId: string): VodQueueItem[] {
    const entries = StorageService.getWatchlist(this.account!.id, 'vod');
    const index = entries.findIndex((entry) => entry.itemId === streamId);
    if (index < 0) return [];
    return entries.slice(index + 1).map((entry) => {
      const vod = this.watchlistEntryToVod(entry);
      return {
        url: this.vodUrl(vod),
        title: vod.name,
        poster: vod.poster,
        accountId: vod.accountId,
        itemId: vod.streamId,
        kind: 'vod',
        subtitles: [],
      };
    });
  }

  private vodUrl(vod: VodItem): string {
    const a = this.account!;
    return xtreamVodUrl(
      { baseUrl: a.url, username: a.xtream!.username, password: a.xtream!.password },
      vod.streamId,
      vod.containerExtension || 'mp4',
    );
  }

  protected renderDetail(): void {
    const vod = this.currentVod;
    const a = this.account;
    if (!vod || !a) return;
    const info = this.currentInfo;
    const saved = StorageService.getResume(a.id, 'vod', vod.streamId);
    const poster = info?.poster || vod.poster;
    const releaseDate = info ? formatSourceDate(info.releaseDate) : '';
    const mins = info && info.durationSecs > 0
      ? t('catalog.minutes', { count: Math.floor(info.durationSecs / 60) })
      : '';
    const facts = [
      [t('catalog.releaseDate'), releaseDate],
      [t('catalog.runtime'), mins],
      [t('catalog.genre'), info?.genre ?? ''],
      [t('catalog.rating'), vod.rating],
    ].filter((fact) => !!fact[1]);
    const watchlisted = StorageService.isWatchlisted(a.id, 'vod', vod.streamId);
    const backdrop = this.cssImageUrl(info?.backdrop ?? '');

    const prevKey = this.nav.focused?.getAttribute('data-key') ?? null;
    morph(this.container, html`
      <div class="catalog-view catalog-detail movies-detail" data-nav-container>
        ${backdrop ? html`
          <div class="detail-backdrop" style="background-image: url('${backdrop}')">
            <div class="detail-backdrop-scrim"></div>
          </div>
        ` : ''}
        <div class="detail-layout">
          <div class="detail-poster-wrap">${this.posterCell(vod.name, poster)}</div>
          <div class="detail-body">
            <h1 class="detail-title">${vod.name}</h1>
            ${facts.length ? html`
              <div class="detail-facts">
                ${facts.map(([label, value]) => html`
                  <span class="detail-fact">
                    <small>${label}</small><strong>${value}</strong>
                  </span>
                `)}
              </div>
            ` : ''}
            ${info?.plot ? html`<p class="detail-plot">${info.plot}</p>` : ''}
            ${info?.cast ? html`<div class="detail-cast"><span class="detail-label">${t('catalog.cast')}</span> ${info.cast}</div>` : ''}
            ${info?.director ? html`<div class="detail-cast"><span class="detail-label">${t('catalog.director')}</span> ${info.director}</div>` : ''}
            <div class="detail-actions">
              <button class="detail-btn detail-btn-primary" data-focusable data-key="play"
                      data-action="play" data-resume="${saved ? 'true' : 'false'}">
                <span class="detail-btn-icon">${raw(PLAY_ICON)}</span>
                <span>${t(saved ? 'common.resume' : 'catalog.play')}</span>
              </button>
              <button class="detail-btn detail-btn-secondary" data-focusable data-key="watchlist"
                      data-action="watchlist">
                <span class="detail-btn-icon">${raw(watchlistIcon(watchlisted))}</span>
                <span>${t(watchlisted ? 'catalog.removeWatchlist' : 'catalog.addWatchlist')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `);
    const restore = prevKey
      ? this.container.querySelector<HTMLElement>(`[data-focusable][data-key="${prevKey}"]`)
      : null;
    if (restore) this.nav.focus(restore);
    else if (!this.nav.focusFirst()) this.nav.focus(null);
  }
}
