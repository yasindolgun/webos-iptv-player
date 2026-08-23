// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResumeEntry } from '../types';
import { setLocale } from '../i18n';
import { Home, type HomeAction } from './home';

const resume: ResumeEntry = {
  accountId: 'x1',
  kind: 'vod',
  itemId: '10',
  name: '<img src=x onerror=alert(1)>',
  poster: '',
  ext: 'mp4',
  position: 120,
  duration: 600,
  updatedAt: 1000,
};

let container: HTMLElement;
let onAction: ReturnType<typeof vi.fn<(action: HomeAction) => void>>;
let onBack: ReturnType<typeof vi.fn>;
let home: Home;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  setLocale('en');
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  onAction = vi.fn();
  onBack = vi.fn();
  home = new Home(container, { onAction, onBack });
});

function open(over: Partial<Parameters<Home['open']>[0]> = {}): void {
  home.open({
    hasMovies: true,
    hasSeries: true,
    resume: null,
    lastRefreshAt: null,
    ...over,
  });
}

describe('Home', () => {
  it('renders the launch actions, version, and safe resume text', () => {
    open({ resume });

    expect(container.querySelectorAll('[data-home-action]')).toHaveLength(7);
    expect(container.textContent).toContain('Version 0.0.0-test');
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-home-action="live"]')?.classList.contains('focused'))
      .toBe(true);
  });

  it('activates the focused card with OK and handles Back', () => {
    open();

    home.handleAction('select');
    home.handleAction('back');

    expect(onAction).toHaveBeenCalledWith('live');
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('moves geometrically with the D-pad before selecting', () => {
    open();
    const cards = Array.from(container.querySelectorAll<HTMLElement>('[data-home-action]'));
    const positions: Record<string, [number, number]> = {
      live: [0, 0], movies: [200, 0], series: [400, 0], continue: [200, 120],
      epg: [0, 240], refresh: [200, 240], settings: [400, 240],
    };
    for (const card of cards) {
      const [left, top] = positions[card.dataset.homeAction!];
      card.getBoundingClientRect = () => ({
        left, top, right: left + 160, bottom: top + 90,
        width: 160, height: 90, x: left, y: top, toJSON: () => ({}),
      });
    }

    home.handleAction('right');
    home.handleAction('select');

    expect(onAction).toHaveBeenCalledWith('movies');
  });

  it('supports Magic Remote clicks and ignores unavailable cards', () => {
    open({ hasMovies: false });
    container.querySelector<HTMLElement>('[data-home-action="movies"]')!.click();
    container.querySelector<HTMLElement>('[data-home-action="settings"]')!.click();

    expect(onAction).not.toHaveBeenCalledWith('movies');
    expect(onAction).toHaveBeenCalledWith('settings');
  });

  it('disables duplicate refresh activation while refreshing', () => {
    open();
    home.setRefreshing(true);
    const refresh = container.querySelector<HTMLElement>('[data-home-action="refresh"]')!;

    expect(refresh.textContent).toContain('Refreshing…');
    refresh.click();
    expect(onAction).not.toHaveBeenCalled();
  });
});
