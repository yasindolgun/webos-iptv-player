import { enterTab, expect, test, type Page } from './helpers';
import { seedXtream } from './fixtures/xtream';

const M3U = [
  '#EXTM3U',
  '#EXTINF:-1 group-title="Movies",Film One',
  'http://host/film-one.mp4',
  '#EXTINF:-1 group-title="Series",Show One S01E01 - First',
  'http://host/show-one-s01e01.mp4',
].join('\n');

async function bootMixed(page: Page): Promise<void> {
  await seedXtream(page);
  await page.route('**/mixed.m3u', route => route.fulfill({
    status: 200,
    contentType: 'application/x-mpegurl',
    body: M3U,
  }));
  await page.addInitScript(() => {
    const m3uDisabled = sessionStorage.getItem('m3uDisabled') === '1';
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
      { id: 'p1', name: 'M3U Source', url: 'http://host/mixed.m3u', source: 'url',
        enabled: !m3uDisabled },
    ]));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
}

async function openSourceMenu(page: Page): Promise<void> {
  const avatar = page.locator('.account-avatar');
  const box = await avatar.boundingBox();
  if (!box) throw new Error('catalog source avatar has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.account-menu')).toBeVisible();
}

async function pickSource(page: Page, id: string): Promise<void> {
  const row = page.locator(`.account-menu-item[data-account-id="${id}"]`);
  const box = await row.boundingBox();
  if (!box) throw new Error(`catalog source ${id} has no bounding box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test('Movies and Series keep independent Xtream and M3U sources', async ({ page }) => {
  await bootMixed(page);
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-tile[data-item-id="10"]'))
    .toContainText('Movie One');

  await openSourceMenu(page);
  await expect(page.locator('.account-menu-name')).toHaveText(['X Account', 'M3U Source']);
  await pickSource(page, 'm3u:p1');
  await expect(page.locator('#view-movies [data-m3u-item^="channel:"]'))
    .toContainText('Film One');

  await enterTab(page, 'series');
  await expect(page.locator('#view-series .catalog-tile[data-item-id="20"]'))
    .toContainText('Series One');
  await openSourceMenu(page);
  await pickSource(page, 'm3u:p1');
  await expect(page.locator('#view-series [data-m3u-item^="series:"]'))
    .toContainText('Show One');

  await page.reload();
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies [data-m3u-item^="channel:"]'))
    .toContainText('Film One');
  await enterTab(page, 'series');
  await expect(page.locator('#view-series [data-m3u-item^="series:"]'))
    .toContainText('Show One');

  await page.evaluate(() => {
    sessionStorage.setItem('m3uDisabled', '1');
    const key = 'iptv_playlists';
    const playlists = JSON.parse(localStorage.getItem(key) ?? '[]') as Array<{
      id: string;
      enabled?: boolean;
    }>;
    const m3u = playlists.find(source => source.id === 'p1');
    if (m3u) m3u.enabled = false;
    localStorage.setItem(key, JSON.stringify(playlists));
  });
  await page.reload();
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-tile[data-item-id="10"]'))
    .toContainText('Movie One');
  await expect(page.locator('.account-menu-item[data-account-id="m3u:p1"]'))
    .toHaveCount(0);
});
