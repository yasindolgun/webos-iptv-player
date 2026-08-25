import { test, expect, routePlaylist, seedPlaylist } from './helpers';

// App bootstrap / first run.
test.use({ startView: 'home' });

test('opens settings on first run when no playlist is configured', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(page.locator('.toast')).toContainText('playlist');
});

test('loads and renders channels from a configured playlist', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);

  await page.goto('/');

  await expect(page.locator('#view-home')).toBeVisible();
  await page.locator('[data-home-action="live"]').click();
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.getByText('Channel One')).toBeVisible();
  await expect(page.getByText('Channel Two')).toBeVisible();
});
