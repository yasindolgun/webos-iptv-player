export const BENCHMARK_PROFILES: readonly string[];

export function resolveBenchmarkTimeout(scale: number): number;
export function resolveBenchmarkReadyTimeout(scale: number): number;

export function resolveNpmRun(
  script: string,
  options?: {
    environment?: Record<string, string | undefined>;
    platform?: string;
    execPath?: string;
  },
): { command: string; args: string[] };

export function resolveBenchmarkProfile(
  environment?: Record<string, string | undefined>,
): { profile: string; scale: number };
