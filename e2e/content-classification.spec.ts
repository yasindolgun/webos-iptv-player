import { enterTab, expect, seedPlaylist, test, type Page } from './helpers';

test.use({ startView: 'home' });

const fixture = [
  '#EXTM3U',
  '#EXTINF:-1 group-title="Series",Alpha Part 1', 'http://host/play/ch1',
  '#EXTINF:-1 group-title="Series",Alpha Part 2', 'http://host/a.m3u8',
  '#EXTINF:-1 group-title="Series",Alpha 24/7', 'http://host/play/ch2',
  '#EXTINF:-1 group-title="Series",Alpha Live', 'http://host/service/live/u/p/ch3.ts',
].join('\n');

async function checkSurfaces(page: Page): Promise<void> {
  await expect(page.locator('#view-home')).toBeVisible();
  await expect(page.locator('[data-home-action="series"]')).toHaveAttribute('aria-disabled', 'false');
  await page.locator('[data-home-action="live"]').click();
  await expect(page.locator('#view-channels .channel-item').filter({ hasText: 'Alpha 24/7' })).toBeVisible();
  await enterTab(page, 'series');
  const tiles = page.locator('#view-series [data-m3u-item]');
  await expect(tiles).toHaveCount(2);
  await expect(tiles).toContainText(['Alpha Part 1', 'Alpha Part 2']);
  await enterTab(page, 'search');
  await page.locator('.tab-bar-search-input').fill('alpha');
  const series = page.locator('#view-search [data-search-virtual="series"]');
  await expect(series).toContainText('Alpha Part 1');
  await expect(series).toContainText('Alpha Part 2');
  await expect(series).not.toContainText('Alpha 24/7');
  const live = page.locator('#view-search [data-search-virtual="channels-rail"]');
  await expect(live).toContainText('Alpha 24/7');
  await expect(live).toContainText('Alpha Live');
  await expect(live).not.toContainText('Alpha Part');
}

test('classification survives worker parsing, cache restart, and source refresh', async ({ page }) => {
  let requests = 0;
  await page.route('http://host/playlist.m3u', route => {
    requests++;
    return route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: fixture });
  });
  await seedPlaylist(page, 'http://host/playlist.m3u');
  await page.goto('/');
  await checkSurfaces(page);
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const request = indexedDB.open('iptv');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('playlist-cache', 'readonly');
      const read = tx.objectStore('playlist-cache').get('combined');
      tx.oncomplete = () => { db.close(); resolve(!!read.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }))).toBe(true);
  expect(requests).toBe(1);
  await page.reload();
  await checkSurfaces(page);
  expect(requests).toBe(1);
  await enterTab(page, 'series');
  await page.locator('#view-series [data-m3u-refresh]').click();
  await expect.poll(() => requests).toBe(2);
  await expect(page.locator('#view-series [data-m3u-item]')).toHaveCount(2);
  await page.reload();
  await checkSurfaces(page);
  expect(requests).toBe(2);
});
