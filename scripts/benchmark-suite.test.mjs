import { afterEach, describe, expect, it } from 'vitest';
import { runRawParserBenchmarks } from '../benchmarks/benchmark-suite.mjs';

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
