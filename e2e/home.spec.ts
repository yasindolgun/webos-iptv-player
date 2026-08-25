import { test, expect, seedPlaylist, routePlaylist, neuterVideo } from './helpers';
import { seedXtream } from './fixtures/xtream';

test.use({ startView: 'home' });

test.beforeEach(async ({ page }) => {
  await seedPlaylist(page);
  await routePlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-home')).toBeVisible();
});

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
