// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChannelCustomization, ResumeEntry, WatchlistEntry } from '../types';
import { loadAllUserRecords } from './idb-user-data';
import { BackupService } from './backup-service';
import { StorageService } from './storage-service';

const customization: ChannelCustomization = {
  version: 1,
  overrides: { ch1: { name: 'Bravo', epgChannelId: 'epg1' } },
  order: ['ch1'],
  groupOrder: ['Group Alpha'],
  groupOverrides: { 'Group Alpha': { name: 'Group Bravo' } },
  customGroups: ['Group Bravo'],
};

const watchlist: WatchlistEntry = {
  accountId: 'x1',
  kind: 'vod',
  itemId: 'v1',
  name: 'Alpha',
  poster: 'http://host/a?token=secret',
  rating: '8',
  categoryId: 'c1',
  addedAt: 100,
};

const resume: ResumeEntry = {
  accountId: 'x1',
  kind: 'vod',
  itemId: 'v1',
  name: 'Alpha',
  poster: 'http://host/a?token=secret',
  ext: 'mp4',
  position: 120,
  duration: 3600,
  updatedAt: 200,
  episodeQueue: [{
    url: 'http://user:password@host/a',
    title: 'Bravo',
    poster: 'http://host/b',
    accountId: 'x1',
    itemId: 'v2',
    kind: 'episode',
    subtitles: [],
  }],
};

describe('BackupService', () => {
  beforeEach(async () => {
    localStorage.clear();
    await StorageService.clearUserData();
    await StorageService.init();
  });

  it('exports selected user data without credentials or stream URLs', async () => {
    StorageService.setFavorites(['ch1']);
    StorageService.setChannelCustomization(customization);
    StorageService.toggleWatchlist(watchlist);
    StorageService.setResume(resume);
    StorageService.setEpisodeCompleted('x1', 's1', 'e1', true, 300);
    StorageService.set('online_subtitles', {
      preferredLanguage: 'l1',
      subdl: { apiKey: 'secret-key' },
    });
    StorageService.setEpgOffsets({
      'http://host/a': 30,
      'http://user:password@host/b': 60,
      'http://host/c?token=secret': 90,
    });

    const archive = await BackupService.createArchive();
    const json = JSON.stringify(archive);

    expect(json).not.toContain('secret');
    expect(json).not.toContain('password');
    expect(json).not.toContain('episodeQueue');
    expect(archive.data.epg?.offsets).toEqual({ 'http://host/a': 30 });
    expect(archive.data.watchlist?.[0].value.poster).toBe('');
    expect(archive.data.playback?.find(item => item.key.indexOf('resume:') === 0)
      ?.value.poster).toBe('');
    expect(archive.data.playback).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'completed:x1|e1',
        value: {
          accountId: 'x1', seriesId: 's1', itemId: 'e1', completedAt: 300,
        },
      }),
    ]));
  });

  it('previews groups and restores only the selected group', async () => {
    StorageService.setFavorites(['ch1']);
    StorageService.setChannelCustomization(customization);
    const archive = await BackupService.createArchive(['favorites', 'customization']);
    StorageService.setFavorites(['ch2']);
    StorageService.clearChannelCustomization();
    await StorageService.flush();

    const preview = await BackupService.importArchive(
      archive,
      'replace',
      ['favorites'],
    );

    expect(preview.groups.map(group => group.id)).toEqual(['favorites', 'customization']);
    expect(StorageService.getFavorites()).toEqual(['ch1']);
    expect(StorageService.getChannelCustomization()).toBeNull();
  });

  it('restores EPG mappings without overwriting other channel customization', async () => {
    StorageService.setChannelCustomization(customization);
    StorageService.setEpgOffsets({ 'http://host/a': 30 });
    const archive = await BackupService.createArchive(['epg']);
    StorageService.setChannelCustomization({
      ...customization,
      overrides: { ch1: { name: 'Charlie', hidden: true } },
    });
    StorageService.setEpgOffsets({ 'http://host/b': 60 });

    await BackupService.importArchive(archive, 'replace');

    expect(StorageService.getChannelCustomization()?.overrides.ch1).toEqual({
      name: 'Charlie',
      hidden: true,
      epgChannelId: 'epg1',
    });
    expect(StorageService.getEpgOffsets()).toEqual({ 'http://host/a': 30 });
  });

  it('merges idempotently by stable record key', async () => {
    StorageService.setFavorites(['ch1']);
    const archive = await BackupService.createArchive(['favorites']);
    StorageService.setFavorites(['ch2']);

    await BackupService.importArchive(archive, 'merge');
    await BackupService.importArchive(archive, 'merge');

    expect(StorageService.getFavorites().sort()).toEqual(['ch1', 'ch2']);
    expect((await loadAllUserRecords()).favorites).toHaveLength(2);
  });

  it('canonicalizes imported favorite keys from their stable identifier', async () => {
    const archive = await BackupService.createArchive(['favorites']);
    const mismatched = {
      ...archive,
      data: { favorites: [{ key: 'favorite:wrong', value: 'ch1' }] },
    };

    await BackupService.importArchive(mismatched, 'replace');

    expect((await loadAllUserRecords()).favorites).toEqual([
      { key: 'favorite:ch1', value: 'ch1' },
    ]);
  });

  it('rejects a future schema version before mutating current data', async () => {
    StorageService.setFavorites(['ch1']);
    const archive = await BackupService.createArchive(['favorites']);
    const future = { ...archive, version: 2 };

    await expect(BackupService.importArchive(future, 'replace'))
      .rejects.toThrow('Unsupported backup version');
    expect(StorageService.getFavorites()).toEqual(['ch1']);
  });

  it('rejects malformed record shapes before writing', async () => {
    StorageService.setFavorites(['ch1']);
    const archive = await BackupService.createArchive(['favorites']);
    const malformed = {
      ...archive,
      data: { favorites: [{ key: 'favorite:ch2', value: { bad: true } }] },
    };

    await expect(BackupService.importArchive(malformed, 'replace'))
      .rejects.toThrow('Invalid favorite');
    expect(StorageService.getFavorites()).toEqual(['ch1']);
  });
});
