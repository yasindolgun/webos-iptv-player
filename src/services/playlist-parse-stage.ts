import { CONFIG } from '../config';
import type { Channel } from '../types';
import {
  openPersistenceTransaction,
  PLAYLIST_STAGING_STORE,
  requestResult,
  transactionDone,
} from './idb-database';

interface StagedPlaylistBatch {
  key: string;
  channels: Channel[];
}

export class PlaylistParseStage {
  private writtenBatches = 0;
  private readBatches = 0;
  private writtenChannels = 0;
  private writing = true;

  private constructor(private readonly stageId: string) {}

  static async begin(stageId: string): Promise<PlaylistParseStage> {
    if (!stageId) throw new Error('Playlist parse stage requires an id');
    const readTx = await openPersistenceTransaction(PLAYLIST_STAGING_STORE, 'readonly');
    if (!readTx) throw new Error('Playlist parse staging requires IndexedDB');
    const prefix = `${stageId}:`;
    const keys = await requestResult(readTx.objectStore(PLAYLIST_STAGING_STORE).getAllKeys(
      IDBKeyRange.bound(prefix, `${prefix}\uffff`),
    ));
    await transactionDone(readTx);
    if (keys.length) {
      const writeTx = await openPersistenceTransaction(PLAYLIST_STAGING_STORE, 'readwrite');
      if (!writeTx) throw new Error('Playlist parse staging became unavailable');
      const store = writeTx.objectStore(PLAYLIST_STAGING_STORE);
      for (const key of keys) store.delete(key);
      await transactionDone(writeTx);
    }
    return new PlaylistParseStage(stageId);
  }

  get batchCount(): number {
    return this.writtenBatches;
  }

  get channelCount(): number {
    return this.writtenChannels;
  }

  async add(channels: Channel[]): Promise<void> {
    if (!this.writing) throw new Error('Playlist parse stage is closed for writing');
    if (!channels.length || channels.length > CONFIG.M3U.RESULT_BATCH_SIZE) {
      throw new Error('Playlist parse stage batch is outside the configured bound');
    }
    const tx = await openPersistenceTransaction(PLAYLIST_STAGING_STORE, 'readwrite');
    if (!tx) throw new Error('Playlist parse staging became unavailable');
    tx.objectStore(PLAYLIST_STAGING_STORE).put({
      key: this.key(this.writtenBatches),
      channels,
    } satisfies StagedPlaylistBatch);
    await transactionDone(tx);
    this.writtenBatches++;
    this.writtenChannels += channels.length;
  }

  finish(): void {
    if (!this.writing) throw new Error('Playlist parse stage is already closed');
    this.writing = false;
  }

  async take(limit: number): Promise<{ batches: Channel[][]; done: boolean }> {
    if (this.writing) throw new Error('Playlist parse stage is not ready');
    if (this.readBatches >= this.writtenBatches) {
      return { batches: [], done: true };
    }
    const count = Math.min(
      Math.max(1, Math.floor(limit)),
      this.writtenBatches - this.readBatches,
    );
    const tx = await openPersistenceTransaction(PLAYLIST_STAGING_STORE, 'readwrite');
    if (!tx) throw new Error('Playlist parse staging became unavailable');
    const store = tx.objectStore(PLAYLIST_STAGING_STORE);
    const requests: Array<Promise<StagedPlaylistBatch | undefined>> = [];
    for (let offset = 0; offset < count; offset++) {
      const key = this.key(this.readBatches + offset);
      requests.push(requestResult(store.get(key)) as Promise<StagedPlaylistBatch | undefined>);
      store.delete(key);
    }
    const records = await Promise.all(requests);
    const batches: Channel[][] = [];
    for (const batch of records) {
      if (!batch?.channels.length) {
        try { tx.abort(); } catch { /* The transaction may already be closing. */ }
        throw new Error('Playlist parse stage lost a result batch');
      }
      batches.push(batch.channels);
    }
    await transactionDone(tx);
    this.readBatches += count;
    return {
      batches,
      done: this.readBatches >= this.writtenBatches,
    };
  }

  async abort(): Promise<void> {
    this.writing = false;
    const tx = await openPersistenceTransaction(PLAYLIST_STAGING_STORE, 'readwrite');
    if (!tx) return;
    const store = tx.objectStore(PLAYLIST_STAGING_STORE);
    for (let index = this.readBatches; index < this.writtenBatches; index++) {
      store.delete(this.key(index));
    }
    await transactionDone(tx);
  }

  private key(index: number): string {
    return `${this.stageId}:${String(index)}`;
  }
}
