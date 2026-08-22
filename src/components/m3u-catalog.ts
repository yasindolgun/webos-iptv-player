import type { Channel } from '../types';
import type { Action } from '../types';
import type { M3uContentKind } from '../utils/m3u-content-kind';
import { SpatialNav } from '../navigation/spatial-nav';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';
import {
  m3uCatalogCategories,
  m3uCatalogCategoryId,
  type M3uCatalogCategory,
} from '../services/m3u-catalog';
import { m3uSeriesCatalog, type M3uSeries, type M3uSeriesEpisode } from '../services/m3u-series';
import { StorageService } from '../services/storage-service';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';
import { m3uAccountId, m3uItemKey } from '../utils/m3u-item';
import { t } from '../i18n';

const CARD_HEIGHT = 128;
const VIEWPORT_HEIGHT = 720;

type M3uCatalogItem = {
  kind: 'channel';
  id: string;
  name: string;
  poster: string;
  categoryId: string;
  channel: Channel;
} | {
  kind: 'series';
  id: string;
  name: string;
  poster: string;
  categoryId: string;
  series: M3uSeries;
};

export class M3uCatalog {
  private channels: Channel[] = [];
  private allItems: M3uCatalogItem[] = [];
  private items: M3uCatalogItem[] = [];
  private categories: M3uCatalogCategory[] = [];
  private category = '';
  private current: Channel | null = null;
  private currentSeries: M3uSeries | null = null;
  private selectedSeason = 0;
  private itemFocusIndex = 0;
  private scrollFrame: number | null = null;
  private readonly nav: SpatialNav;
  private readonly scrollGuard = new VirtualScrollGuard();
  private readonly virtualizer = new VirtualList({
    itemSize: CARD_HEIGHT,
    overscan: 6,
    fallbackViewportSize: VIEWPORT_HEIGHT,
  });

  constructor(
    private container: HTMLElement,
    private onPlay: (channel: Channel, resume: boolean) => void,
  ) {
    this.nav = new SpatialNav(container, (element) => this.onFocusChanged(element));
    container.addEventListener('click', event => {
      const element = event.target as HTMLElement;
      if (this.current) {
        const key = element.closest<HTMLElement>('[data-key]')?.dataset.key;
        if (key === 'resume' || key === 'play') this.onPlay(this.current, key === 'resume');
        else if (key === 'back') this.closeDetail();
        return;
      }
      if (this.currentSeries) {
        const season = element.closest<HTMLElement>('[data-m3u-season]')?.dataset.m3uSeason;
        if (season !== undefined) {
          this.selectedSeason = parseInt(season, 10);
          this.renderSeriesDetail();
          return;
        }
        const episodeId = element.closest<HTMLElement>('[data-m3u-episode]')?.dataset.m3uEpisode;
        if (episodeId) this.playSeriesEpisode(episodeId);
        else if (element.closest<HTMLElement>('[data-key="back"]')) this.closeDetail();
        return;
      }
      const category = element.closest<HTMLElement>('[data-m3u-category]');
      if (category) {
        this.selectCategory(category.dataset.m3uCategory ?? '');
        return;
      }
      const target = element.closest<HTMLElement>('[data-m3u-item]');
      const id = target?.dataset.m3uItem;
      const item = id ? this.items.find(entry => entry.id === id) : null;
      if (item) this.openItem(item);
    });
    container.addEventListener('scroll', event => {
      const grid = event.target as HTMLElement;
      if (!grid.classList.contains('m3u-catalog-scroll')) return;
      const offset = this.scrollGuard.readUserOffset(grid, 'vertical');
      if (offset === null) return;
      this.virtualizer.setScrollOffset(offset);
      if (this.scrollFrame !== null) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        if (!this.current) this.render(false);
      });
    }, true);
  }

  open(channels: Channel[], kind: M3uContentKind): void {
    this.channels = channels.filter(channel => channel.contentKind === kind);
    this.categories = m3uCatalogCategories(this.channels);
    this.current = null;
    this.currentSeries = null;
    this.selectedSeason = 0;
    if (kind === 'series') {
      const catalog = m3uSeriesCatalog(this.channels);
      this.allItems = catalog.series.map(series => this.seriesItem(series))
        .concat(catalog.flat.map(channel => this.channelItem(channel)));
    } else {
      this.allItems = this.channels.map(channel => this.channelItem(channel));
    }
    this.itemFocusIndex = 0;
    this.selectCategory('');
  }

  handleAction(action: Action): void {
    if (this.current) {
      if (action === 'back') {
        this.closeDetail();
      } else if (action === 'select') {
        const key = this.nav.focused?.dataset.key;
        if (key === 'resume' || key === 'play') this.onPlay(this.current, key === 'resume');
      }
      return;
    }
    if (this.currentSeries) {
      if (action === 'back') {
        this.closeDetail();
      } else if (action === 'select') {
        const season = this.nav.focused?.dataset.m3uSeason;
        if (season !== undefined) {
          this.selectedSeason = parseInt(season, 10);
          this.renderSeriesDetail();
        } else {
          const episodeId = this.nav.focused?.dataset.m3uEpisode;
          if (episodeId) this.playSeriesEpisode(episodeId);
        }
      } else if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
        this.nav.move(action);
      }
      return;
    }
    if (action === 'select') {
      const selectedCategory = this.nav.focused?.dataset.m3uCategory;
      if (selectedCategory !== undefined) {
        this.selectCategory(selectedCategory);
        return;
      }
      const item = this.nav.focused?.dataset.m3uItem;
      const selected = item ? this.items.find(entry => entry.id === item) : null;
      if (selected) this.openItem(selected);
      return;
    }
    if ((action === 'up' || action === 'down') && this.moveItemFocus(action)) return;
    if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
      this.nav.move(action);
    }
  }

  refreshPlaybackState(): void {
    if (this.current) this.renderDetail();
    else if (this.currentSeries) this.renderSeriesDetail();
    else this.render();
  }

  private selectCategory(category: string): void {
    this.category = category;
    this.items = category
      ? this.allItems.filter(item => item.categoryId === category)
      : this.allItems;
    this.itemFocusIndex = 0;
    this.virtualizer.setScrollOffset(0);
    this.render();
    this.nav.focusFirst();
  }

  private render(focusItem = false): void {
    this.itemFocusIndex = Math.max(0, Math.min(this.itemFocusIndex, this.items.length - 1));
    const range = this.virtualizer.getRange(this.items.length, VIEWPORT_HEIGHT);
    morph(this.container, html`
      <div class="catalog-view m3u-catalog" data-nav-container>
        <div class="m3u-catalog-categories">
          <button data-focusable data-m3u-category="" class="${this.category ? '' : 'active'}">${t('common.all')}</button>
          ${this.categories.map(category => html`
            <button data-focusable data-m3u-category="${category.id}"
                    class="${this.category === category.id ? 'active' : ''}">
              ${category.name} (${category.count})
            </button>
          `)}
        </div>
        <div class="m3u-catalog-scroll">
          <div class="m3u-catalog-grid" style="height:${this.virtualizer.getTotalSize(this.items.length)}px">
            ${this.items.slice(range.start, range.end).map((item, offset) => html`
              <button class="catalog-tile" data-focusable data-key="m3u:${item.id}"
                      data-m3u-item="${item.id}" data-m3u-item-index="${range.start + offset}"
                      style="top:${this.virtualizer.getItemOffset(range.start + offset)}px">
                ${item.poster ? html`<img class="catalog-poster" src="${item.poster}" alt="">` : ''}
                <span class="catalog-tile-name">${item.name}</span>
              </button>
            `)}
          </div>
        </div>
      </div>
    `);
    const scroll = this.container.querySelector<HTMLElement>('.m3u-catalog-scroll');
    if (scroll) this.scrollGuard.syncOffset(scroll, 'vertical', this.virtualizer.scrollOffset);
    if (focusItem) {
      const focused = this.container.querySelector<HTMLElement>(
        `[data-m3u-item-index="${this.itemFocusIndex}"]`,
      );
      this.nav.focus(focused);
    } else this.nav.clearDetachedFocus();
  }

  private onFocusChanged(element: HTMLElement | null): void {
    const index = element?.dataset.m3uItemIndex;
    if (index !== undefined) this.itemFocusIndex = parseInt(index, 10);
  }

  private moveItemFocus(direction: 'up' | 'down'): boolean {
    const focused = this.nav.focused;
    if (focused?.dataset.m3uItemIndex === undefined || !this.items.length) return false;
    const next = this.itemFocusIndex + (direction === 'up' ? -1 : 1);
    if (next < 0 || next >= this.items.length) return false;
    this.itemFocusIndex = next;
    const scroll = this.container.querySelector<HTMLElement>('.m3u-catalog-scroll');
    this.virtualizer.ensureVisible(next, scroll?.clientHeight || VIEWPORT_HEIGHT);
    this.render(true);
    return true;
  }

  private channelItem(channel: Channel): M3uCatalogItem {
    return {
      kind: 'channel',
      id: `channel:${m3uItemKey(channel)}`,
      name: channel.name,
      poster: channel.logo,
      categoryId: m3uCatalogCategoryId(channel),
      channel,
    };
  }

  private seriesItem(series: M3uSeries): M3uCatalogItem {
    return {
      kind: 'series',
      id: `series:${series.id}`,
      name: series.name,
      poster: series.poster,
      categoryId: series.categoryId,
      series,
    };
  }

  private openItem(item: M3uCatalogItem): void {
    this.itemFocusIndex = this.items.indexOf(item);
    if (item.kind === 'series') {
      this.currentSeries = item.series;
      this.selectedSeason = item.series.seasons[0] ?? 0;
      this.renderSeriesDetail();
      return;
    }
    this.current = item.channel;
    this.renderDetail();
  }

  private closeDetail(): void {
    this.current = null;
    this.currentSeries = null;
    this.render(true);
  }

  private playSeriesEpisode(id: string): void {
    const series = this.currentSeries;
    if (!series) return;
    const episode = (series.episodesBySeason[this.selectedSeason] ?? [])
      .find(item => m3uItemKey(item.channel) === id);
    if (!episode) return;
    const saved = StorageService.getResume(
      this.accountId(episode.channel),
      this.resumeKind(episode.channel),
      m3uItemKey(episode.channel),
    );
    this.onPlay(episode.channel, saved !== null);
  }

  private renderSeriesDetail(): void {
    const series = this.currentSeries;
    if (!series) return;
    const episodes = series.episodesBySeason[this.selectedSeason] ?? [];
    morph(this.container, html`
      <div class="catalog-view m3u-catalog m3u-series-detail" data-nav-container>
        <div class="series-detail-head">
          <div class="detail-poster-wrap series-detail-poster">
            ${series.poster ? html`<img class="catalog-poster" src="${series.poster}" alt="">` : ''}
          </div>
          <div class="detail-body">
            <h1 class="detail-title">${series.name}</h1>
            <div class="detail-actions">
              <button class="detail-btn" data-focusable data-key="back">${t('common.back')}</button>
            </div>
            <div class="series-seasons">
              ${series.seasons.map(season => html`
                <button class="series-season-btn ${season === this.selectedSeason ? 'active' : ''}"
                        data-focusable data-key="m3u-season:${season}" data-m3u-season="${season}">
                  ${t('catalog.season', { number: season })}
                </button>
              `)}
            </div>
          </div>
        </div>
        <div class="series-episodes">
          ${episodes.map(episode => this.seriesEpisodeRow(episode))}
        </div>
      </div>
    `);
    this.nav.focusFirst();
  }

  private seriesEpisodeRow(episode: M3uSeriesEpisode) {
    const channel = episode.channel;
    const saved = StorageService.getResume(
      this.accountId(channel), this.resumeKind(channel), m3uItemKey(channel),
    );
    return html`
      <button class="episode-row" data-focusable data-key="m3u-ep:${m3uItemKey(channel)}"
              data-m3u-episode="${m3uItemKey(channel)}">
        <span class="episode-badge">E${episode.episode}</span>
        <span class="episode-body">
          <span class="episode-title">${episode.title || channel.name}</span>
          ${saved ? html`<span class="episode-resume">${t('common.resume')}</span>` : ''}
        </span>
      </button>
    `;
  }

  private renderDetail(): void {
    const channel = this.current;
    if (!channel) return;
    const category = channel.sourceGroup || channel.group;
    const saved = StorageService.getResume(
      this.accountId(channel), this.resumeKind(channel), m3uItemKey(channel),
    );
    morph(this.container, html`
      <div class="catalog-view m3u-catalog m3u-catalog-detail" data-nav-container>
        <div class="detail-poster-wrap">
          ${channel.logo ? html`<img class="catalog-poster" src="${channel.logo}" alt="">` : ''}
        </div>
        <div class="detail-body">
          ${category ? html`<div class="catalog-hero-kicker">${category}</div>` : ''}
          <h1 class="detail-title">${channel.name}</h1>
          <div class="detail-actions">
            ${saved ? html`
              <button class="detail-btn detail-btn-primary" data-focusable data-key="resume">
                ${t('common.resume')}
              </button>
            ` : ''}
            <button class="detail-btn ${saved ? '' : 'detail-btn-primary'}" data-focusable data-key="play">
              ${t(saved ? 'catalog.playFromStart' : 'catalog.play')}
            </button>
            <button class="detail-btn" data-focusable data-key="back">${t('common.back')}</button>
          </div>
        </div>
      </div>
    `);
    this.nav.focusFirst();
  }

  private accountId(channel: Channel): string {
    return m3uAccountId(channel);
  }

  private resumeKind(channel: Channel): 'episode' | 'vod' {
    return channel.contentKind === 'series' ? 'episode' : 'vod';
  }
}
