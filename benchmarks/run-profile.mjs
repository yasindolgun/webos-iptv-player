#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';
import {
  BENCHMARK_PROFILES,
  resolveNpmRun,
} from './benchmark-profile.mjs';

const tv = process.argv.includes('--tv');
const profile = process.argv.slice(2).find(argument => !argument.startsWith('--'));
if (!profile || !BENCHMARK_PROFILES.includes(profile)) {
  throw new Error(
    `Pass one staged profile: ${BENCHMARK_PROFILES.join(', ')}`,
  );
}

const invocation = resolveNpmRun(tv ? 'benchmark:tv' : 'benchmark');
const child = spawn(invocation.command, invocation.args, {
  env: {
    ...process.env,
    BENCHMARK_PROFILE: profile,
  },
  stdio: 'inherit',
});
child.on('error', error => {
  throw error;
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
