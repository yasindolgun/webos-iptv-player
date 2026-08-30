import {
  test,
  expect,
  seedPlaylist,
  routePlaylist,
  neuterVideo,
  type Page,
} from './helpers';
import { seedXtream } from './fixtures/xtream';
import type { ResumeEntry } from '../src/types';

test.use({ startView: 'home' });

test.beforeEach(async ({ page }) => {
  await seedPlaylist(page);
  await routePlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-home')).toBeVisible();
});

async function seedResume(page: Page, entry: ResumeEntry): Promise<void> {
  await page.evaluate((resume) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('iptv');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('playback-progress', 'readwrite');
      tx.objectStore('playback-progress').put({
        key: `resume:${resume.accountId}|${resume.kind}|${resume.itemId}`,
        value: resume,
        updatedAt: resume.updatedAt,
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  }), entry);
}

function channelKey(url: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < url.length; index++) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function applyPendingResume(page: Page, duration: number): Promise<number> {
  return page.locator('#video-player').evaluate((video, total) => {
    let current = 0;
    Object.defineProperty(video, 'duration', { configurable: true, get: () => total });
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => current,
      set: value => { current = value; },
    });
    video.dispatchEvent(new Event('loadedmetadata'));
    return current;
  }, duration);
}

test('launches into the remote-friendly home dashboard', async ({ page }) => {
  const cards = page.locator('[data-home-action]');
  await expect(cards).toHaveCount(7);
  await expect(page.locator('[data-home-action="live"]')).toHaveClass(/focused/);
  await expect(page.locator('.home-version')).toContainText('Version');

  const live = await page.locator('[data-home-action="live"]').boundingBox();
  const movies = await page.locator('[data-home-action="movies"]').boundingBox();
  expect(live).not.toBeNull();
  expect(movies).not.toBeNull();
  expect(movies!.x).toBeGreaterThan(live!.x);
});

test('opens Live with OK', async ({ page }) => {
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-channels')).toBeVisible();
});

test('reaches Settings with horizontal remote navigation', async ({ page }) => {
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[data-home-action="settings"]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-home-action="live"]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');

  await expect(page.locator('#view-settings')).toBeVisible();
});

test('Settings Cancel and Save return to Home', async ({ page }) => {
  const settings = page.locator('[data-home-action="settings"]');
  await settings.click();
  await page.locator('#cancel-settings').click();
  await expect(page.locator('#view-home')).toBeVisible();

  await settings.click();
  await page.locator('#save-settings').click();
  await expect(page.locator('#view-home')).toBeVisible();
});

test('opens and plays a movie from Home', async ({ page }) => {
  await seedXtream(page);
  await page.goto('/');
  await expect(page.locator('#view-home')).toBeVisible();

  await page.locator('[data-home-action="movies"]').click();
  const movie = page.locator('#view-movies .catalog-tile[data-item-id="10"]').first();
  await expect(movie).toBeVisible();
  await movie.click();
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
  await page.locator('#view-movies [data-action="play"]').click();

  await expect(page.locator('#view-player')).toBeVisible();
});

test('resumes an Xtream movie directly from Home', async ({ page }) => {
  await seedXtream(page);
  await seedResume(page, {
    accountId: 'x1',
    kind: 'vod',
    itemId: '10',
    name: 'Movie One',
    poster: '',
    ext: 'mp4',
    position: 120,
    duration: 600,
    updatedAt: 2000,
  });
  await page.goto('/');

  const resume = page.locator('[data-home-action="continue"]');
  await expect(resume).toContainText('Movie One');
  await resume.click();

  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#player-osd .osd-channel-name')).toHaveText('Movie One');
  expect(await applyPendingResume(page, 600)).toBe(120);
  await page.keyboard.press('Escape');
  await expect(page.locator('#view-home')).toBeVisible();
});

test('opens and plays a series episode from Home', async ({ page }) => {
  await seedXtream(page);
  await page.goto('/');
  await expect(page.locator('#view-home')).toBeVisible();

  await page.locator('[data-home-action="series"]').click();
  const series = page.locator('#view-series .catalog-tile[data-item-id="20"]').first();
  await expect(series).toBeVisible();
  await series.click();
  const episode = page.locator('#view-series [data-episode-id="11"]');
  await expect(episode).toBeVisible();
  await episode.click();

  await expect(page.locator('#view-player')).toBeVisible();
});

test('Back from Live returns to Home instead of exiting', async ({ page }) => {
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-channels')).toBeVisible();

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-home')).toBeVisible();
});

test('Back on Home requires a second press to exit', async ({ page }) => {
  await page.evaluate(() => {
    const state = window as unknown as {
      __exitCalls: number;
      webOS?: { platformBack?: () => void };
    };
    state.__exitCalls = 0;
    state.webOS = state.webOS ?? {};
    state.webOS.platformBack = () => { state.__exitCalls++; };
  });

  await page.keyboard.press('Escape');
  await expect(page.locator('.toast.visible')).toContainText('Press back again');
  expect(await page.evaluate(() =>
    (window as unknown as { __exitCalls: number }).__exitCalls)).toBe(0);

  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __exitCalls: number }).__exitCalls)).toBe(1);
});

test('opens and plays an M3U movie from Home', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      name: 'Test',
      url: 'http://host/movie-playlist.m3u',
    }]));
  });
  await page.route('**/movie-playlist.m3u', route => route.fulfill({
    status: 200,
    contentType: 'application/x-mpegurl',
    body: [
    '#EXTM3U',
    '#EXTINF:-1 group-title="Movies",Film One',
    'http://host/movie-one.mp4',
    ].join('\n'),
  }));
  await page.route('**/movie-one.mp4', route =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await neuterVideo(page);
  await page.goto('/');
  await expect(page.locator('#view-home')).toBeVisible();

  await page.locator('[data-home-action="movies"]').click();
  const movie = page.locator('#view-movies [data-m3u-item^="channel:"]').first();
  await expect(movie).toContainText('Film One');
  await movie.click();
  await page.locator('#view-movies [data-key="play"]').click();

  await expect(page.locator('#view-player')).toBeVisible();
});

test('resumes an M3U movie directly from Home', async ({ page }) => {
  const url = 'http://host/a.mp4';
  const accountId = 'm3u:p1';
  const itemId = `${accountId}:${channelKey(url)}`;
  await page.evaluate(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      id: 'p1',
      name: 'Playlist 1',
      url: 'http://host/movie-playlist.m3u',
      source: 'url',
    }]));
  });
  await seedResume(page, {
    accountId,
    kind: 'vod',
    itemId,
    name: 'Film One',
    poster: '',
    ext: 'mp4',
    position: 90,
    duration: 300,
    updatedAt: 3000,
  });
  await page.route('**/movie-playlist.m3u', route => route.fulfill({
    status: 200,
    contentType: 'application/x-mpegurl',
    body: ['#EXTM3U', '#EXTINF:-1 group-title="Movies",Film One', url].join('\n'),
  }));
  await page.route('**/a.mp4', route =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await neuterVideo(page);
  await page.goto('/');

  const resume = page.locator('[data-home-action="continue"]');
  await expect(resume).toContainText('Film One');
  await resume.click();

  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#player-osd .osd-channel-name')).toHaveText('Film One');
  expect(await applyPendingResume(page, 300)).toBe(90);
  await page.keyboard.press('Escape');
  await expect(page.locator('#view-home')).toBeVisible();
});
