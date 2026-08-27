import { describe, expect, it } from 'vitest';
import { BackupStore } from './store';

const archive = {
  schema: 'webos-iptv-player-backup',
  version: 1,
  appVersion: '1.0.0',
  exportedAt: 100,
  data: {
    favorites: [{ key: 'favorite:ch1', value: 'ch1' }],
    preferences: { theme: 'midnight' },
  },
};

describe('BackupStore', () => {
  it('exports only requested groups', () => {
    const store = new BackupStore();
    store.publish(archive);

    expect(store.export(['favorites'])).toEqual({
      ...archive,
      data: { favorites: archive.data.favorites },
    });
  });

  it('queues imports and retains a phone-readable final status', () => {
    const store = new BackupStore();
    const request = store.add({ archive, groups: ['favorites'], mode: 'merge' });

    expect(store.list()).toEqual([request]);
    expect(store.status(request.id)).toEqual({ id: request.id, status: 'pending' });
    expect(store.complete(request.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.status(request.id)).toEqual({ id: request.id, status: 'applied' });
  });

  it('reports import errors and rejects unknown versions and groups', () => {
    const store = new BackupStore();
    const request = store.add({ archive, groups: ['favorites'], mode: 'replace' });
    store.complete(request.id, 'Invalid favorite');
    expect(store.status(request.id)).toEqual({
      id: request.id,
      status: 'error',
      error: 'Invalid favorite',
    });
    expect(() => store.add({ archive, groups: ['unknown'], mode: 'merge' })).toThrow();
    expect(() => store.publish({ ...archive, version: 2 })).toThrow();
  });
});
