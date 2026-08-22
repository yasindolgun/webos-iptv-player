import { describe, expect, it } from 'vitest';
import type { Channel } from '../types';
import { m3uAccountId, m3uItemKey } from './m3u-item';

function channel(url: string, playlistIds: string[] = ['p1']): Channel {
  return {
    id: '', name: 'Item', logo: '', group: 'Movies', url, extras: null,
    playlistIds, catchup: '', catchupSource: '', catchupDays: 0, contentKind: 'movie',
  };
}

describe('m3uItemKey', () => {
  it('does not depend on an optional tvg-id', () => {
    const a = channel('http://host/item?token=one');
    const b = { ...channel('http://host/item?token=two'), id: 'different' };
    expect(m3uItemKey(a)).toBe(m3uItemKey(b));
  });

  it('keeps the configured source set order-independent', () => {
    const first = channel('http://host/item', ['p2', 'p1']);
    const second = channel('http://host/item', ['p1', 'p2']);
    expect(m3uAccountId(first)).toBe(m3uAccountId(second));
    expect(m3uItemKey(first)).toBe(m3uItemKey(second));
  });

  it('distinguishes different sources and streams', () => {
    expect(m3uItemKey(channel('http://host/a')))
      .not.toBe(m3uItemKey(channel('http://host/b')));
    expect(m3uItemKey(channel('http://host/a', ['p1'])))
      .not.toBe(m3uItemKey(channel('http://host/a', ['p2'])));
  });
});
