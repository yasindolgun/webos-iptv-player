// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ResumeEntry } from '../types';
import { loadUserRecords } from './idb-user-data';
import { StorageService } from './storage-service';

const episode = (
  accountId: string,
  seriesId: string,
  itemId: string,
): ResumeEntry => ({
  accountId,
  seriesId,
  kind: 'episode',
  itemId,
  name: 'Series Alpha - S1E1',
  poster: '',
  ext: 'mp4',
  position: 120,
  duration: 1_500,
  updatedAt: 100,
  watchlistOwner: { kind: 'series', itemId: seriesId },
});

describe('episode completion storage', () => {
  beforeEach(async () => {
    localStorage.clear();
    await StorageService.clearUserData();
    await StorageService.init();
  });

  it('records completion and removes resume progress in one persisted update', async () => {
    StorageService.setResume(episode('x1', 's1', 'e1'));
    StorageService.setEpisodeCompleted('x1', 's1', 'e1', true, 500);
    await StorageService.flush();

    expect(StorageService.getEpisodeCompletion('x1', 'e1')).toEqual({
      accountId: 'x1', seriesId: 's1', itemId: 'e1', completedAt: 500,
    });
    expect(StorageService.getResume('x1', 'episode', 'e1')).toBeNull();

    const records = await loadUserRecords('playback-progress');
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'completed:x1|e1' }),
    ]));
    expect(records.some(record => record.key === 'resume:x1|episode|e1')).toBe(false);
  });

  it('keeps completion when an episode is replayed from the beginning', () => {
    StorageService.setEpisodeCompleted('x1', 's1', 'e1', true, 500);
    StorageService.setResume(episode('x1', 's1', 'e1'));

    expect(StorageService.getEpisodeCompletion('x1', 'e1')).not.toBeNull();
    expect(StorageService.getResume('x1', 'episode', 'e1')?.position).toBe(120);
  });

  it('scopes matching episode identifiers to their account', () => {
    StorageService.setEpisodeCompleted('x1', 's1', 'e1', true, 500);
    StorageService.setEpisodeCompleted('x2', 's1', 'e1', true, 600);
    StorageService.setEpisodeCompleted('x1', 's1', 'e1', false);

    expect(StorageService.getEpisodeCompletion('x1', 'e1')).toBeNull();
    expect(StorageService.getEpisodeCompletion('x2', 'e1')?.completedAt).toBe(600);
  });

  it('clears only the selected series completion, resume, and history records', () => {
    const first = episode('x1', 's1', 'e1');
    const second = episode('x1', 's2', 'e2');
    StorageService.setEpisodeCompleted('x1', 's1', 'e1', true);
    StorageService.setEpisodeCompleted('x1', 's2', 'e2', true);
    StorageService.setResume(first);
    StorageService.setResume(second);
    StorageService.setWatchHistory(first);
    StorageService.setWatchHistory(second);

    StorageService.clearSeriesEpisodeHistory('x1', 's1');

    expect(StorageService.getEpisodeCompletion('x1', 'e1')).toBeNull();
    expect(StorageService.getResume('x1', 'episode', 'e1')).toBeNull();
    expect(StorageService.getWatchHistory('x1', 'episode', 'e1')).toBeNull();
    expect(StorageService.getEpisodeCompletion('x1', 'e2')).not.toBeNull();
    expect(StorageService.getResume('x1', 'episode', 'e2')).not.toBeNull();
    expect(StorageService.getWatchHistory('x1', 'episode', 'e2')).not.toBeNull();
  });
});
