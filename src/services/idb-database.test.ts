// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DB_NAME = 'iptv';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function deleteDatabase(): Promise<void> {
  await requestResult(indexedDB.deleteDatabase(DB_NAME));
}

async function createPublishedV4Database(): Promise<void> {
  const request = indexedDB.open(DB_NAME, 4);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('epg-cache', { keyPath: 'url' });
    request.result.createObjectStore('favorites', { keyPath: 'key' });
  };
  const database = await requestResult(request);
  const transaction = database.transaction(['epg-cache', 'favorites'], 'readwrite');
  transaction.objectStore('epg-cache').put({
    url: 'http://host/guide',
    expiresAt: 10,
    lastAccessedAt: 5,
    data: { channels: {} },
  });
  transaction.objectStore('favorites').put({ key: 'favorite:ch1', value: 'ch1' });
  await transactionDone(transaction);
  database.close();
}

let upgradedDatabase: IDBDatabase | null = null;

beforeEach(async () => {
  vi.resetModules();
  await deleteDatabase();
});

afterEach(async () => {
  upgradedDatabase?.close();
  upgradedDatabase = null;
  await deleteDatabase();
});

describe('persistence database migrations', () => {
  it('upgrades the published v4 schema to v6 without losing records', async () => {
    await createPublishedV4Database();
    const databaseModule = await import('./idb-database');

    upgradedDatabase = await databaseModule.openPersistenceDb();

    expect(upgradedDatabase?.version).toBe(6);
    expect(upgradedDatabase?.objectStoreNames.contains(
      databaseModule.CHANNEL_HEALTH_STORE,
    )).toBe(true);
    expect(upgradedDatabase?.objectStoreNames.contains(
      databaseModule.PLAYLIST_STAGING_STORE,
    )).toBe(true);
    const transaction = upgradedDatabase!.transaction(
      ['epg-cache', 'favorites'],
      'readonly',
    );
    const epgStore = transaction.objectStore('epg-cache');
    expect(epgStore.indexNames.contains('expiresAt')).toBe(true);
    expect(epgStore.indexNames.contains('lastAccessedAt')).toBe(true);
    await expect(requestResult(epgStore.get('http://host/guide'))).resolves.toMatchObject({
      url: 'http://host/guide',
      data: { channels: {} },
    });
    await expect(requestResult(transaction.objectStore('favorites').get('favorite:ch1')))
      .resolves.toEqual({ key: 'favorite:ch1', value: 'ch1' });
    await transactionDone(transaction);
  });
});
