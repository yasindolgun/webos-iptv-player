import { enterTab, expect, routePlaylist, seedPlaylist, test, type Page } from './helpers';

const M3U = [
  '#EXTM3U',
  '#EXTINF:-1 group-title="Movies",Film One',
  'http://host/movie-one.mp4',
  '#EXTINF:-1 group-title="Movies",Film Two',
  'http://host/movie-two.mp4',
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
  const tile = page.locator('#view-movies [data-m3u-item^="channel:"]').filter({
    hasText: 'Film One',
  });
  await expect(tile).toContainText('Film One');

  await tile.click();
  await expect(page.locator('#view-movies .m3u-catalog-detail')).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(page.locator('#view-movies .m3u-catalog-detail')).toHaveCount(0);
  await expect(tile).toContainText('Film One');
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

test('M3U catalog search filters virtual movie results', async ({ page }) => {
  await boot(page);
  await enterTab(page, 'movies');

  const search = page.locator('#view-movies .m3u-catalog-search');
  await search.fill('Two');
  const tiles = page.locator('#view-movies [data-m3u-item^="channel:"]');
  await expect(tiles).toHaveCount(1);
  await expect(tiles).toContainText('Film Two');
});

test('M3U catalog refresh fetches only once and reopens with fresh items', async ({ page }) => {
  let requests = 0;
  const refreshed = M3U.replace('Film Two', 'Film Three');
  await page.route('**/playlist.m3u', (route) => {
    requests++;
    return route.fulfill({
      status: 200,
      contentType: 'application/x-mpegurl',
      body: requests === 1 ? M3U : refreshed,
    });
  });
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');

  await expect(page.locator('#view-movies')).toContainText('Film Two');
  await page.locator('#view-movies [data-m3u-refresh]').click();

  await expect(page.locator('#view-movies')).toContainText('Film Three');
  await expect(page.locator('#view-movies')).not.toContainText('Film Two');
  expect(requests).toBe(2);
  expect(await page.evaluate(() => localStorage.getItem('iptv_playlist_last_refresh_at'))).toBeNull();
});

test('Settings refreshes only a saved unchanged M3U source', async ({ page }) => {
  let requests = 0;
  await page.route('**/playlist.m3u', (route) => {
    requests++;
    return route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: M3U });
  });
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'settings');

  const row = page.locator('#playlist-entries [data-source-entry]').first();
  const name = row.locator('.playlist-name');
  const refresh = row.locator('.refresh-playlist');
  await expect(refresh).toBeEnabled();

  await name.fill('Changed');
  await expect(refresh).toBeDisabled();
  await name.fill('Test');
  await expect(refresh).toBeEnabled();
  await refresh.click();

  await expect.poll(() => requests).toBe(2);
  expect(await page.evaluate(() => localStorage.getItem('iptv_playlist_last_refresh_at'))).toBeNull();
});
