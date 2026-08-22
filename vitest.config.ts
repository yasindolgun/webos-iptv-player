import { readFileSync } from 'fs';
import { defineConfig } from 'vitest/config';

const appinfo = JSON.parse(readFileSync('appinfo.json', 'utf8'));
const serviceId = JSON.parse(readFileSync('bundled-service/src/services.json', 'utf8')).id;

// Unit/integration tests run under Vitest. The app bundle normally has these
// build-time constants injected by esbuild (see esbuild.config.mjs); Vitest has
// no esbuild define step, so we replace them here too.
export default defineConfig({
  define: {
    __APP_ID__: JSON.stringify(appinfo.id),
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __SERVICE_ID__: JSON.stringify(serviceId),
    __ENABLE_PSEUDO_LOCALE__: JSON.stringify(true),
  },
  test: {
    // Default to Node. DOM-dependent tests opt in per-file with:
    //   // @vitest-environment jsdom
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'bundled-service/src/**/*.test.ts', 'webOSjs/**/*.test.ts', 'scripts/**/*.test.mjs'],
    // Large virtualized-list fixtures are deliberately CPU-heavy. Keep enough
    // workers for a quick suite without letting 12-core desktop hosts starve
    // their per-test timeout under concurrent jsdom workloads.
    maxWorkers: 4,
    minWorkers: 1,
    // Keep coverage output under the shared test-output/ folder.
    coverage: {
      reportsDirectory: 'test-output/coverage',
    },
  },
});
