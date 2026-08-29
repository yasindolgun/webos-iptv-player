// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as http from 'http';
import { startServer } from '../../bundled-service/src/lan/server';
import { BackupClient } from './backup-client';
import { StorageService } from './storage-service';
import { setServicePort } from './service-http';

let server: http.Server;
let baseUrl: string;
let setupToken: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-client-test-'));
  const result = await startServer(0, dataDir);
  server = result.server;
  baseUrl = `http://127.0.0.1:${result.port}`;
  setServicePort(result.port);
  const info = await (await fetch(`${baseUrl}/info`)).json() as { setupUrl: string };
  const fragment = new URL(info.setupUrl).hash.slice(1);
  setupToken = `?token=${new URLSearchParams(fragment).get('token')!}`;
});

afterAll(async () => {
  setServicePort(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  localStorage.clear();
  await StorageService.clearUserData();
  await StorageService.init();
  const pending = await (await fetch(`${baseUrl}/backup-import`)).json() as
    Array<{ id: number }>;
  for (const item of pending) {
    await fetch(`${baseUrl}/backup-import/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'test cleanup' }),
    });
  }
});

describe('BackupClient LAN synchronization', () => {
  it('publishes a filtered download and applies a queued import', async () => {
    StorageService.setFavorites(['ch1']);
    StorageService.set('online_subtitles', {
      preferredLanguage: 'l1',
      subdl: { apiKey: 'secret-key' },
    });
    await expect(BackupClient.publishArchive()).resolves.toBe(true);

    const downloaded = await fetch(
      `${baseUrl}/backup${setupToken}&groups=favorites`,
    );
    const archive = await downloaded.json() as {
      data: { favorites: Array<{ value: string }> };
    };
    expect(archive.data.favorites.map(item => item.value)).toEqual(['ch1']);
    expect(JSON.stringify(archive)).not.toContain('secret-key');

    StorageService.setFavorites(['ch2']);
    const queued = await fetch(`${baseUrl}/backup-import${setupToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archive, groups: ['favorites'], mode: 'replace' }),
    });
    const request = await queued.json() as { id: number };

    await expect(BackupClient.applyPendingImports()).resolves.toBe(true);
    expect(StorageService.getFavorites()).toEqual(['ch1']);
    expect(await (await fetch(
      `${baseUrl}/backup-import/${request.id}${setupToken}`,
    )).json()).toEqual({ id: request.id, status: 'applied' });
  });

  it('reports validation failures without mutating TV data', async () => {
    StorageService.setFavorites(['ch1']);
    await BackupClient.publishArchive();
    const archive = await (await fetch(
      `${baseUrl}/backup${setupToken}&groups=favorites`,
    )).json() as Record<string, unknown>;
    const queued = await fetch(`${baseUrl}/backup-import${setupToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        archive: { ...archive, data: {
          favorites: [{ key: 'favorite:ch2', value: { invalid: true } }],
        } },
        groups: ['favorites'],
        mode: 'replace',
      }),
    });
    const request = await queued.json() as { id: number };

    await expect(BackupClient.applyPendingImports()).resolves.toBe(false);
    expect(StorageService.getFavorites()).toEqual(['ch1']);
    expect(await (await fetch(
      `${baseUrl}/backup-import/${request.id}${setupToken}`,
    )).json()).toEqual({
      id: request.id,
      status: 'error',
      error: 'Invalid favorite',
    });
  });
});
