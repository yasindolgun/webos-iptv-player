import { enterTab, expect, routePlaylist, seedPlaylist, test, type Page } from './helpers';

const M3U = [
  '#EXTM3U',
  '#EXTINF:-1 group-title="Movies",Film One',
  'http://host/movie-one.mp4',
  '#EXTINF:-1 group-title="Series",Show One S01E01 - First',
  'http://host/show-one-s01e01.mp4',
].join('\n');

async function boot(page: Page): Promise<void> {
  await routePlaylist(page, M3U);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
}

test('M3U movie detail returns to its catalog with Back', async ({ page }) => {
  await boot(page);
  await enterTab(page, 'movies');
  const tile = page.locator('#view-movies [data-m3u-item^="channel:"]');
  await expect(tile).toContainText('Film One');

  await tile.click();
  await expect(page.locator('#view-movies .m3u-catalog-detail')).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(page.locator('#view-movies .m3u-catalog-detail')).toHaveCount(0);
  await expect(page.locator('#view-movies [data-m3u-item^="channel:"]')).toContainText('Film One');
});

test('M3U series groups recognized episodes by season', async ({ page }) => {
  await boot(page);
  await enterTab(page, 'series');
  const tile = page.locator('#view-series [data-m3u-item^="series:"]');
  await expect(tile).toContainText('Show One');

  await tile.click();
  await expect(page.locator('#view-series .m3u-series-detail')).toBeVisible();
  await expect(page.locator('#view-series [data-m3u-season="1"]')).toBeVisible();
  await expect(page.locator('#view-series [data-m3u-episode^="m3u:"]')).toContainText('First');
});
