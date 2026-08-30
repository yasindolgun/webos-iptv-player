// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../types';
import { CONFIG } from '../config';

const { storageMock, catalogSearchMock } = vi.hoisted(() => ({
  storageMock: {
    getResume: vi.fn(() => null),
    getWatchHistory: vi.fn(() => null),
    getWatchlist: vi.fn(() => []),
    toggleWatchlist: vi.fn(() => true),
    getPlaylists: vi.fn(() => [
      { id: 'p1', name: 'Playlist One', url: 'http://host/a' },
      { id: 'p2', name: 'Playlist Two', url: 'http://host/b' },
    ]),
  },
  catalogSearchMock: { query: vi.fn(), release: vi.fn(), warm: vi.fn() },
}));

vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
vi.mock('../workers/list-search-client', () => ({
  WorkerListSearch: class {
    query = catalogSearchMock.query;
    release = catalogSearchMock.release;
    warm = catalogSearchMock.warm;
  },
}));

import { M3uCatalog } from './m3u-catalog';
import { m3uAccountId, m3uItemKey } from '../utils/m3u-item';

const movie = (id = 'm1'): Channel => ({
  id,
  name: 'Movie One',
  logo: 'http://host/poster.jpg',
  group: 'Movies',
  sourceGroup: 'Movies',
  url: 'http://host/movie.mp4',
  extras: null,
  playlistIds: ['p1'],
  catchup: '',
  catchupSource: '',
  catchupDays: 0,
  contentKind: 'movie',
});

describe('M3uCatalog', () => {
  let container: HTMLElement;
  let onPlay: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.clearAllMocks();
    storageMock.getResume.mockReturnValue(null);
    storageMock.getWatchHistory.mockReturnValue(null);
    storageMock.getWatchlist.mockReturnValue([]);
    storageMock.toggleWatchlist.mockReturnValue(true);
    catalogSearchMock.query.mockResolvedValue([]);
    catalogSearchMock.warm.mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    onPlay = vi.fn();
  });

  it('opens an M3U item in its detail screen before playback', () => {
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open([movie()], 'movie');

    expect(catalogSearchMock.warm).toHaveBeenCalledTimes(1);
    (container.querySelector('[data-m3u-item^="channel:"]') as HTMLElement).click();

    expect(container.querySelector('.m3u-catalog-detail')?.textContent).toContain('Movie One');
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('releases the M3U worker index when its view is left', () => {
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open([movie()], 'movie');
    expect(container.hasAttribute('data-self-activate')).toBe(true);
    catalog.deactivate();

    expect(catalogSearchMock.release).toHaveBeenCalled();
    expect(container.hasAttribute('data-self-activate')).toBe(false);
  });

  it('offers saved progress and passes the selected start mode to playback', () => {
    storageMock.getResume.mockReturnValue({ position: 120, duration: 600, updatedAt: 1784662200000 });
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open([movie()], 'movie');
    (container.querySelector('[data-m3u-item^="channel:"]') as HTMLElement).click();

    expect(container.querySelector('[data-key="resume"]')?.textContent).toContain('Resume');
    expect(container.querySelector('.m3u-detail-history')?.textContent).toContain('2:00 / 10:00');
    expect(container.querySelector('.m3u-resume-date')?.textContent).toMatch(/^\d{2}\/\d{2}\/2026$/);
    expect(container.querySelector('.m3u-resume-fill')?.getAttribute('style')).toContain('20%');
    (container.querySelector('[data-key="resume"]') as HTMLElement).click();
    (container.querySelector('[data-key="play"]') as HTMLElement).click();

    expect(onPlay).toHaveBeenNthCalledWith(1, movie(), true);
    expect(onPlay).toHaveBeenNthCalledWith(2, movie(), false);
  });

  it('keeps M3U series progress separate from movie progress', () => {
    const episode = { ...movie('s1'), contentKind: 'series' as const };
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open([episode], 'series');
    (container.querySelector('[data-m3u-item^="channel:"]') as HTMLElement).click();

    expect(storageMock.getResume).toHaveBeenCalledWith(
      m3uAccountId(episode), 'episode', m3uItemKey(episode),
    );
  });

  it('uses distinct progress identities when M3U entries have no tvg-id', () => {
    const first = { ...movie(''), url: 'http://host/first.mp4' };
    const second = { ...movie(''), url: 'http://host/second.mp4' };
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open([first, second], 'movie');

    const entries = Array.from(container.querySelectorAll<HTMLElement>('[data-m3u-item^="channel:"]'));
    expect(entries).toHaveLength(2);
    expect(entries[0].dataset.m3uItem).not.toBe(entries[1].dataset.m3uItem);
    entries[1].click();

    expect(storageMock.getResume).toHaveBeenCalledWith(
      m3uAccountId(second), 'vod', m3uItemKey(second),
    );
  });

  it('queries the selected M3U catalog category through the worker', async () => {
    const first = movie('first');
    const second = { ...movie('second'), name: 'Second Movie' };
    catalogSearchMock.query.mockResolvedValue([second]);
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open([first, second], 'movie');

    const input = container.querySelector<HTMLInputElement>('.m3u-catalog-search')!;
    input.value = 'second';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.waitFor(() => expect(catalogSearchMock.query).toHaveBeenCalledTimes(1));
    const [source, query, limit] = catalogSearchMock.query.mock.calls[0];
    expect(source.map((item: { name: string }) => item.name)).toEqual(['Movie One', 'Second Movie']);
    expect(query).toBe('second');
    expect(limit).toBe(CONFIG.M3U.CATALOG_SEARCH_RESULT_CAP);
    expect(container.textContent).toContain('Second Movie');
    expect(container.textContent).not.toContain('Movie One');
  });

  it('opens structured M3U series by season and resumes an episode', () => {
    const first = {
      ...movie('e1'), name: 'Show One S01E01 - First', group: 'Series', sourceGroup: 'Series',
      contentKind: 'series' as const,
    };
    const second = {
      ...movie('e2'), name: 'Show One S02E01 - Next', group: 'Series', sourceGroup: 'Series',
      contentKind: 'series' as const,
    };
    storageMock.getResume.mockImplementation((_account: string, _kind: string, id: string) =>
      id === m3uItemKey(second) ? { position: 120, duration: 600, updatedAt: 1784662200000 } : null);
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open([first, second], 'series');

    (container.querySelector('[data-m3u-item^="series:"]') as HTMLElement).click();
    expect(container.querySelector('.m3u-series-detail')?.textContent).toContain('Show One');
    expect(container.querySelector('.catalog-hero-kicker')?.textContent).toContain('Series');
    (container.querySelector('[data-m3u-season="2"]') as HTMLElement).click();
    (container.querySelector(`[data-m3u-episode="${m3uItemKey(second)}"]`) as HTMLElement).click();

    expect(onPlay).toHaveBeenCalledWith(second, true);
    expect(container.querySelector('.episode-resume')?.textContent).toContain('2:00 / 10:00');
  });

  it('moves focus between M3U movie detail actions by remote control', () => {
    storageMock.getResume.mockReturnValue({ position: 120, duration: 600, updatedAt: 1784662200000 });
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open([movie()], 'movie');
    (container.querySelector('[data-m3u-item^="channel:"]') as HTMLElement).click();

    (container.querySelector('[data-key="play"]') as HTMLElement)
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    catalog.handleAction('select');

    expect(onPlay).toHaveBeenCalledWith(movie(), false);
  });

  it('shows completed M3U playback as watched without offering a resume', () => {
    storageMock.getWatchHistory.mockReturnValue({
      position: 600, duration: 600, updatedAt: 1784662200000,
    });
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open([movie()], 'movie');
    (container.querySelector('[data-m3u-item^="channel:"]') as HTMLElement).click();

    expect(container.querySelector('.m3u-detail-history')?.textContent).toContain('Watched');
    expect(container.querySelector('[data-key="resume"]')).toBeNull();
    expect(container.querySelector('[data-key="play"]')?.textContent).toContain('Play');
  });

  it('keeps M3U movies in a persistent watchlist', () => {
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open([movie()], 'movie');
    (container.querySelector('[data-m3u-item^="channel:"]') as HTMLElement).click();
    (container.querySelector('[data-key="watchlist"]') as HTMLElement).click();

    expect(storageMock.toggleWatchlist).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'm3u-vod',
      itemId: m3uItemKey(movie()),
      name: 'Movie One',
    }));
  });

  it('keeps an M3U series in a separate persistent watchlist', () => {
    const episode = {
      ...movie('s1'), name: 'Show One S01E01 - First', group: 'Series', sourceGroup: 'Series',
      contentKind: 'series' as const,
    };
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open([episode], 'series');
    (container.querySelector('[data-m3u-item^="series:"]') as HTMLElement).click();
    (container.querySelector('[data-key="watchlist"]') as HTMLElement).click();

    expect(storageMock.toggleWatchlist).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'm3u-series',
      name: 'Show One',
    }));
  });

  it('filters M3U catalog items by source and watchlist', () => {
    const first = movie('m1');
    const second = { ...movie('m2'), name: 'Second Movie', playlistIds: ['p2'] };
    storageMock.getWatchlist.mockImplementation((account: string, kind: string) =>
      kind === 'm3u-vod' && account === m3uAccountId(first)
        ? [{ accountId: account, kind, itemId: m3uItemKey(first) }]
        : []);
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open([first, second], 'movie');

    (container.querySelector('[data-m3u-source="p2"]') as HTMLElement).click();
    expect(container.textContent).toContain('Second Movie');
    expect(container.textContent).not.toContain('Movie One');

    (container.querySelector('[data-m3u-source=""]') as HTMLElement).click();
    (container.querySelector('[data-m3u-watchlist]') as HTMLElement).click();
    expect(container.textContent).toContain('Movie One');
    expect(container.textContent).not.toContain('Second Movie');
  });

  it('moves remote focus beyond the rendered M3U window', () => {
    const movies = Array.from({ length: 32 }, (_, index) => ({
      ...movie(`m${index}`), name: `Movie ${index}`,
    }));
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open(movies, 'movie');
    const first = container.querySelector<HTMLElement>('[data-m3u-item-index="0"]')!;
    first.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));

    for (let index = 0; index < 20; index++) catalog.handleAction('down');

    expect(container.querySelector('[data-m3u-item-index="20"]')).not.toBeNull();
    expect(container.querySelector('.m3u-catalog-scroll')?.scrollTop).toBeGreaterThan(0);
  });

  it('yields before preparing a large M3U catalog', async () => {
    const movies = Array.from({ length: CONFIG.M3U.CATALOG_FRAME_THRESHOLD + 1 }, (_, index) => ({
      ...movie(`m${index}`), name: `Movie ${index}`,
    }));
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open(movies, 'movie');

    expect(container.querySelector('.catalog-loading')).not.toBeNull();
    await vi.waitFor(() => expect(
      container.querySelector('[data-m3u-item-index="0"]'),
    ).not.toBeNull());

    catalog.open(movies, 'movie');
    expect(container.querySelector('.catalog-loading')).toBeNull();
    expect(container.querySelector('[data-m3u-item-index="0"]')).not.toBeNull();
  });

  it('shows source refresh only when configured and prevents duplicate requests', async () => {
    const withoutRefresh = new M3uCatalog(container, onPlay);
    withoutRefresh.open([movie()], 'movie');
    expect(container.querySelector('[data-m3u-refresh]')).toBeNull();

    let finishRefresh: (() => void) | null = null;
    const onRefresh = vi.fn(() => new Promise<void>(resolve => {
      finishRefresh = resolve;
    }));
    const catalog = new M3uCatalog(container, onPlay, onRefresh);
    catalog.open([movie()], 'movie');

    (container.querySelector('[data-m3u-refresh]') as HTMLElement).click();
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-m3u-refresh]')?.getAttribute('aria-disabled')).toBe('true');

    const button = container.querySelector<HTMLElement>('[data-m3u-refresh]')!;
    button.click();
    button.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    catalog.handleAction('select');
    expect(onRefresh).toHaveBeenCalledOnce();

    finishRefresh?.();
    await vi.waitFor(() => expect(
      container.querySelector('[data-m3u-refresh]')?.getAttribute('aria-disabled'),
    ).toBe('false'));
  });
});
