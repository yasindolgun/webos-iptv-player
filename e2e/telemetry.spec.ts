import { test, expect, enterTab, routePlaylist, seedPlaylist } from './helpers';

test('global errors are masked and explicit Back exit sends the session end', async ({ page }) => {
  const bodies: string[] = [];
  await page.route('http://host:4318/api/v1/events', async route => {
    bodies.push(route.request().postData()!);
    await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.addInitScript(() => {
    localStorage.setItem('iptv_telemetry_config', JSON.stringify({ enabled: true, endpoint: 'host' }));
  });
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await page.evaluate(() => {
    window.close = () => document.documentElement.setAttribute('data-test-closed', 'true');
    for (let index = 0; index < 25; index++) {
      window.dispatchEvent(new ErrorEvent('error', {
        message: '{"token":"synthetic-secret","code":42}',
        error: new Error('{"password":"synthetic-secret","code":42}'),
      }));
    }
  });
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#view-home')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.toast.visible')).toContainText('Press back again');
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-test-closed', 'true');
  const delivered = bodies.flatMap(body => JSON.parse(body).events);
  expect(delivered.some(event => event.event === 'session.end')).toBe(true);
  expect(delivered.some(event => event.event === 'globalerror.error' && event.message.includes('42'))).toBe(true);
  for (const body of bodies) {
    expect(body).not.toContain('synthetic-secret');
    expect(JSON.parse(body).events.length).toBeLessThanOrEqual(25);
  }
});

test('diagnostics test, save, Cancel, and reload use the same endpoint', async ({ page }) => {
  const endpoint = 'http://host:4318/api/v1/events';
  const requests: { events: { event: string }[] }[] = [];
  await page.route(endpoint, async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await enterTab(page, 'settings');
  await page.locator('#telemetry-endpoint').fill('host');
  await page.locator('#test-telemetry').click();
  await expect(page.locator('#telemetry-test-status')).toContainText('Test event received');
  expect(requests).toHaveLength(1);
  expect(requests[0].events[0].event).toBe('telemetry.connection.test');
  expect(await page.evaluate(() => localStorage.getItem('iptv_telemetry_config'))).toBeNull();

  await page.locator('#telemetry-enabled [data-value="on"]').click();
  await page.locator('#save-settings').click();
  await expect(page.locator('#view-channels')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('iptv_telemetry_config')!)))
    .toEqual({ enabled: true, endpoint });

  await page.reload();
  await enterTab(page, 'settings');
  await expect(page.locator('#telemetry-endpoint')).toHaveValue(endpoint);
  await expect(page.locator('#telemetry-enabled .active')).toHaveAttribute('data-value', 'on');
  await page.locator('#telemetry-endpoint').fill('host:9000');
  await page.locator('#telemetry-enabled [data-value="off"]').click();
  await page.locator('#cancel-settings').click();
  await enterTab(page, 'settings');
  await expect(page.locator('#telemetry-endpoint')).toHaveValue(endpoint);
  await expect(page.locator('#telemetry-enabled .active')).toHaveAttribute('data-value', 'on');

  await page.locator('#telemetry-enabled [data-value="off"]').click();
  await page.locator('#save-settings').click();
  await page.reload();
  await enterTab(page, 'settings');
  await expect(page.locator('#telemetry-enabled .active')).toHaveAttribute('data-value', 'off');
  expect(await page.evaluate(() => localStorage.getItem('iptv_telemetry_active_session'))).toBeNull();
});

test('invalid or unpersisted diagnostics settings stay on the form and remain disabled', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await enterTab(page, 'settings');
  await page.locator('#telemetry-enabled [data-value="on"]').click();
  await page.locator('#telemetry-endpoint').fill('host?token=synthetic-secret');
  await page.locator('#save-settings').click();
  await expect(page.locator('.toast.visible')).toContainText('valid HTTP(S)');
  await expect(page.locator('#view-settings')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('iptv_telemetry_config'))).toBeNull();

  await page.locator('#telemetry-endpoint').fill('host');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'iptv_telemetry_config') throw new Error('storage unavailable');
      original.call(this, key, value);
    };
  });
  await page.locator('#save-settings').click();
  await expect(page.locator('.toast.visible')).toContainText('Unable to save changes');
  await expect(page.locator('#view-settings')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('iptv_telemetry_config'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('iptv_telemetry_active_session'))).toBeNull();
});
