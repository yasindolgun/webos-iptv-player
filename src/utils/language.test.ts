import { describe, expect, it } from 'vitest';
import { languageMatches, normalizeLanguage } from './language';

describe('normalizeLanguage', () => {
  it('folds two-letter, three-letter, manifest and display-name forms', () => {
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(normalizeLanguage('eng')).toBe('en');
    expect(normalizeLanguage('English')).toBe('en');
    expect(normalizeLanguage('English (Original)')).toBe('en');
    expect(normalizeLanguage('Deutsch')).toBe('de');
  });

  it('keeps unknown synthetic identifiers comparable', () => {
    expect(normalizeLanguage('L1')).toBe('l1');
    expect(languageMatches('L1', 'l1')).toBe(true);
    expect(languageMatches('', 'en')).toBe(false);
  });

  it('distinguishes explicit Simplified and Traditional Chinese variants', () => {
    expect(languageMatches('zh-Hans', 'zh-CN')).toBe(true);
    expect(languageMatches('Chinese (Traditional)', 'zh-TW')).toBe(true);
    expect(languageMatches('zh-CN', 'zh-TW')).toBe(false);
    expect(languageMatches('zh', 'zh-TW')).toBe(true);
  });
});
