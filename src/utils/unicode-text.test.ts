import { describe, expect, it } from 'vitest';
import {
  foldDiacritics,
  isLetterNumberWord,
  isLetterOrNumber,
  splitLetterNumberPlusTokens,
  splitLetterNumberTokens,
  stripCombiningDiacritics,
  stripDiacritics,
} from './unicode-text';

describe('unicode-text', () => {
  it('folds diacritics and Turkish characters into base latin representations', () => {
    expect(foldDiacritics('Ç G I İ Ö Ş Ü')).toBe('c g i i o s u');
    expect(foldDiacritics('ç g ı i ö ş ü')).toBe('c g i i o s u');
    expect(foldDiacritics('Cazibe')).toBe('cazibe');
    expect(foldDiacritics('CAZİBE')).toBe('cazibe');
    expect(foldDiacritics('cazıbe')).toBe('cazibe');
    expect(foldDiacritics('IŞIK')).toBe('isik');
    expect(foldDiacritics('ışık')).toBe('isik');
    expect(foldDiacritics('İSİK')).toBe('isik');
    expect(foldDiacritics('isik')).toBe('isik');
    expect(foldDiacritics('Éléphant München café')).toBe('elephant munchen cafe');
  });

  it('strips combining diacritics', () => {
    expect(stripCombiningDiacritics('e\u0301')).toBe('e');
    expect(stripDiacritics('café'.normalize('NFD'))).toBe('cafe');
  });

  it('splits tokens and tests character classification', () => {
    expect(splitLetterNumberTokens('Hello, World! 123')).toEqual(['Hello', 'World', '123']);
    expect(splitLetterNumberPlusTokens('C++ is great')).toEqual(['C++', 'is', 'great']);
    expect(isLetterOrNumber('A')).toBe(true);
    expect(isLetterOrNumber('9')).toBe(true);
    expect(isLetterOrNumber('!')).toBe(false);
    expect(isLetterNumberWord('Alpha123')).toBe(true);
    expect(isLetterNumberWord('Alpha-123')).toBe(false);
  });
});
