import { describe, expect, it } from 'vitest';
import { SearchWorkerIndex } from './search-index';

describe('SearchWorkerIndex', () => {
  it('indexes and ranks every search collection', () => {
    const index = new SearchWorkerIndex();
    expect(index.index({
      sessionId: 1,
      reset: true,
      channels: [['XAlpha', 'News'], ['Alpha', 'Drama']],
      programmes: [['Evening Report', 'News'], ['Alpha Report', 'Drama']],
    })).toEqual({ accepted: true });
    expect(index.catalog(1, [
      { id: 'm0', name: 'XAlpha Movie' },
      { id: 'm1', name: 'Alpha Movie' },
    ], [
      { id: 's0', name: 'XAlpha Series' },
      { id: 's1', name: 'Alpha Series' },
    ])).toEqual({ accepted: true });

    expect(index.query({
      sessionId: 1,
      query: 'alpha',
      limit: 10,
      includeCatalog: true,
    })).toEqual({
      channels: { indices: [1, 0], hasMore: false },
      programmes: { indices: [1], hasMore: false },
      movies: {
        documents: [{ id: 'm1', name: 'Alpha Movie' }, { id: 'm0', name: 'XAlpha Movie' }],
        hasMore: false,
      },
      series: {
        documents: [{ id: 's1', name: 'Alpha Series' }, { id: 's0', name: 'XAlpha Series' }],
        hasMore: false,
      },
    });
  });

  it('rejects stale index updates and queries', () => {
    const index = new SearchWorkerIndex();
    index.index({ sessionId: 2, reset: true, channels: [['Alpha']] });

    expect(index.index({ sessionId: 1, channels: [['Bravo']] }))
      .toEqual({ accepted: false });
    expect(index.query({
      sessionId: 1,
      query: 'alpha',
      limit: 10,
      includeCatalog: false,
    })).toBeNull();
    expect(index.query({
      sessionId: 2,
      query: 'alpha',
      limit: 10,
      includeCatalog: false,
    })?.channels.indices).toEqual([0]);
  });

  it('caps results and reports additional matches', () => {
    const index = new SearchWorkerIndex();
    index.index({ sessionId: 1, reset: true });
    index.catalog(1, [
      { id: 'm1', name: 'Alpha 1' },
      { id: 'm2', name: 'Alpha 2' },
      { id: 'm3', name: 'Alpha 3' },
    ], []);

    expect(index.query({
      sessionId: 1,
      query: 'alpha',
      limit: 2,
      includeCatalog: true,
    })?.movies).toEqual({
      documents: [{ id: 'm1', name: 'Alpha 1' }, { id: 'm2', name: 'Alpha 2' }],
      hasMore: true,
    });
  });
});
