import { describe, expect, it } from 'vitest';
import { m3uContentKind } from './m3u-content-kind';

describe('m3uContentKind', () => {
  it('recognizes movie groups across common M3U labels', () => {
    expect(m3uContentKind('Movies')).toBe('movie');
    expect(m3uContentKind('Películas')).toBe('movie');
    expect(m3uContentKind('Sinema')).toBe('movie');
  });

  it('recognizes series groups across common M3U labels', () => {
    expect(m3uContentKind('Series Drama')).toBe('series');
    expect(m3uContentKind('Diziler')).toBe('series');
    expect(m3uContentKind('Serien')).toBe('series');
  });

  it('keeps an unrecognized group in the live catalog', () => {
    expect(m3uContentKind('News HD')).toBe('live');
  });

  it('does not surface restricted groups in live, movie, or series catalogs', () => {
    expect(m3uContentKind('Adult')).toBe('other');
  });
});
