import { createLogger } from '../utils/logger';

const log = createLogger('PersistenceDB');

const DB_NAME = 'iptv';
const DB_VERSION = 6;

export const EPG_STORE = 'epg-cache';
export const CATALOG_STORE = 'catalog-cache';
export const SUBTITLE_STORE = 'subtitle-cache';
export const PLAYLIST_STORE = 'playlist-cache';
export const STREAM_MIME_STORE = 'stream-mime-cache';
export const CHANNEL_HEALTH_STORE = 'channel-health-cache';
export const PLAYLIST_STAGING_STORE = 'playlist-staging';
export const CACHE_META_STORE = 'cache-meta';
export const CACHE_STORES = [
  EPG_STORE,
  CATALOG_STORE,
  SUBTITLE_STORE,
  PLAYLIST_STORE,
  STREAM_MIME_STORE,
  CHANNEL_HEALTH_STORE,
] as const;
export type CacheStore = typeof CACHE_STORES[number];

export const USER_DATA_STORES = [
  'favorites',
  'reminders',
  'channel-state',
  'watchlist',
  'playback-progress',
  'recently-watched',
  'online-sub-picks',
] as const;
export type UserDataStore = typeof USER_DATA_STORES[number];
export const USER_META_STORE = 'user-meta';

let dbPromise: Promise<IDBDatabase | null> | null = null;
let activeDb: IDBDatabase | null = null;

function forgetDatabase(db: IDBDatabase): void {
  if (activeDb !== db) return;
  activeDb = null;
  dbPromise = null;
  try { db.close(); } catch { /* The connection is already closing. */ }
}

export function cacheKeyPath(store: CacheStore): 'url' | 'key' {
  return store === EPG_STORE ? 'url' : 'key';
}

function ensureCacheIndexes(store: IDBObjectStore): void {
  if (!store.indexNames.contains('expiresAt')) store.createIndex('expiresAt', 'expiresAt');
  if (!store.indexNames.contains('lastAccessedAt')) {
    store.createIndex('lastAccessedAt', 'lastAccessedAt');
  }
}

export function openPersistenceDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      log.warn(
        'IndexedDB unavailable',
        'event=persistence.db.unavailable',
        'operation=open',
      );
      resolve(null);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      log.info(
        'Upgrading persistence database',
        'event=persistence.db.upgrade',
        `from=${event.oldVersion}`,
        `to=${DB_VERSION}`,
      );
      const db = req.result;
      const tx = req.transaction;
      if (!tx) return;
      for (const storeName of CACHE_STORES) {
        let store: IDBObjectStore;
        if (!db.objectStoreNames.contains(storeName)) {
          store = db.createObjectStore(storeName, {
            keyPath: cacheKeyPath(storeName),
          });
        } else {
          store = tx.objectStore(storeName);
        }
        ensureCacheIndexes(store);
      }
      if (!db.objectStoreNames.contains(PLAYLIST_STAGING_STORE)) {
        db.createObjectStore(PLAYLIST_STAGING_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(CACHE_META_STORE)) {
        db.createObjectStore(CACHE_META_STORE, { keyPath: 'category' });
      }
      for (const storeName of USER_DATA_STORES) {
        if (db.objectStoreNames.contains(storeName)) continue;
        const store = db.createObjectStore(storeName, { keyPath: 'key' });
        if (storeName === 'watchlist') store.createIndex('scope', 'scope');
        if (storeName === 'playback-progress') {
          store.createIndex('expiresAt', 'expiresAt');
          store.createIndex('updatedAt', 'updatedAt');
        }
        if (storeName === 'recently-watched') store.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(USER_META_STORE)) {
        db.createObjectStore(USER_META_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      activeDb = db;
      db.onversionchange = () => {
        forgetDatabase(db);
      };
      db.onclose = () => { forgetDatabase(db); };
      resolve(db);
    };
    req.onerror = () => {
      log.warn(
        'Open failed',
        'event=persistence.db.open.failed',
        'operation=open',
        req.error,
      );
      dbPromise = null;
      resolve(null);
    };
    req.onblocked = () => {
      log.warn(
        'Open blocked',
        'event=persistence.db.open.blocked',
        'operation=open',
      );
      dbPromise = null;
      resolve(null);
    };
  });
  return dbPromise;
}

function isClosingConnection(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && (error as { name?: unknown }).name === 'InvalidStateError';
}

export async function openPersistenceTransaction(
  stores: string | string[] | readonly string[],
  mode: IDBTransactionMode,
): Promise<IDBTransaction | null> {
  let db = await openPersistenceDb();
  if (!db) return null;
  try {
    return db.transaction(stores, mode);
  } catch (error) {
    if (!isClosingConnection(error)) throw error;
    log.warn(
      'Database connection closed; reopening',
      'event=persistence.db.reopened',
      'operation=transaction',
    );
    forgetDatabase(db);
    db = await openPersistenceDb();
    return db ? db.transaction(stores, mode) : null;
  }
}

export function transactionDone(
  tx: IDBTransaction,
  onAbort?: (error: DOMException | null) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => {
      onAbort?.(tx.error);
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

export function requestResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}
