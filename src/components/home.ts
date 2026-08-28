import type { Action, ResumeEntry, XtreamAccountStatusSnapshot } from '../types';
import { SpatialNav } from '../navigation/spatial-nav';
import { html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { t } from '../i18n';
import { formatLocalTime } from '../utils/time';
import { accountStatusDisplay } from './account-status';

export type HomeAction = 'live' | 'movies' | 'series' | 'continue' | 'epg' | 'refresh' | 'settings';

export interface HomeState {
  hasMovies: boolean;
  hasSeries: boolean;
  resume: ResumeEntry | null;
  lastRefreshAt: number | null;
  accountName: string;
  accountStatus: XtreamAccountStatusSnapshot | null;
}

interface HomeHandlers {
  onAction: (action: HomeAction) => void;
  onBack: () => void;
}

const ICONS: Record<HomeAction, string> = {
  live: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="m8 2 4 3 4-3M8 10h8M8 14h5"/></svg>',
  movies: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="m3 9 18-4M7 7l3 3M13 5l3 3"/></svg>',
  series: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>',
  continue: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/></svg>',
  epg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 8a7 7 0 0 1 11.4-2.2L20 8M4 16l2.5 2.2A7 7 0 0 0 18 16"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.5 1A8 8 0 0 0 15 6l-.4-2.7h-4L10 6a8 8 0 0 0-1.5 1L6 6 4 9.4 6.1 11a7 7 0 0 0 0 2L4 14.6 6 18l2.5-1a8 8 0 0 0 1.5 1l.5 2.7h4L15 18a8 8 0 0 0 1.5-1l2.5 1 2-3.4-2.1-1.6a7 7 0 0 0 .1-1z"/></svg>',
};

export class Home {
  private readonly nav: SpatialNav;
  private state: HomeState = {
    hasMovies: false,
    hasSeries: false,
    resume: null,
    lastRefreshAt: null,
    accountName: '',
    accountStatus: null,
  };
  private refreshing = false;

  constructor(private container: HTMLElement, private handlers: HomeHandlers) {
    this.nav = new SpatialNav(container);
    container.setAttribute('data-self-activate', '');
    container.addEventListener('click', event => {
      const card = (event.target as HTMLElement).closest<HTMLElement>('[data-home-action]');
      if (!card || card.getAttribute('aria-disabled') === 'true') return;
      this.nav.focus(card);
      this.activate(card.dataset.homeAction as HomeAction);
    });
  }

  open(state: HomeState): void {
    this.state = state;
    this.render();
    this.nav.focusBySelector('[data-home-action="live"]');
  }

  update(state: HomeState): void {
    this.state = state;
    this.render();
  }

  setRefreshing(refreshing: boolean): void {
    this.refreshing = refreshing;
    this.render();
  }

  handleAction(action: Action): void {
    if (action === 'back') {
      this.handlers.onBack();
    } else if (action === 'select') {
      const focused = this.nav.focused;
      if (focused && focused.getAttribute('aria-disabled') !== 'true') {
        this.activate(focused.dataset.homeAction as HomeAction);
      }
    } else if (action === 'left' || action === 'right') {
      this.moveHorizontal(action);
    } else if (action === 'up' || action === 'down') {
      this.nav.move(action);
    }
  }

  private moveHorizontal(direction: 'left' | 'right'): void {
    const cards = Array.from(
      this.container.querySelectorAll<HTMLElement>('[data-home-action][data-focusable]'),
    );
    if (!cards.length) return;
    const current = cards.indexOf(this.nav.focused as HTMLElement);
    if (current < 0) {
      this.nav.focus(cards[0]);
      return;
    }
    const offset = direction === 'left' ? cards.length - 1 : 1;
    this.nav.focus(cards[(current + offset) % cards.length]);
  }

  private activate(action: HomeAction): void {
    if (action === 'refresh' && this.refreshing) return;
    this.handlers.onAction(action);
  }

  private card(
    action: HomeAction,
    label: string,
    detail = '',
    extraClass = '',
    disabled = false,
  ): ReturnType<typeof html> {
    return html`
      <button type="button" class="home-card ${extraClass}" ${disabled ? '' : raw('data-focusable')}
              data-key="${action}" data-home-action="${action}"
              aria-disabled="${disabled ? 'true' : 'false'}">
        <span class="home-card-icon">${raw(ICONS[action])}</span>
        <span class="home-card-copy">
          <strong>${label}</strong>
          ${detail ? html`<span>${detail}</span>` : ''}
        </span>
      </button>
    `;
  }

  private refreshText(): string {
    if (this.refreshing) return t('home.refreshing');
    return t('home.refresh');
  }

  private lastRefreshText(): string {
    if (!this.state.lastRefreshAt) return t('home.neverRefreshed');
    const formatted = formatLocalTime(new Date(this.state.lastRefreshAt));
    return t('home.lastRefreshed', { time: formatted });
  }

  private render(): void {
    const resume = this.state.resume;
    const accountStatus = this.state.accountStatus
      ? accountStatusDisplay(this.state.accountStatus)
      : null;
    const template = html`
      <div class="home-shell">
        <header class="home-header">
          <div>
            <div class="home-kicker">IPTV</div>
            <h1>${t('home.title')}</h1>
          </div>
          <div class="home-header-meta">
            ${this.state.accountName && accountStatus ? html`
              <div class="home-account-status ${accountStatus.tone}">
                <strong>${this.state.accountName}</strong>
                <span>${accountStatus.summary}</span>
                <small>${accountStatus.checked}</small>
              </div>
            ` : ''}
            <div class="home-version">${t('home.version', { version: __APP_VERSION__ })}</div>
          </div>
        </header>
        <main class="home-grid" data-nav-container>
          ${this.card('live', t('nav.live'), t('home.liveHint'), 'home-card-primary')}
          ${this.card('movies', t('nav.movies'), '', '', !this.state.hasMovies)}
          ${this.card('series', t('nav.series'), '', '', !this.state.hasSeries)}
          ${this.card(
            'continue',
            t('catalog.continueWatching'),
            resume?.name ?? t('home.continueEmpty'),
            'home-card-wide',
            !resume,
          )}
          ${this.card('epg', t('nav.epg'))}
          ${this.card('refresh', this.refreshText(), this.lastRefreshText(), '', this.refreshing)}
          ${this.card('settings', t('nav.settings'))}
        </main>
        <footer class="home-footer">
          <span>${t('home.remoteHint')}</span>
          <span>${this.lastRefreshText()}</span>
        </footer>
      </div>
    `;
    morph(this.container, template);
    this.nav.clearDetachedFocus();
  }
}
