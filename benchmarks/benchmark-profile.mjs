const PROFILE_SCALES = Object.freeze({
  '50k': 50_000,
  '100k': 100_000,
  '200k': 200_000,
});

export const BENCHMARK_PROFILES = Object.freeze(Object.keys(PROFILE_SCALES));

export function resolveBenchmarkTimeout(scale) {
  const units = Math.max(1, Math.ceil(scale / 50_000));
  return units <= 2 ? units * 300_000 : units * 675_000;
}

export function resolveNpmRun(
  script,
  {
    environment = process.env,
    platform = process.platform,
    execPath = process.execPath,
  } = {},
) {
  if (environment.npm_execpath) {
    return {
      command: execPath,
      args: [environment.npm_execpath, 'run', script],
    };
  }
  if (platform === 'win32') {
    return {
      command: environment.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `npm run ${script}`],
    };
  }
  return { command: 'npm', args: ['run', script] };
}

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
