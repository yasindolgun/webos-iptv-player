import { afterEach, describe, expect, it } from 'vitest';
import {
  assertBenchmarkScale,
  runBenchmarkSuites,
  runRawParserBenchmarks,
} from '../benchmarks/benchmark-suite.mjs';

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

describe('raw parser benchmark fixtures', () => {
  it('keeps staged XMLTV scales inside the parser retention window', async () => {
    globalThis.window = {
      __IPTV_BENCHMARK__: {
        parseM3U(text) {
          return {
            channels: (text.match(/#EXTINF:/g) || []).length,
            groups: 100,
          };
        },
        async profileDerivedIndexes(text) {
          return {
            durationMs: 1,
            maxFrameGapMs: 1,
            frames: 1,
            transport: 'worker',
            startMs: 1,
            batchesMs: 1,
            finishMs: 1,
            channels: (text.match(/#EXTINF:/g) || []).length,
            groups: 100,
          };
        },
        parseXMLTV(text) {
          return {
            channels: (text.match(/<channel id=/g) || []).length,
            programmes: (text.match(/<programme /g) || []).length,
          };
        },
      },
    };

    const result = await runRawParserBenchmarks({ scale: 50_001 });

    expect(result.xmltv).toMatchObject({ channels: 2, programmes: 50_001 });
  });
});

describe('application benchmark lifecycle', () => {
  it('bounds search waits and reports long-running UI stages', () => {
    const source = runBenchmarkSuites.toString();

    expect(source).not.toMatch(/while\s*\(true\)/);
    expect(source).toContain('Timed out waiting for search input');
    expect(source).toContain("progress('channel list')");
    expect(source).toContain("progress('EPG mapping search')");
    expect(source).toContain("progress('complete')");
  });

  it('allows only sub-row CSSOM rounding at the 200k catalog extent', () => {
    const scale = 200_000;
    const report = {
      channelList: { rendered: 20, totalSize: `${String(scale * 88)}px` },
      recentlyWatched: { rendered: 50, liveRendered: 25, catchupRendered: 25 },
      sidebar: {
        rendered: 20,
        totalSize: `${String(scale * 88)}px`,
        logoReveal: {
          initialSpacers: 2,
          initialImages: 0,
          invalidImages: 0,
          revealed: 2,
          maxPerFrame: 1,
        },
      },
      epg: {
        renderedChannels: 20,
        renderedPrograms: 20,
        channelTotalSize: `${String(scale * 72)}px`,
        programTotalSize: `${String(scale * 80)}px`,
      },
      movies: {
        rendered: 20,
        categoryTotalSize: `${String((scale - 6) * 320)}px`,
        totalSize: '11_285_900px',
      },
      series: {
        rendered: 20,
        totalSize: '11_285_900px',
        episodes: { rendered: 10, totalSize: `${String(scale * 138)}px` },
      },
      search: {
        xtream: { renderedPrograms: 10 },
        programTotalSize: `${String(scale * 109)}px`,
      },
      interactions: {
        wheelToDpad: { focusedConnected: true },
        epgChannelTransition: { selected: true, renderedPrograms: 1 },
        epgDateTitles: ['One', 'Two', 'Three'],
        sparseSearch: { channels: 1, movies: 1, programs: 1 },
        groupSwitching: {
          states: Array.from({ length: 3 }).flatMap(() => [
            { group: 'builtin:all', rendered: 20, channels: scale },
            { group: 'source:Group 1', rendered: 20, channels: 2_000 },
            { group: 'source:Small Group', rendered: 1, channels: 1 },
          ]),
        },
      },
      stress: {
        documentAlive: true,
        heartbeats: 1,
        maxEventLoopGapMs: 1,
        freezeThresholdMs: 5_000,
      },
      parsers: {
        m3u: { channels: scale },
        derivedIndexes: {
          channels: scale,
          transport: 'worker',
          frames: 1,
          maxFrameGapMs: 1,
        },
        xmltv: { programmes: scale },
      },
    };

    expect(() => assertBenchmarkScale(report, scale)).not.toThrow();
    report.movies.totalSize = '11_285_800px';
    expect(() => assertBenchmarkScale(report, scale)).toThrow(/Expected extent/);
  });
});
