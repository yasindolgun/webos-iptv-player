import type { Channel } from '../types';
import type { Action } from '../types';
import type { M3uContentKind } from '../utils/m3u-content-kind';
import { SpatialNav } from '../navigation/spatial-nav';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';
import { m3uCatalogCategories, m3uCatalogItems } from '../services/m3u-catalog';
import { VirtualList } from '../utils/virtual-list';

const CARD_HEIGHT = 128;
const VIEWPORT_HEIGHT = 720;

export class M3uCatalog {
  private channels: Channel[] = [];
  private category = '';
  private readonly nav: SpatialNav;
  private readonly virtualizer = new VirtualList({
    itemSize: CARD_HEIGHT,
    overscan: 6,
    fallbackViewportSize: VIEWPORT_HEIGHT,
  });

  constructor(
    private container: HTMLElement,
    private onPlay: (channel: Channel) => void,
  ) {
    this.nav = new SpatialNav(container);
    container.addEventListener('click', event => {
      const element = event.target as HTMLElement;
      const category = element.closest<HTMLElement>('[data-m3u-category]');
      if (category) {
        this.category = category.dataset.m3uCategory ?? '';
        this.virtualizer.setScrollOffset(0);
        this.render();
        return;
      }
      const target = element.closest<HTMLElement>('[data-m3u-item]');
      const id = target?.dataset.m3uItem;
      const channel = id ? this.channels.find(item => item.id === id) : null;
      if (channel) this.onPlay(channel);
    });
    container.addEventListener('scroll', event => {
      const grid = event.target as HTMLElement;
      if (!grid.classList.contains('m3u-catalog-scroll')) return;
      this.virtualizer.setScrollOffset(grid.scrollTop);
      this.render();
    }, true);
  }

  open(channels: Channel[], kind: M3uContentKind): void {
    this.channels = channels.filter(channel => channel.contentKind === kind);
    this.category = '';
    this.virtualizer.setScrollOffset(0);
    this.render();
  }

  handleAction(action: Action): void {
    if (action === 'select') {
      const selectedCategory = this.nav.focused?.dataset.m3uCategory;
      if (selectedCategory !== undefined) {
        this.category = selectedCategory;
        this.virtualizer.setScrollOffset(0);
        this.render();
        return;
      }
      const item = this.nav.focused?.dataset.m3uItem;
      const channel = item ? this.channels.find(entry => entry.id === item) : null;
      if (channel) this.onPlay(channel);
      return;
    }
    if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
      this.nav.move(action);
    }
  }

  private render(): void {
    const categories = m3uCatalogCategories(this.channels);
    const items = m3uCatalogItems(this.channels, this.category || undefined);
    const range = this.virtualizer.getRange(items.length, VIEWPORT_HEIGHT);
    morph(this.container, html`
      <div class="catalog-view m3u-catalog" data-nav-container>
        <div class="m3u-catalog-categories">
          <button data-focusable data-m3u-category="" class="${this.category ? '' : 'active'}">Tümü</button>
          ${categories.map(category => html`
            <button data-focusable data-m3u-category="${category.id}"
                    class="${this.category === category.id ? 'active' : ''}">
              ${category.name} (${category.count})
            </button>
          `)}
        </div>
        <div class="m3u-catalog-scroll">
          <div class="m3u-catalog-grid" style="height:${this.virtualizer.getTotalSize(items.length)}px">
            ${items.slice(range.start, range.end).map((item, offset) => html`
              <button class="catalog-tile" data-focusable data-m3u-item="${item.id}"
                      style="top:${this.virtualizer.getItemOffset(range.start + offset)}px">
                ${item.poster ? html`<img class="catalog-poster" src="${item.poster}" alt="">` : ''}
                <span class="catalog-tile-name">${item.name}</span>
              </button>
            `)}
          </div>
        </div>
      </div>
    `);
    this.nav.focusFirst();
  }
}
