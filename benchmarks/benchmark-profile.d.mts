export const BENCHMARK_PROFILES: readonly string[];

export function resolveBenchmarkProfile(
  environment?: Record<string, string | undefined>,
): { profile: string; scale: number };
