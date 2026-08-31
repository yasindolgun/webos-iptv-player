// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from '../types';
import {
  openPersistenceTransaction,
  PLAYLIST_STAGING_STORE,
  requestResult,
  transactionDone,
} from './idb-database';
import { PlaylistParseStage } from './playlist-parse-stage';

function channel(index: number): Channel {
  return {
    id: `ch${String(index)}`,
    name: `ch${String(index)}`,
    logo: '',
    group: '',
    url: `http://host/${String(index)}`,
    extras: null,
    playlistIds: [],
    catchup: '',
    catchupSource: '',
    catchupDays: 0,
  };
}

async function stageRecordCount(): Promise<number> {
  const tx = await openPersistenceTransaction(PLAYLIST_STAGING_STORE, 'readonly');
  if (!tx) return 0;
  const count = await requestResult(tx.objectStore(PLAYLIST_STAGING_STORE).count());
  await transactionDone(tx);
  return count;
}

describe('PlaylistParseStage', () => {
  beforeEach(async () => {
    const tx = await openPersistenceTransaction(PLAYLIST_STAGING_STORE, 'readwrite');
    tx?.objectStore(PLAYLIST_STAGING_STORE).clear();
    if (tx) await transactionDone(tx);
  });

  it('reads and deletes bounded batches in write order', async () => {
    const stage = await PlaylistParseStage.begin('stage-1');
    await stage.add(Array.from({ length: 500 }, (_, index) => channel(index)));
    await stage.add([channel(500)]);
    stage.finish();

    expect(stage.batchCount).toBe(2);
    expect(stage.channelCount).toBe(501);
    expect(await stageRecordCount()).toBe(2);
    const result = await stage.take(6);
    expect(result.batches.map(batch => batch.length)).toEqual([500, 1]);
    expect(result.batches[0][0]).toEqual(channel(0));
    expect(result.done).toBe(true);
    expect(await stageRecordCount()).toBe(0);
  });

  it('removes unfinished records when aborted', async () => {
    const stage = await PlaylistParseStage.begin('stage-2');
    await stage.add([channel(0)]);

    await stage.abort();

    expect(await stageRecordCount()).toBe(0);
  });

  it('does not clear another active stage when a new stage begins', async () => {
    const first = await PlaylistParseStage.begin('stage-a');
    await first.add([channel(1)]);
    const second = await PlaylistParseStage.begin('stage-b');
    await second.add([channel(2)]);
    first.finish();
    second.finish();

    expect(await stageRecordCount()).toBe(2);
    expect((await first.take(1)).batches[0]).toEqual([channel(1)]);
    expect((await second.take(1)).batches[0]).toEqual([channel(2)]);
  });
});
