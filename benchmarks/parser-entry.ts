import { parseM3U } from '../src/parsers/m3u-parser';
import { parseXMLTVWithStats, XMLTVStreamParser } from '../src/parsers/xmltv-parser';
import { fetchAndParseXMLTV } from '../src/parsers/xmltv-loader';
import { fetchMaybeGzipText } from '../src/utils/fetch-helper';
import {
  isAppWorkerRunning,
  terminateAppWorker,
} from '../src/workers/app-worker-client';
import { runM3UParseWorker } from '../src/workers/m3u-parser-client';
import { preparePlaylistIndexesOffThread } from '../src/workers/playlist-index-client';
import type { PlaylistIndexPreparationMetrics } from '../src/workers/playlist-index-client';
import type { PlaylistIndexPlan } from '../src/workers/playlist-index';

interface BenchmarkParseResult {
  channels: number;
  catalogChannels?: number;
  groups?: number;
  programmes?: number;
  programmesSeen?: number;
  /** The parsed data itself, so a caller can hold it and measure retained heap. */
  retained?: unknown;
}

interface BenchmarkXMLTVOptions {
  channelIds?: string[];
  channelNames?: string[];
  retainChannelCatalog?: boolean;
}

interface BenchmarkParserApi {
  parseM3U(text: string): BenchmarkParseResult;
  profileM3UPipeline(buffer: ArrayBuffer): Promise<BenchmarkM3UPipelineResult>;
  profileM3UTimeout(
    buffer: ArrayBuffer,
    timeoutMs: number,
  ): Promise<BenchmarkM3UTimeoutResult>;
  profileDerivedIndexes(text: string): Promise<BenchmarkDerivedIndexResult>;
  parseXMLTV(text: string, options?: BenchmarkXMLTVOptions): BenchmarkParseResult;
  loadXMLTV(url: string, options?: BenchmarkXMLTVOptions): Promise<BenchmarkXMLTVLoadResult>;
  profileXMLTV(url: string, options?: BenchmarkXMLTVOptions): Promise<BenchmarkParseResult>;
  loadXMLTVBuffered(url: string, options?: BenchmarkXMLTVOptions):
    Promise<BenchmarkXMLTVLoadResult>;
  profileXMLTVBuffered(url: string, options?: BenchmarkXMLTVOptions):
    Promise<BenchmarkParseResult>;
  workerRunning(): boolean;
}

interface BenchmarkDerivedIndexResult {
  durationMs: number;
  maxFrameGapMs: number;
  frames: number;
  transport: PlaylistIndexPreparationMetrics['transport'];
  startMs: number;
  batchesMs: number;
  finishMs: number;
  channels: number;
  groups: number;
}

interface BenchmarkM3UPipelineResult {
  decodeChunkBytes: number;
  decodeChunks: number;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
  inputBytes: number;
  inputTransferMs: number;
  maxBufferedChannels: number;
  parseMs: number;
  resultCloneDeliveryMs: number;
  resultBatchSize: number;
  resultBatches: number;
  roundTripMs: number;
  sourceStaging: 'indexeddb' | 'memory';
  stageBatchSize: number;
  stageBatches: number;
  stageReadBatches: number;
  stageWriteMs: number;
  maxDecodedChunkChars: number;
  channels: number;
  groups: number;
}

interface BenchmarkM3UTimeoutResult {
  timeoutMs: number;
  elapsedMs: number;
  timedOut: boolean;
  workerTerminated: boolean;
}

interface BenchmarkXMLTVLoadResult extends BenchmarkParseResult {
  durationMs: number;
}

declare global {
  const __APP_ID__: string;
  const __APP_VERSION__: string;
  const __SERVICE_ID__: string;
  const __ENABLE_PSEUDO_LOCALE__: boolean;

  interface Window {
    __IPTV_BENCHMARK__?: BenchmarkParserApi;
  }
}

window.__IPTV_BENCHMARK__ = {
  workerRunning() {
    return isAppWorkerRunning();
  },
  parseM3U(text) {
    const parsed = parseM3U(text, 'http://host/list.m3u');
    return {
      channels: parsed.channels.length,
      groups: parsed.groups.length,
    };
  },
  async profileM3UPipeline(buffer) {
    terminateAppWorker('benchmark-m3u-cold-start');
    const result = await runM3UParseWorker(buffer, 'http://host/list.m3u');
    return {
      decodeChunkBytes: result.metrics.decodeChunkBytes,
      decodeChunks: result.metrics.decodeChunks,
      encoding: result.metrics.encoding,
      inputBytes: result.metrics.inputBytes,
      inputTransferMs: result.metrics.inputTransferMs,
      maxBufferedChannels: result.metrics.maxBufferedChannels,
      parseMs: result.metrics.parseMs,
      resultCloneDeliveryMs: result.metrics.resultCloneDeliveryMs,
      resultBatchSize: result.metrics.resultBatchSize,
      resultBatches: result.metrics.resultBatches,
      roundTripMs: result.metrics.roundTripMs,
      sourceStaging: result.metrics.sourceStaging,
      stageBatchSize: result.metrics.stageBatchSize,
      stageBatches: result.metrics.stageBatches,
      stageReadBatches: result.metrics.stageReadBatches,
      stageWriteMs: result.metrics.stageWriteMs,
      maxDecodedChunkChars: result.metrics.maxDecodedChunkChars,
      channels: result.data.channels.length,
      groups: result.data.groups.length,
    };
  },
  async profileM3UTimeout(buffer, timeoutMs) {
    terminateAppWorker('benchmark-m3u-timeout-start');
    const started = performance.now();
    let timedOut = false;
    try {
      await runM3UParseWorker(buffer, 'http://host/list.m3u', timeoutMs);
    } catch (error) {
      timedOut = error instanceof Error
        && error.message === 'Worker task timed out: m3u.parse';
      if (!timedOut) throw error;
    }
    return {
      timeoutMs,
      elapsedMs: performance.now() - started,
      timedOut,
      workerTerminated: !isAppWorkerRunning(),
    };
  },
  async profileDerivedIndexes(text) {
    const parsed = parseM3U(text, 'http://host/list.m3u');
    for (const channel of parsed.channels) channel.playlistIds = ['benchmark'];
    terminateAppWorker('benchmark-derived-index-cold-start');
    let active = true;
    let frameRequest = 0;
    let previousFrame = performance.now();
    let maxFrameGapMs = 0;
    let frames = 0;
    const observeFrame = (timestamp: number): void => {
      frames++;
      maxFrameGapMs = Math.max(maxFrameGapMs, timestamp - previousFrame);
      previousFrame = timestamp;
      if (active) frameRequest = requestAnimationFrame(observeFrame);
    };
    frameRequest = requestAnimationFrame(observeFrame);
    const started = performance.now();
    let plan: PlaylistIndexPlan;
    const measurement: { value?: PlaylistIndexPreparationMetrics } = {};
    try {
      plan = await preparePlaylistIndexesOffThread(
        parsed.channels,
        [],
        undefined,
        value => { measurement.value = value; },
      );
      await new Promise(resolve => requestAnimationFrame(resolve));
    } finally {
      active = false;
      cancelAnimationFrame(frameRequest);
    }
    return {
      durationMs: performance.now() - started,
      maxFrameGapMs,
      frames,
      transport: measurement.value?.transport ?? 'fallback',
      startMs: measurement.value?.startMs ?? 0,
      batchesMs: measurement.value?.batchesMs ?? 0,
      finishMs: measurement.value?.finishMs ?? 0,
      channels: plan.channelCount,
      groups: plan.groups.length,
    };
  },
  parseXMLTV(text, options) {
    const { data, stats } = parseXMLTVWithStats(text, {
      channelIds: options?.channelIds ? new Set(options.channelIds) : undefined,
      channelNames: options?.channelNames ? new Set(options.channelNames) : undefined,
      retainChannelCatalog: options?.retainChannelCatalog,
    });
    return {
      channels: Object.keys(data.programmes).length,
      catalogChannels: Object.keys(data.channels).length,
      programmes: stats.programmesKept,
      programmesSeen: stats.programmesSeen,
      retained: data,
    };
  },
  async loadXMLTV(url, options) {
    const parseOptions = {
      channelIds: options?.channelIds ? new Set(options.channelIds) : undefined,
      channelNames: options?.channelNames ? new Set(options.channelNames) : undefined,
      retainChannelCatalog: options?.retainChannelCatalog,
    };
    const started = performance.now();
    const parsed = await fetchAndParseXMLTV(url, 120000, parseOptions);
    return {
      durationMs: performance.now() - started,
      channels: Object.keys(parsed.data.programmes).length,
      catalogChannels: Object.keys(parsed.data.channels).length,
      programmes: parsed.stats.programmesKept,
      programmesSeen: parsed.stats.programmesSeen,
      retained: parsed.data,
    };
  },
  async profileXMLTV(url, options) {
    const parsed = await fetchAndParseXMLTV(url, 120000, {
      channelIds: options?.channelIds ? new Set(options.channelIds) : undefined,
      channelNames: options?.channelNames ? new Set(options.channelNames) : undefined,
      retainChannelCatalog: options?.retainChannelCatalog,
    });
    return {
      channels: Object.keys(parsed.data.programmes).length,
      catalogChannels: Object.keys(parsed.data.channels).length,
      programmes: parsed.stats.programmesKept,
      programmesSeen: parsed.stats.programmesSeen,
      retained: parsed.data,
    };
  },
  async loadXMLTVBuffered(url, options) {
    const started = performance.now();
    const text = await fetchMaybeGzipText(url, 120000);
    const parsed = parseXMLTVWithStats(text, {
      channelIds: options?.channelIds ? new Set(options.channelIds) : undefined,
      channelNames: options?.channelNames ? new Set(options.channelNames) : undefined,
      retainChannelCatalog: options?.retainChannelCatalog,
    });
    return {
      durationMs: performance.now() - started,
      channels: Object.keys(parsed.data.programmes).length,
      catalogChannels: Object.keys(parsed.data.channels).length,
      programmes: parsed.stats.programmesKept,
      programmesSeen: parsed.stats.programmesSeen,
      retained: parsed.data,
    };
  },
  async profileXMLTVBuffered(url, options) {
    const text = await fetchMaybeGzipText(url, 120000);
    const parser = new XMLTVStreamParser({
      channelIds: options?.channelIds ? new Set(options.channelIds) : undefined,
      channelNames: options?.channelNames ? new Set(options.channelNames) : undefined,
      retainChannelCatalog: options?.retainChannelCatalog,
    });
    const chunkSize = 256 * 1024;
    for (let offset = 0; offset < text.length; offset += chunkSize) {
      parser.write(text.slice(offset, offset + chunkSize));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    const data = parser.finish();
    return {
      channels: Object.keys(data.programmes).length,
      catalogChannels: Object.keys(data.channels).length,
      programmes: parser.stats.programmesKept,
      programmesSeen: parser.stats.programmesSeen,
      retained: data,
    };
  },
};
