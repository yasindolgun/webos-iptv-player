const PROFILE_SCALES = Object.freeze({
  '50k': 50_000,
  '100k': 100_000,
  '200k': 200_000,
});

export const BENCHMARK_PROFILES = Object.freeze(Object.keys(PROFILE_SCALES));

export function resolveBenchmarkProfile(environment = process.env) {
  const requestedProfile = environment.BENCHMARK_PROFILE;
  const requestedScale = environment.BENCHMARK_SCALE;
  if (requestedProfile && !Object.prototype.hasOwnProperty.call(
    PROFILE_SCALES,
    requestedProfile,
  )) {
    throw new Error(
      `BENCHMARK_PROFILE must be one of ${BENCHMARK_PROFILES.join(', ')}`,
    );
  }

  const profile = requestedProfile || (requestedScale ? 'custom' : '50k');
  const scale = requestedProfile
    ? PROFILE_SCALES[requestedProfile]
    : Number(requestedScale || PROFILE_SCALES['50k']);
  if (!Number.isInteger(scale) || scale <= 0) {
    throw new Error('BENCHMARK_SCALE must be a positive integer');
  }
  if (requestedProfile && requestedScale && Number(requestedScale) !== scale) {
    throw new Error(
      `BENCHMARK_PROFILE=${requestedProfile} requires BENCHMARK_SCALE=${String(scale)}`,
    );
  }
  return { profile, scale };
}
