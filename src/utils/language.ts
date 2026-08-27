import ISO6391 from 'iso-639-1';
import { iso6392BTo1 } from 'iso-639-2/2b-to-1';
import { iso6392TTo1 } from 'iso-639-2/2t-to-1';

const names = new Map<string, string>();
for (const code of ISO6391.getAllCodes()) {
  names.set(ISO6391.getName(code).toLowerCase(), code);
  names.set(ISO6391.getNativeName(code).toLowerCase(), code);
}

function codeFor(value: string): string {
  if (ISO6391.validate(value)) return value;
  if (value.length === 3) return iso6392BTo1[value] || iso6392TTo1[value] || '';
  return names.get(value) || '';
}

/** Fold BCP-47, ISO-639-1/2, English names and endonyms to a comparable code. */
export function normalizeLanguage(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return '';
  const exact = codeFor(normalized);
  if (exact) return exact;
  const primary = normalized.split('-')[0];
  const primaryCode = codeFor(primary);
  if (primaryCode) return primaryCode;
  const display = normalized
    .split(/\s*[\[(,/]\s*/)[0]
    .replace(/\s+(?:cc|sdh|forced|original|dubbed?)$/, '')
    .trim();
  return codeFor(display) || normalized;
}

function chineseVariant(value: string): 'hans' | 'hant' | '' {
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (normalizeLanguage(normalized) !== 'zh') return '';
  const parts = normalized.split('-');
  if (parts.indexOf('hant') >= 0 || parts.indexOf('tw') >= 0
      || parts.indexOf('hk') >= 0 || parts.indexOf('mo') >= 0
      || normalized.indexOf('traditional') >= 0
      || normalized.indexOf('繁體') >= 0 || normalized.indexOf('繁体') >= 0) return 'hant';
  if (parts.indexOf('hans') >= 0 || parts.indexOf('cn') >= 0
      || parts.indexOf('sg') >= 0 || normalized.indexOf('simplified') >= 0
      || normalized.indexOf('简体') >= 0 || normalized.indexOf('簡體') >= 0) return 'hans';
  return '';
}

export function languageMatches(candidate: string, preferred: string): boolean {
  const left = normalizeLanguage(candidate);
  const right = normalizeLanguage(preferred);
  if (!left || !right || left !== right) return false;
  if (left !== 'zh') return true;
  const leftVariant = chineseVariant(candidate);
  const rightVariant = chineseVariant(preferred);
  return !leftVariant || !rightVariant || leftVariant === rightVariant;
}
