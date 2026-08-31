import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import {
  resolveBenchmarkProfile,
  resolveBenchmarkTimeout,
} from './benchmark-profile.mjs';
import {
  assertGroupBenchmarkScale,
  assertColdLoadBenchmark,
  assertM3UPipelineBenchmark,
  assertM3USearchBenchmark,
  assertPointerBenchmark,
  assertStartupHoverBenchmark,
  assertRetainedMemory,
  assertXMLTVCatalogBenchmark,
  assertBenchmarkScale,
  buildM3UFixture,
  buildXMLTVPipelineFixture,
  cleanupBenchmarkFixture,
  installBenchmarkFixture,
  installColdLoadFixture,
  installM3USearchFixture,
  installUniqueGroupFixture,
  inspectPointerBenchmark,
  measureM3UPipelineBenchmark,
  measureStartupHoverBenchmark,
  preparePointerBenchmark,
  rebuildBenchmarkDatabase,
  runGroupBenchmark,
  runM3USearchBenchmark,
  measureXMLTVPipelineComparison,
  measureXMLTVCatalogBenchmark,
  runRawParserBenchmarks,
  runBenchmarkSuites,
  runViewReopenCycle,
  summarizeRetainedMemory,
} from './benchmark-suite.mjs';

const { profile: PROFILE, scale: SCALE } = resolveBenchmarkProfile();
const KEY_SAMPLES = Number(process.env.BENCHMARK_KEY_SAMPLES ?? '30');
const QUERY_SAMPLES = Number(process.env.BENCHMARK_QUERY_SAMPLES ?? '5');
const CPU_RATE = Number(process.env.BENCHMARK_CPU_RATE ?? '4');
const FIXTURE = {
  scale: SCALE,
  accountId: 'benchmark-x1',
  epgUrl: 'http://host/benchmark-epg',
  backupKey: '__tv_benchmark_backup__',
  directStorage: true,
};
const COLD_PLAYLIST_URL = 'http://host/cold-list.m3u';
const XMLTV_PIPELINE_URL = 'http://host/benchmark-guide.xml.gz';

async function openLiveFromHome(page: Page): Promise<void> {
  const live = page.locator('[data-home-action="live"]');
  await expect(live).toBeVisible({ timeout: 30_000 });
  await live.click();
  await expect(page.locator('#view-channels')).toBeVisible({ timeout: 30_000 });
}

test(`records the ${PROFILE} application benchmark`, async ({ page, browserName }) => {
  test.setTimeout(resolveBenchmarkTimeout(SCALE));
  test.skip(browserName !== 'chromium', 'The benchmark uses Chromium heap metrics');
  const benchmarkStarted = Date.now();
  const stage = (name: string): void => {
    console.log(
      `[benchmark ${PROFILE}] ${name} (${String(Date.now() - benchmarkStarted)}ms)`,
    );
  };
  stage('prepare fixtures');
  await page.route('**/benchmark-seed.html', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Benchmark seed</title>',
  }));
  await page.route('http://127.0.0.1:8890/**', (route) => route.abort());
  const coldPlaylist = buildM3UFixture(SCALE);
  const xmltvPipelineFixture = buildXMLTVPipelineFixture(SCALE);
  const compressedXMLTV = gzipSync(Buffer.from(xmltvPipelineFixture.text));
  await page.route('http://host/**', (route) => {
    const url = route.request().url();
    if (url === COLD_PLAYLIST_URL) {
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: coldPlaylist,
      });
    }
    if (url === XMLTV_PIPELINE_URL) {
      return route.fulfill({
        contentType: 'application/gzip',
        body: compressedXMLTV,
      });
    }
    if (/^\/\d+$/.test(new URL(url).pathname)) {
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n',
      });
    }
    return route.fulfill({ contentType: 'application/json', body: '[]' });
  });
  await page.addInitScript(() => {
    const media = HTMLMediaElement.prototype;
    media.load = function () { /* no-op */ };
    media.play = function () { return Promise.resolve(); };
  });
  const cdp = await page.context().newCDPSession(page);
  if (CPU_RATE !== 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
  }

  await page.goto('/benchmark-seed.html');
  await page.evaluate(rebuildBenchmarkDatabase);
  const fixtureStarted = Date.now();
  const fixture = await page.evaluate(installBenchmarkFixture, FIXTURE);
  const fixtureSetupMs = Date.now() - fixtureStarted;

  try {
    stage('startup');
    const startupStarted = Date.now();
    await page.goto('/');
    await openLiveFromHome(page);
    await expect(page.locator('.channel-item').first()).toBeVisible();
    const startupReadyMs = Date.now() - startupStarted;
    const startupHover = await page.evaluate(measureStartupHoverBenchmark);
    assertStartupHoverBenchmark(startupHover);
    await page.addScriptTag({
      content: await readFile('test-output/benchmarks/parser-bundle.js', 'utf8'),
    });
    stage('M3U pipeline');
    const m3uPipeline = await measureM3UPipelineBenchmark({
      text: coldPlaylist,
      timeoutMs: 1,
    }, {
      evaluate: (fn, arg) => page.evaluate(fn as never, arg),
      delay: (milliseconds) =>
        new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
    });
    assertM3UPipelineBenchmark(m3uPipeline, SCALE);
    stage('raw parsers');
    const parsers = await page.evaluate(runRawParserBenchmarks, { scale: SCALE });
    parsers.m3uPipeline = m3uPipeline;
    await cdp.send('HeapProfiler.collectGarbage');
    const xmltvPipelineOptions = {
      url: XMLTV_PIPELINE_URL,
      compressedBytes: compressedXMLTV.byteLength,
      uncompressedBytes: Buffer.byteLength(xmltvPipelineFixture.text),
      channelIds: xmltvPipelineFixture.channelIds,
      channelNames: xmltvPipelineFixture.channelNames,
    };
    const xmltvPipelineIo = {
      evaluate: (fn: unknown, arg?: unknown) => page.evaluate(fn as never, arg),
      collectGarbage: () => cdp.send('HeapProfiler.collectGarbage'),
      memoryUsed: () => cdp.send('Runtime.getHeapUsage'),
      delay: (milliseconds: number) =>
        new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
    };
    stage('XMLTV pipeline');
    const xmltvPipeline = await measureXMLTVPipelineComparison(
      xmltvPipelineOptions,
      xmltvPipelineIo,
    );
    parsers.xmltvPipelineBuffered = xmltvPipeline.buffered;
    parsers.xmltvPipeline = xmltvPipeline.streaming;
    await cdp.send('HeapProfiler.collectGarbage');
    stage('UI suites');
    const suites = await page.evaluate(runBenchmarkSuites, {
      keySamples: KEY_SAMPLES,
      querySamples: QUERY_SAMPLES,
    });
    suites.parsers = parsers;
    const pointer = await page.evaluate(preparePointerBenchmark);
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.down();
    await page.mouse.up();
    const pointerReport = await page.evaluate(inspectPointerBenchmark);
    assertPointerBenchmark(pointerReport, SCALE);
    suites.interactions.magicRemote = pointerReport;
    assertBenchmarkScale(suites, SCALE);

    stage('reopen memory');
    await cdp.send('HeapProfiler.collectGarbage');
    const beforeReopen = await cdp.send('Runtime.getHeapUsage');
    const reopenHeap: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.evaluate(runViewReopenCycle);
      await cdp.send('HeapProfiler.collectGarbage');
      reopenHeap.push((await cdp.send('Runtime.getHeapUsage')).usedSize);
    }
    const retained = summarizeRetainedMemory(beforeReopen.usedSize, reopenHeap);
    assertRetainedMemory(retained);
    const heap = await cdp.send('Runtime.getHeapUsage');
    // Runs last of the in-page work: its multi-megabyte feed would otherwise
    // skew the reopen heap samples measured above.
    stage('XMLTV catalog');
    parsers.xmltvCatalog = await measureXMLTVCatalogBenchmark(SCALE, {
      evaluate: (fn, arg) => page.evaluate(fn as never, arg),
      collectGarbage: () => cdp.send('HeapProfiler.collectGarbage'),
      heapUsed: async () => (await cdp.send('Runtime.getHeapUsage')).usedSize,
    });
    assertXMLTVCatalogBenchmark(parsers.xmltvCatalog);
    stage('M3U search');
    await page.evaluate(installM3USearchFixture);
    await page.reload();
    await openLiveFromHome(page);
    suites.search.m3u = await page.evaluate(
      runM3USearchBenchmark,
      { querySamples: QUERY_SAMPLES },
    );
    assertM3USearchBenchmark(suites.search.m3u);
    stage('group transitions');
    await page.evaluate(installUniqueGroupFixture, SCALE);
    const groupStartupStarted = Date.now();
    await page.reload();
    await openLiveFromHome(page);
    const groups = await page.evaluate(runGroupBenchmark, { keySamples: KEY_SAMPLES });
    groups.startupMs = Date.now() - groupStartupStarted;
    assertGroupBenchmarkScale(groups, SCALE);
    suites.groups = groups;
    stage('cold load');
    await page.evaluate(installColdLoadFixture, {
      accountId: FIXTURE.accountId,
      url: COLD_PLAYLIST_URL,
    });
    const coldStarted = performance.now();
    await page.reload();
    await openLiveFromHome(page);
    await expect(page.locator('.channel-item').first()).toBeVisible();
    const coldResult = await page.evaluate(() => {
      const totalSize = parseFloat(
        document.querySelector<HTMLElement>('.channel-list-spacer')?.style.height || '0',
      );
      return {
        rendered: document.querySelectorAll('.channel-item').length,
        channels: Math.round(totalSize / 88),
      };
    });
    const coldLoad = {
      readyMs: Math.round((performance.now() - coldStarted) * 10) / 10,
      ...coldResult,
    };
    assertColdLoadBenchmark(coldLoad, SCALE);
    suites.coldLoad = coldLoad;
    stage('write report');
    const report = {
      version: 2,
      target: 'desktop-chromium',
      generatedAt: new Date().toISOString(),
      profile: PROFILE,
      scale: SCALE,
      keySamples: KEY_SAMPLES,
      querySamples: QUERY_SAMPLES,
      cpuRate: CPU_RATE,
      browser: await page.evaluate(() => navigator.userAgent),
      fixtureSetupMs,
      fixture,
      suites: {
        startup: {
          readyMs: startupReadyMs,
          rendered: suites.channelList.rendered,
          ...startupHover,
        },
        ...suites,
        memory: {
          usedHeapMiB: Math.round(heap.usedSize / 1_048_576 * 10) / 10,
          totalHeapMiB: Math.round(heap.totalSize / 1_048_576 * 10) / 10,
          retained,
        },
      },
    };
    const outputDir = path.join(process.cwd(), 'test-output', 'benchmarks');
    await mkdir(outputDir, { recursive: true });
    const outputName = process.env.BENCHMARK_PROFILE
      ? `latest-${PROFILE}.json`
      : 'latest.json';
    const outputPath = path.join(outputDir, outputName);
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Benchmark report: ${outputPath}`);
  } finally {
    stage('cleanup');
    try {
      await page.goto('/benchmark-seed.html');
      await page.evaluate(cleanupBenchmarkFixture, {
        accountId: FIXTURE.accountId,
        epgUrl: FIXTURE.epgUrl,
        backupKey: FIXTURE.backupKey,
      });
    } finally {
      try {
        await cdp.detach();
      } finally {
        await page.request.post('/__benchmark-shutdown');
      }
    }
  }
});
