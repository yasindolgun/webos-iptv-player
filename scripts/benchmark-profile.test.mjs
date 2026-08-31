import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_PROFILES,
  resolveBenchmarkProfile,
} from '../benchmarks/benchmark-profile.mjs';

describe('benchmark profiles', () => {
  it('keeps the required benchmark on the 50k profile by default', () => {
    expect(resolveBenchmarkProfile({})).toEqual({ profile: '50k', scale: 50_000 });
  });

  it.each([
    ['50k', 50_000],
    ['100k', 100_000],
    ['200k', 200_000],
  ])('resolves the %s staged profile', (profile, scale) => {
    expect(resolveBenchmarkProfile({ BENCHMARK_PROFILE: profile })).toEqual({
      profile,
      scale,
    });
  });

  it('retains a custom scale for local investigations', () => {
    expect(resolveBenchmarkProfile({ BENCHMARK_SCALE: '12345' })).toEqual({
      profile: 'custom',
      scale: 12_345,
    });
  });

  it('rejects unknown and conflicting profiles', () => {
    expect(() => resolveBenchmarkProfile({ BENCHMARK_PROFILE: '75k' }))
      .toThrow(`must be one of ${BENCHMARK_PROFILES.join(', ')}`);
    expect(() => resolveBenchmarkProfile({
      BENCHMARK_PROFILE: '100k',
      BENCHMARK_SCALE: '50000',
    })).toThrow('requires BENCHMARK_SCALE=100000');
  });
});
