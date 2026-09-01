import { describe, expect, it } from 'vitest';
import { ScopedSearchIndex } from './scoped-search-index';

describe('ScopedSearchIndex', () => {
  it('keeps field and name indexes isolated by owner', () => {
    const index = new ScopedSearchIndex();
    index.indexList({
      owner: 'sidebar',
      sessionId: 1,
      mode: 'fields',
      documents: [['XAlpha', 'News'], ['Alpha', 'Drama']],
    });
    index.indexList({
      owner: 'epg',
      sessionId: 2,
      mode: 'names',
      documents: [['XAlpha'], ['Alpha']],
    });

    expect(index.queryList({
      owner: 'sidebar',
      sessionId: 1,
      query: 'alpha',
    })?.indices).toEqual([1, 0]);
    expect(index.queryList({
      owner: 'epg',
      sessionId: 2,
      query: 'alpha',
    })?.indices).toEqual([1, 0]);
    expect(index.queryList({
      owner: 'epg',
      sessionId: 1,
      query: 'alpha',
    })).toBeNull();
  });

  it('releases only the matching list session', () => {
    const index = new ScopedSearchIndex();
    index.indexList({
      owner: 'sidebar',
      sessionId: 2,
      mode: 'names',
      documents: [['Alpha']],
    });

    expect(index.releaseList({
      owner: 'sidebar',
      sessionId: 1,
    }).accepted).toBe(false);
    expect(index.queryList({
      owner: 'sidebar',
      sessionId: 2,
      query: 'alpha',
    })).not.toBeNull();
    expect(index.releaseList({
      owner: 'sidebar',
      sessionId: 2,
    }).accepted).toBe(true);
    expect(index.queryList({
      owner: 'sidebar',
      sessionId: 2,
      query: 'alpha',
    })).toBeNull();
  });

  it('caps ranked list query results before returning them to the page', () => {
    const index = new ScopedSearchIndex();
    index.indexList({
      owner: 'm3u-catalog',
      sessionId: 1,
      mode: 'names',
      documents: [['Alpha one'], ['Alpha two'], ['Alpha three']],
    });

    const result = index.queryList({
      owner: 'm3u-catalog',
      sessionId: 1,
      query: 'alpha',
      limit: 2,
    });
    expect(result?.indices).toEqual([0, 1]);
    expect(result?.hasMore).toBe(true);
  });

  it('publishes incremental list indexes only after the final contiguous batch', () => {
    const index = new ScopedSearchIndex();
    expect(index.indexList({
      owner: 'sidebar',
      sessionId: 5,
      mode: 'names',
      documents: [['Alpha'], ['Bravo']],
      offset: 0,
      reset: true,
      complete: false,
    }).accepted).toBe(true);
    expect(index.queryList({
      owner: 'sidebar',
      sessionId: 5,
      query: 'alpha',
    })).toBeNull();
    expect(index.indexList({
      owner: 'sidebar',
      sessionId: 5,
      mode: 'names',
      documents: [['Charlie']],
      offset: 3,
      reset: false,
      complete: true,
    }).accepted).toBe(false);
    expect(index.indexList({
      owner: 'sidebar',
      sessionId: 5,
      mode: 'names',
      documents: [['Charlie']],
      offset: 2,
      reset: false,
      complete: true,
    }).accepted).toBe(true);
    expect(index.queryList({
      owner: 'sidebar',
      sessionId: 5,
      query: 'charlie',
    })?.indices).toEqual([2]);
  });

  it('preserves EPG mapping source and selected ordering', () => {
    const index = new ScopedSearchIndex();
    index.indexMapping({
      owner: 'mapping',
      sessionId: 3,
      documents: [
        {
          id: 'a',
          channelId: 'a',
          name: 'Bravo',
          fields: ['a', 'Bravo'],
          sourceIndex: 0,
        },
        {
          id: 'b',
          channelId: 'b',
          name: 'Alpha',
          fields: ['b', 'Alpha'],
          sourceIndex: 1,
        },
      ],
    });

    expect(index.queryMapping({
      owner: 'mapping',
      sessionId: 3,
      query: '',
      selectedId: '',
    })?.indices).toEqual([0, 1]);
    expect(index.queryMapping({
      owner: 'mapping',
      sessionId: 3,
      query: 'alpha',
      selectedId: 'a',
    })?.indices).toEqual([0, 1]);
  });

  it('releases only the matching mapping session', () => {
    const index = new ScopedSearchIndex();
    index.indexMapping({
      owner: 'mapping',
      sessionId: 4,
      documents: [],
    });

    expect(index.releaseMapping({
      owner: 'mapping',
      sessionId: 3,
    }).accepted).toBe(false);
    expect(index.queryMapping({
      owner: 'mapping',
      sessionId: 4,
      query: '',
      selectedId: '',
    })).not.toBeNull();
    expect(index.releaseMapping({
      owner: 'mapping',
      sessionId: 4,
    }).accepted).toBe(true);
    expect(index.queryMapping({
      owner: 'mapping',
      sessionId: 4,
      query: '',
      selectedId: '',
    })).toBeNull();
  });
});
