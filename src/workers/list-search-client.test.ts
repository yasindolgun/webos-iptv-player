// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { indexRequests } = vi.hoisted(() => ({
  indexRequests: [] as Array<{
    documents: string[][];
    offset?: number;
    reset?: boolean;
    complete?: boolean;
  }>,
}));

vi.mock('../utils/frame-slices', () => ({
  runInFrameSlices: async (
    step: () => boolean,
    options: { shouldContinue?: () => boolean } = {},
  ) => {
    while (options.shouldContinue?.() !== false) {
      if (step()) return true;
    }
    return false;
  },
}));

vi.mock('./app-worker-client', async () => {
  const { ScopedSearchIndex } = await import('./scoped-search-index');
  const index = new ScopedSearchIndex();
  return {
    retainAppWorker: () => () => undefined,
    runAppWorkerTask: (task: string, payload: never) => {
      if (task === 'list-search.index') {
        indexRequests.push(payload);
        return Promise.resolve(index.indexList(payload));
      }
      if (task === 'list-search.query') {
        return Promise.resolve(index.queryList(payload));
      }
      if (task === 'list-search.release') {
        return Promise.resolve(index.releaseList(payload));
      }
      return Promise.reject(new Error(`Unexpected worker task: ${task}`));
    },
  };
});

import { WorkerListSearch } from './list-search-client';

describe('WorkerListSearch', () => {
  beforeEach(() => indexRequests.splice(0));

  it('builds large indexes with bounded backpressured worker batches', async () => {
    const source = Array.from({ length: 12_001 }, (_, index) => ({
      name: `Alpha ${String(index)}`,
    }));
    source[12_000].name = 'Needle';
    const search = new WorkerListSearch(
      'bounded-test',
      'names',
      item => [item.name],
    );

    await expect(search.query(source, 'needle', 1)).resolves.toEqual([source[12_000]]);
    expect(indexRequests.map(request => request.documents.length)).toEqual([5_000, 5_000, 2_001]);
    expect(indexRequests.map(request => request.offset)).toEqual([0, 5_000, 10_000]);
    expect(indexRequests.map(request => request.reset)).toEqual([true, false, false]);
    expect(indexRequests.map(request => request.complete)).toEqual([false, false, true]);
  });

  it('publishes an empty index with one complete batch', async () => {
    const search = new WorkerListSearch<{ name: string }>(
      'empty-test',
      'names',
      item => [item.name],
    );

    await expect(search.query([], 'needle')).resolves.toEqual([]);
    expect(indexRequests).toEqual([
      expect.objectContaining({
        documents: [],
        offset: 0,
        reset: true,
        complete: true,
      }),
    ]);
  });
});
