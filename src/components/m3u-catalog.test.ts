// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../types';

const { storageMock } = vi.hoisted(() => ({
  storageMock: { getResume: vi.fn(() => null) },
}));

vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));

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
    container = document.createElement('div');
    document.body.appendChild(container);
    onPlay = vi.fn();
  });

  it('opens an M3U item in its detail screen before playback', () => {
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open([movie()], 'movie');

    (container.querySelector('[data-m3u-item^="channel:"]') as HTMLElement).click();

    expect(container.querySelector('.m3u-catalog-detail')?.textContent).toContain('Movie One');
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('offers saved progress and passes the selected start mode to playback', () => {
    storageMock.getResume.mockReturnValue({ position: 120 });
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open([movie()], 'movie');
    (container.querySelector('[data-m3u-item^="channel:"]') as HTMLElement).click();

    expect(container.querySelector('[data-key="resume"]')?.textContent).toContain('Resume');
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
      id === m3uItemKey(second) ? { position: 120 } : null);
    const catalog = new M3uCatalog(container, onPlay);
    catalog.open([first, second], 'series');

    (container.querySelector('[data-m3u-item^="series:"]') as HTMLElement).click();
    expect(container.querySelector('.m3u-series-detail')?.textContent).toContain('Show One');
    (container.querySelector('[data-m3u-season="2"]') as HTMLElement).click();
    (container.querySelector(`[data-m3u-episode="${m3uItemKey(second)}"]`) as HTMLElement).click();

    expect(onPlay).toHaveBeenCalledWith(second, true);
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
});
