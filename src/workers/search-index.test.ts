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

  it('merges local M3U catalog documents with the Xtream catalog', () => {
    const index = new SearchWorkerIndex();
    const channels = Array.from({ length: 9 }, (_, itemIndex) => [`Item ${String(itemIndex)}`]);
    channels[4] = ['Alpha Local Movie'];
    channels[8] = ['Alpha Local Series'];
    index.index({
      sessionId: 1,
      reset: true,
      channels,
      localMovieIndices: [4],
      localSeriesIndices: [8],
    });
    index.catalog(
      1,
      [{ id: 'm1', name: 'Alpha Remote Movie' }],
      [{ id: 's1', name: 'Alpha Remote Series' }],
    );

    const result = index.query({
      sessionId: 1,
      query: 'alpha',
      limit: 10,
      includeCatalog: true,
    });

    expect(result?.movies.documents.map(item => item.id)).toEqual(['m3u:4', 'm1']);
    expect(result?.series.documents.map(item => item.id)).toEqual(['m3u:8', 's1']);
  });

  it('shares current channel indexes without accepting stale playlist revisions', () => {
    const index = new SearchWorkerIndex();
    index.index({
      sessionId: 3,
      reset: true,
      channelRevision: 7,
      channels: [['XAlpha', 'Alpha Group'], ['Bravo', 'Alpha Group']],
    });

    expect(index.queryChannels({
      query: 'alpha',
      limit: 10,
      channelCount: 2,
      channelRevision: 7,
      mode: 'fields',
    })?.indices).toEqual([0, 1]);
    expect(index.queryChannels({
      query: 'alpha',
      limit: 10,
      channelCount: 2,
      channelRevision: 7,
      mode: 'names',
    })?.indices).toEqual([0]);
    expect(index.queryChannels({
      query: 'alpha',
      limit: 10,
      channelCount: 2,
      channelRevision: 8,
      mode: 'fields',
    })).toBeNull();
    expect(index.queryChannels({
      query: 'alpha',
      limit: 10,
      channelCount: 3,
      channelRevision: 7,
      mode: 'fields',
    })).toBeNull();
  });
});
