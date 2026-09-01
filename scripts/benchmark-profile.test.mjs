import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_PROFILES,
  resolveBenchmarkProfile,
  resolveBenchmarkReadyTimeout,
  resolveBenchmarkTimeout,
  resolveNpmRun,
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

  it.each([
    [50_000, 300_000],
    [100_000, 600_000],
    [200_000, 2_700_000],
  ])('allows the %i-item workload %ims to finish', (scale, timeout) => {
    expect(resolveBenchmarkTimeout(scale)).toBe(timeout);
  });

  it('keeps readiness bounded while allowing staged profile startup', () => {
    expect(resolveBenchmarkReadyTimeout(50_000)).toBe(30_000);
    expect(resolveBenchmarkReadyTimeout(100_000)).toBe(60_000);
    expect(resolveBenchmarkReadyTimeout(200_000)).toBe(120_000);
    expect(resolveBenchmarkReadyTimeout(400_000)).toBe(120_000);
  });

  it('rejects unknown and conflicting profiles', () => {
    expect(() => resolveBenchmarkProfile({ BENCHMARK_PROFILE: '75k' }))
      .toThrow(`must be one of ${BENCHMARK_PROFILES.join(', ')}`);
    expect(() => resolveBenchmarkProfile({
      BENCHMARK_PROFILE: '100k',
      BENCHMARK_SCALE: '50000',
    })).toThrow('requires BENCHMARK_SCALE=100000');
  });

  it('runs npm through its JavaScript entry point during a lifecycle script', () => {
    expect(resolveNpmRun('benchmark', {
      environment: { npm_execpath: 'C:\\npm\\npm-cli.js' },
      platform: 'win32',
      execPath: 'C:\\node.exe',
    })).toEqual({
      command: 'C:\\node.exe',
      args: ['C:\\npm\\npm-cli.js', 'run', 'benchmark'],
    });
  });

  it('uses the command interpreter for direct Windows runs', () => {
    expect(resolveNpmRun('benchmark:tv', {
      environment: { ComSpec: 'C:\\Windows\\cmd.exe' },
      platform: 'win32',
      execPath: 'C:\\node.exe',
    })).toEqual({
      command: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm run benchmark:tv'],
    });
  });
});
