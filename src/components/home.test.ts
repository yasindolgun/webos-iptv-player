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
    accountName: '',
    accountStatus: null,
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

  it('keeps vertical D-pad movement geometric', () => {
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

    home.handleAction('down');
    home.handleAction('select');

    expect(onAction).toHaveBeenCalledWith('epg');
  });

  it('cycles horizontally through available cards and reaches Settings', () => {
    open({ hasMovies: false, hasSeries: false, resume: null });

    home.handleAction('right');
    expect(container.querySelector('[data-home-action="epg"]')?.classList.contains('focused'))
      .toBe(true);
    home.handleAction('right');
    home.handleAction('right');
    expect(container.querySelector('[data-home-action="settings"]')?.classList.contains('focused'))
      .toBe(true);
    home.handleAction('right');
    expect(container.querySelector('[data-home-action="live"]')?.classList.contains('focused'))
      .toBe(true);
    home.handleAction('left');
    home.handleAction('select');

    expect(onAction).toHaveBeenCalledWith('settings');
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

  it('shows a credential-free account status with its checked time', () => {
    open({
      accountName: 'Alpha',
      accountStatus: {
        state: 'active',
        expiresAt: null,
        maxConnections: 2,
        activeConnections: 1,
        checkedAt: new Date(2026, 0, 2, 3, 4, 5).getTime(),
      },
    });

    const status = container.querySelector('.home-account-status');
    expect(status?.textContent).toContain('Alpha');
    expect(status?.textContent).toContain('Active');
    expect(status?.textContent).toContain('never expires');
    expect(status?.textContent).toContain('1/2 connections');
    expect(status?.textContent).toContain('Checked');
  });

  it('shows account dates in day/month/year order', () => {
    open({
      accountName: 'Alpha',
      accountStatus: {
        state: 'active',
        expiresAt: Date.UTC(2026, 0, 2) / 1000,
        maxConnections: 2,
        activeConnections: 1,
        checkedAt: new Date(2026, 10, 3, 4, 5, 6).getTime(),
      },
    });

    const status = container.querySelector('.home-account-status');
    expect(status?.textContent).toContain('02/01/2026');
    expect(status?.textContent).toContain('03/11/2026 04:05:06');
  });
});
