import type {
  Channel,
  ParsedPlaylist,
  PlaylistFormatDetection,
  PlaylistParseIssue,
} from '../types';
import { UNCATEGORIZED_GROUP } from '../types';
import { CONFIG } from '../config';
import {
  xtreamCatchupSources,
  xtreamCredentialsFromLiveUrl,
} from '../utils/xtream-url';
import { channelContentKind } from '../utils/m3u-content-kind';

export interface M3UParseOptions {
  maxChannels?: number;
  maxIssues?: number;
}

export interface M3UByteParseMetrics {
  decodeChunkBytes: number;
  decodeChunks: number;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
  maxDecodedChunkChars: number;
}

export interface M3UByteParseResult {
  data: ParsedPlaylist;
  metrics: M3UByteParseMetrics;
}

export interface M3UBatchedParseMetrics extends M3UByteParseMetrics {
  batches: number;
  channelCount: number;
  maxBufferedChannels: number;
}

export interface M3UBatchedParseResult {
  data: Omit<ParsedPlaylist, 'channels'>;
  metrics: M3UBatchedParseMetrics;
}

const DEFAULT_MAX_ISSUES = 500;
const SAMPLE_CHARS = 64 * 1024;

export function parseM3U(
  input: string,
  sourceUrl = '',
  options: M3UParseOptions = {},
): ParsedPlaylist {
  const text = stripBom(input);
  const detection = detectPlaylistFormat(input);
  const parser = new M3UStreamParser(detection, sourceUrl, options);
  parser.write(text);
  return parser.finish();
}

export function parseM3UBytes(
  bytes: Uint8Array,
  sourceUrl = '',
  options: M3UParseOptions = {},
): ParsedPlaylist {
  return parseM3UBytesWithMetrics(bytes, sourceUrl, options).data;
}

export function parseM3UBytesWithMetrics(
  bytes: Uint8Array,
  sourceUrl = '',
  options: M3UParseOptions = {},
  requestedChunkBytes = CONFIG.M3U.DECODE_CHUNK_BYTES,
): M3UByteParseResult {
  const chunkBytes = Math.max(1, Math.floor(requestedChunkBytes));
  const byteOrder = playlistByteOrder(bytes);
  let parser: M3UStreamParser | null = null;
  let detectionPrefix = '';
  let decodeChunks = 0;
  let maxDecodedChunkChars = 0;

  const writeDecoded = (decoded: string): void => {
    if (!decoded) return;
    maxDecodedChunkChars = Math.max(maxDecodedChunkChars, decoded.length);
    if (parser) {
      parser.write(decoded);
      return;
    }
    detectionPrefix += decoded;
    if (detectionPrefix.length >= SAMPLE_CHARS) {
      parser = new M3UStreamParser(
        detectPlaylistFormat(detectionPrefix),
        sourceUrl,
        options,
      );
      parser.write(detectionPrefix);
      detectionPrefix = '';
    }
  };

  if (byteOrder.encoding === 'utf-8') {
    const decoder = new TextDecoder('utf-8');
    for (let start = byteOrder.offset; start < bytes.length; start += chunkBytes) {
      const end = Math.min(start + chunkBytes, bytes.length);
      writeDecoded(decoder.decode(bytes.subarray(start, end), { stream: true }));
      decodeChunks++;
    }
    writeDecoded(decoder.decode());
  } else {
    const littleEndian = byteOrder.encoding === 'utf-16le';
    const decoder = new Utf16ChunkDecoder(littleEndian);
    for (let start = byteOrder.offset; start < bytes.length; start += chunkBytes) {
      const end = Math.min(start + chunkBytes, bytes.length);
      writeDecoded(decoder.decode(bytes.subarray(start, end)));
      decodeChunks++;
    }
    writeDecoded(decoder.finish());
  }

  if (!parser) {
    parser = new M3UStreamParser(
      detectPlaylistFormat(detectionPrefix),
      sourceUrl,
      options,
    );
    parser.write(detectionPrefix);
  }
  return {
    data: parser.finish(),
    metrics: {
      decodeChunkBytes: chunkBytes,
      decodeChunks,
      encoding: byteOrder.encoding,
      maxDecodedChunkChars,
    },
  };
}

export async function parseM3UBytesInBatches(
  bytes: Uint8Array,
  sourceUrl: string,
  onBatch: (channels: Channel[]) => Promise<void>,
  options: M3UParseOptions = {},
  requestedChunkBytes = CONFIG.M3U.DECODE_CHUNK_BYTES,
  requestedBatchSize = CONFIG.M3U.RESULT_BATCH_SIZE,
): Promise<M3UBatchedParseResult> {
  const chunkBytes = Math.max(1, Math.floor(requestedChunkBytes));
  const batchSize = Math.max(1, Math.floor(requestedBatchSize));
  const byteOrder = playlistByteOrder(bytes);
  let parser: M3UStreamParser | null = null;
  let detectionPrefix = '';
  let decodeChunks = 0;
  let maxDecodedChunkChars = 0;
  let maxBufferedChannels = 0;
  let batches = 0;
  let channelCount = 0;

  const emitBatch = async (channels: Channel[]): Promise<void> => {
    await onBatch(channels);
    batches++;
    channelCount += channels.length;
  };

  const flushParser = async (decoded: string): Promise<void> => {
    if (decoded) maxDecodedChunkChars = Math.max(maxDecodedChunkChars, decoded.length);
    if (!parser) {
      detectionPrefix += decoded;
      if (detectionPrefix.length < SAMPLE_CHARS) return;
      parser = new M3UStreamParser(
        detectPlaylistFormat(detectionPrefix),
        sourceUrl,
        options,
        batchSize,
      );
      decoded = detectionPrefix;
      detectionPrefix = '';
    }
    parser.write(decoded);
    maxBufferedChannels = Math.max(maxBufferedChannels, parser.bufferedChannelCount);
    while (parser.bufferedChannelCount >= batchSize) {
      await emitBatch(parser.takeChannels(batchSize));
      parser.write('');
      maxBufferedChannels = Math.max(maxBufferedChannels, parser.bufferedChannelCount);
    }
  };

  if (byteOrder.encoding === 'utf-8') {
    const decoder = new TextDecoder('utf-8');
    for (let start = byteOrder.offset; start < bytes.length; start += chunkBytes) {
      const end = Math.min(start + chunkBytes, bytes.length);
      await flushParser(decoder.decode(bytes.subarray(start, end), { stream: true }));
      decodeChunks++;
    }
    await flushParser(decoder.decode());
  } else {
    const littleEndian = byteOrder.encoding === 'utf-16le';
    const decoder = new Utf16ChunkDecoder(littleEndian);
    for (let start = byteOrder.offset; start < bytes.length; start += chunkBytes) {
      const end = Math.min(start + chunkBytes, bytes.length);
      await flushParser(decoder.decode(bytes.subarray(start, end)));
      decodeChunks++;
    }
    await flushParser(decoder.finish());
  }

  if (!parser) {
    parser = new M3UStreamParser(
      detectPlaylistFormat(detectionPrefix),
      sourceUrl,
      options,
      batchSize,
    );
    parser.write(detectionPrefix);
    maxBufferedChannels = Math.max(maxBufferedChannels, parser.bufferedChannelCount);
    while (parser.bufferedChannelCount >= batchSize) {
      await emitBatch(parser.takeChannels(batchSize));
      parser.write('');
      maxBufferedChannels = Math.max(maxBufferedChannels, parser.bufferedChannelCount);
    }
  }
  const complete = parser.finish();
  maxBufferedChannels = Math.max(maxBufferedChannels, complete.channels.length);
  for (let index = 0; index < complete.channels.length; index += batchSize) {
    await emitBatch(complete.channels.slice(index, index + batchSize));
  }
  const { channels: _channels, ...data } = complete;
  return {
    data,
    metrics: {
      decodeChunkBytes: chunkBytes,
      decodeChunks,
      encoding: byteOrder.encoding,
      maxDecodedChunkChars,
      batches,
      channelCount,
      maxBufferedChannels,
    },
  };
}

export function decodePlaylistBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16(bytes, 2, true);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16(bytes, 2, false);
  const offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(bytes.subarray(offset));
}

class M3UStreamParser {
  private readonly channels: Channel[] = [];
  private readonly groupSet = new Set<string>();
  private readonly headerAttributes: Record<string, string> = {};
  private readonly issues: PlaylistParseIssue[] = [];
  private readonly maxChannels: number;
  private readonly maxIssues: number;
  private current: Channel | null = null;
  private epgUrls: string[] = [];
  private lineNo = 0;
  private maxConnections: number | undefined;
  private playlistName: string | undefined;
  private remainder = '';
  private sawHeader = false;
  private stopped = false;
  private totalChannels = 0;

  constructor(
    private readonly detection: PlaylistFormatDetection,
    private readonly sourceUrl: string,
    options: M3UParseOptions,
    private readonly channelBufferLimit = 0,
  ) {
    this.maxChannels = options.maxChannels ?? 0;
    this.maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
  }

  write(chunk: string): void {
    if ((!chunk && !this.remainder) || this.stopped || this.isWrongDocument()) return;
    const text = this.remainder + chunk;
    let lineStart = 0;
    let position = 0;
    while (position < text.length) {
      const code = text.charCodeAt(position);
      if (code !== 10 && code !== 13) {
        position++;
        continue;
      }
      if (code === 13 && position + 1 === text.length) break;
      this.processLine(text.slice(lineStart, position));
      position += code === 13 && text.charCodeAt(position + 1) === 10 ? 2 : 1;
      lineStart = position;
      if (this.stopped
          || (this.channelBufferLimit > 0
            && this.channels.length >= this.channelBufferLimit)) break;
    }
    this.remainder = this.stopped ? '' : text.slice(lineStart);
  }

  get bufferedChannelCount(): number {
    return this.channels.length;
  }

  takeChannels(count: number): Channel[] {
    return this.channels.splice(0, count);
  }

  finish(): ParsedPlaylist {
    if (!this.stopped && !this.isWrongDocument() && this.remainder) {
      const finalLine = this.remainder.charCodeAt(this.remainder.length - 1) === 13
        ? this.remainder.slice(0, -1)
        : this.remainder;
      this.processLine(finalLine);
    }
    this.remainder = '';

    if (this.isWrongDocument()) {
      this.addIssue(
        'error',
        'wrong-format',
        `Expected an M3U playlist but received ${this.detection.format}`,
        1,
      );
      return result(
        [],
        [],
        [],
        this.headerAttributes,
        this.detection.format,
        this.issues,
      );
    }

    if (this.isHls()) {
      if (this.sourceUrl) {
        const channel = emptyChannel(nameFromUrl(this.sourceUrl));
        channel.url = this.sourceUrl;
        return result(
          [channel],
          [UNCATEGORIZED_GROUP],
          this.epgUrls,
          this.headerAttributes,
          this.detection.format,
          this.issues,
          this.maxConnections,
          this.playlistName,
        );
      }
      this.addIssue('error', 'hls-without-source', 'HLS input requires its source URL', 1);
      return result(
        [],
        [],
        this.epgUrls,
        this.headerAttributes,
        this.detection.format,
        this.issues,
        this.maxConnections,
        this.playlistName,
      );
    }

    if (this.current) {
      this.addIssue(
        'warning',
        'orphan-extinf',
        `"${this.current.name}" has no stream URL; skipped`,
        this.lineNo,
      );
    }
    if (!this.sawHeader) {
      this.addIssue('warning', 'missing-extm3u', 'Playlist has no #EXTM3U header', 1);
    }
    if (!this.totalChannels) {
      this.addIssue('error', 'no-channels', 'No playable entries were found', 1);
    }
    return result(
      this.channels,
      Array.from(this.groupSet),
      this.epgUrls,
      this.headerAttributes,
      this.detection.format,
      this.issues,
      this.maxConnections,
      this.playlistName,
    );
  }

  private readonly addIssue = (
    level: PlaylistParseIssue['level'],
    code: string,
    message: string,
    line: number,
  ): void => {
    if (this.issues.length < this.maxIssues) {
      this.issues.push({ level, code, message, line });
    }
  };

  private isHls(): boolean {
    return this.detection.format === 'hls-master'
      || this.detection.format === 'hls-media';
  }

  private isWrongDocument(): boolean {
    return this.detection.format === 'xmltv'
      || this.detection.format === 'json'
      || this.detection.format === 'html';
  }

  private processLine(rawLine: string): void {
    this.lineNo++;
    const line = rawLine.trim();
    if (!line) return;
    const tagEnd = directiveEnd(line);
    const tag = tagEnd > 0 ? line.slice(0, tagEnd).toUpperCase() : '';
    const hasColon = tagEnd > 0 && line.charCodeAt(tagEnd) === 58;
    const body = tagEnd > 0 ? line.slice(tagEnd + (hasColon ? 1 : 0)) : '';

    if (this.isHls()) {
      if (tag === '#EXTM3U') this.applyHeader(body);
      else if (tag === '#PLAYLIST') this.playlistName = body.trim() || undefined;
      return;
    }

    switch (tag) {
      case '#EXTM3U':
        this.sawHeader = true;
        this.applyHeader(body);
        break;
      case '#EXTINF':
        if (this.current) {
          this.addIssue(
            'warning',
            'orphan-extinf',
            `"${this.current.name}" has no stream URL; skipped`,
            this.lineNo - 1,
          );
        }
        this.current = parseExtInf(body);
        break;
      case '#EXTGRP':
        if (this.current) applyGroups(this.current, body.trim(), true);
        break;
      case '#EXTVLCOPT':
        if (this.current) addExtra(this.current, body, false);
        break;
      case '#KODIPROP':
        if (this.current) addExtra(this.current, body, true);
        break;
      case '#EXTHTTP':
        if (this.current) {
          parseHttpHeaders(this.current, body, this.lineNo, this.addIssue);
        }
        break;
      case '#PLAYLIST':
        this.playlistName = body.trim() || undefined;
        break;
      default:
        this.processLocation(line);
        break;
    }
  }

  private applyHeader(body: string): void {
    const attributes = scanAttributes(body, 0).values;
    Object.assign(this.headerAttributes, attributes);
    this.epgUrls = collectEpgUrls(attributes);
    const maxConnections = parseInt(attributes['max-conn'] || '', 10);
    if (maxConnections > 0) this.maxConnections = maxConnections;
  }

  private processLocation(line: string): void {
    if (line.charCodeAt(0) === 35) return;
    if (!this.current && this.detection.format === 'unknown'
        && !isPlaylistLocation(line)) {
      this.addIssue(
        'warning',
        'unrecognized-line',
        'Ignored a line that is not a stream location',
        this.lineNo,
      );
      return;
    }
    if (!this.current) this.current = emptyChannel(nameFromUrl(line));
    this.current.url = line;
    if (this.current.catchup.toLowerCase() === 'xc' && !this.current.catchupSource) {
      const inferred = xtreamCredentialsFromLiveUrl(line);
      if (inferred) {
        const sources = xtreamCatchupSources(
          inferred.credentials,
          inferred.streamId,
          inferred.output,
        );
        this.current.catchup = 'xtream';
        this.current.catchupSource = sources[0].url;
        this.current.catchupFallbackSource = sources[3].url;
        this.current.catchupSources = sources;
        this.current.catchupStreamId = inferred.streamId;
      }
    }
    if (this.current.group) this.groupSet.add(this.current.group);
    for (const group of this.current.sourceGroups ?? []) this.groupSet.add(group);
    this.current.contentKind = channelContentKind(this.current);
    this.channels.push(this.current);
    this.totalChannels++;
    this.current = null;
    if (this.maxChannels > 0 && this.totalChannels >= this.maxChannels) {
      this.addIssue(
        'warning',
        'channel-limit',
        `Stopped after ${String(this.maxChannels)} channels`,
        this.lineNo,
      );
      this.stopped = true;
    }
  }
}

interface PlaylistByteOrder {
  encoding: M3UByteParseMetrics['encoding'];
  offset: number;
}

function playlistByteOrder(bytes: Uint8Array): PlaylistByteOrder {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', offset: 2 };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', offset: 2 };
  }
  const offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return { encoding: 'utf-8', offset };
}

class Utf16ChunkDecoder {
  private pendingByte = -1;

  constructor(private readonly littleEndian: boolean) {}

  decode(bytes: Uint8Array): string {
    const chunks: string[] = [];
    const units: number[] = [];
    let index = 0;
    if (this.pendingByte >= 0 && bytes.length) {
      units.push(this.codeUnit(this.pendingByte, bytes[0]));
      this.pendingByte = -1;
      index = 1;
    }
    for (; index + 1 < bytes.length; index += 2) {
      units.push(this.codeUnit(bytes[index], bytes[index + 1]));
      if (units.length === 4096) {
        chunks.push(String.fromCharCode(...units));
        units.length = 0;
      }
    }
    if (index < bytes.length) this.pendingByte = bytes[index];
    if (units.length) chunks.push(String.fromCharCode(...units));
    return chunks.join('');
  }

  finish(): string {
    this.pendingByte = -1;
    return '';
  }

  private codeUnit(first: number, second: number): number {
    return this.littleEndian ? first | second << 8 : first << 8 | second;
  }
}

export function detectPlaylistFormat(input: string): PlaylistFormatDetection {
  const hadBom = input.charCodeAt(0) === 0xfeff;
  const sample = stripBom(input).slice(0, SAMPLE_CHARS);
  const trimmed = sample.replace(/^\s+/, '');
  if (!trimmed) {
    return { format: 'unknown', confidence: 1, reason: 'empty document', hadBom };
  }
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!DOCTYPE\s+tv\b[^>]*>\s*)?<tv\b/i.test(trimmed)) {
    return { format: 'xmltv', confidence: 0.95, reason: 'XMLTV markup', hadBom };
  }
  if (/^<(?:!DOCTYPE\s+html|html|head|body)\b/i.test(trimmed)) {
    return { format: 'html', confidence: 0.95, reason: 'HTML document', hadBom };
  }
  if (trimmed.charCodeAt(0) === 123 || trimmed.charCodeAt(0) === 91) {
    return { format: 'json', confidence: 0.8, reason: 'JSON document', hadBom };
  }
  if (/^#EXT-X-(?:STREAM-INF|I-FRAME-STREAM-INF):/im.test(sample)) {
    return { format: 'hls-master', confidence: 0.98, reason: 'HLS variant tags', hadBom };
  }
  if (/^#EXT-X-(?:TARGETDURATION|MEDIA-SEQUENCE|PLAYLIST-TYPE):/im.test(sample)
      || /^#EXT-X-ENDLIST(?:\s|$)/im.test(sample)) {
    return { format: 'hls-media', confidence: 0.98, reason: 'HLS media tags', hadBom };
  }
  if (/^#EXTINF:/im.test(sample)) {
    return {
      format: 'extended-m3u',
      confidence: /\b(?:tvg-id|group-title|catchup)\s*=/i.test(sample) ? 0.97 : 0.6,
      reason: 'EXTINF entries',
      hadBom,
    };
  }
  if (/^#EXTM3U\b/im.test(sample)) {
    return { format: 'simple-m3u', confidence: 0.7, reason: 'M3U header', hadBom };
  }
  const lines = sample.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean);
  const urlCount = lines.filter(line => /^[a-z][a-z0-9+.-]*:\/\//i.test(line)).length;
  if (lines.length && urlCount / lines.length >= 0.8) {
    return { format: 'simple-m3u', confidence: 0.75, reason: 'URL list', hadBom };
  }
  return { format: 'unknown', confidence: 0.2, reason: 'no recognized markers', hadBom };
}

function result(
  channels: Channel[],
  groups: string[],
  epgUrls: string[],
  headerAttributes: Record<string, string>,
  format: ParsedPlaylist['format'],
  issues: PlaylistParseIssue[],
  maxConnections?: number,
  name?: string,
): ParsedPlaylist {
  return {
    channels,
    groups,
    epgUrl: epgUrls[0] ?? '',
    epgUrls,
    headerAttributes,
    maxConnections,
    name,
    format,
    issues,
  };
}

function parseExtInf(body: string): Channel {
  let index = 0;
  while (index < body.length && isWhitespace(body.charCodeAt(index))) index++;
  if (body.charCodeAt(index) === 43 || body.charCodeAt(index) === 45) index++;
  while (index < body.length) {
    const code = body.charCodeAt(index);
    if ((code >= 48 && code <= 57) || code === 46) index++;
    else break;
  }
  const scanned = scanAttributes(body, index);
  const attrs = scanned.values;
  const displayName = scanned.titleIndex >= 0
    ? body.slice(scanned.titleIndex + 1).trim()
    : '';
  const channel = emptyChannel(
    attrs['tvg-name'] || displayName || attrs['tvg-id'] || 'Unknown',
  );
  channel.id = attrs['tvg-id'] || '';
  channel.logo = attrs['tvg-logo'] || attrs.logo || '';
  channel.catchup = attrs.catchup || attrs['catchup-type'] || '';
  channel.catchupSource = attrs['catchup-source'] || '';
  channel.catchupDays = parseInt(
    attrs['catchup-days'] || attrs['tvg-rec'] || '0',
    10,
  ) || 0;
  applyGroups(channel, attrs['group-title'] || UNCATEGORIZED_GROUP, false);

  const channelNumberRaw = attrs['tvg-chno']
    || attrs['channel-number']
    || attrs['tvg-num'];
  if (channelNumberRaw) {
    const channelNumber = parseInt(channelNumberRaw, 10);
    if (Number.isFinite(channelNumber)) channel.channelNumber = channelNumber;
  }
  const tvgShiftRaw = attrs['tvg-shift'] || attrs.timeshift;
  if (tvgShiftRaw) {
    const tvgShift = parseFloat(tvgShiftRaw);
    if (Number.isFinite(tvgShift)) channel.tvgShift = tvgShift;
  }
  if (attrs.radio === 'true' || attrs.radio === '1') channel.radio = true;
  preserveUnknownAttributes(channel, attrs);
  return channel;
}

interface ScannedAttributes {
  values: Record<string, string>;
  titleIndex: number;
}

function scanAttributes(input: string, start: number): ScannedAttributes {
  const values: Record<string, string> = {};
  let index = start;
  while (index < input.length) {
    while (index < input.length && isWhitespace(input.charCodeAt(index))) index++;
    if (input.charCodeAt(index) === 44) return { values, titleIndex: index };

    const keyStart = index;
    while (index < input.length) {
      const code = input.charCodeAt(index);
      if (isWhitespace(code) || code === 61 || code === 44) break;
      index++;
    }
    const keyEnd = index;
    while (index < input.length && isWhitespace(input.charCodeAt(index))) index++;
    if (input.charCodeAt(index) !== 61) continue;

    index++;
    while (index < input.length && isWhitespace(input.charCodeAt(index))) index++;
    const quote = input.charCodeAt(index);
    let valueStart: number;
    let valueEnd: number;
    if (quote === 34 || quote === 39) {
      valueStart = ++index;
      while (index < input.length && input.charCodeAt(index) !== quote) index++;
      valueEnd = index;
      if (index < input.length) index++;
    } else {
      valueStart = index;
      while (index < input.length) {
        const code = input.charCodeAt(index);
        if (isWhitespace(code) || code === 44) break;
        index++;
      }
      valueEnd = index;
    }
    if (keyEnd > keyStart) {
      values[input.slice(keyStart, keyEnd).toLowerCase()] =
        input.slice(valueStart, valueEnd);
    }
  }
  return { values, titleIndex: -1 };
}

function emptyChannel(name: string): Channel {
  return {
    id: '',
    name,
    logo: '',
    group: UNCATEGORIZED_GROUP,
    url: '',
    extras: null,
    playlistIds: [],
    catchup: '',
    catchupSource: '',
    catchupDays: 0,
  };
}

function applyGroups(channel: Channel, raw: string, override: boolean): void {
  const value = raw.trim();
  if (!value) return;
  if (value.indexOf(';') < 0) {
    if (override) channel.sourceGroups = undefined;
    if (override || channel.group === UNCATEGORIZED_GROUP) channel.group = value;
    return;
  }

  const groups = value.split(';').map(group => group.trim()).filter(Boolean);
  if (!groups.length) return;
  const existing = override
    ? []
    : channel.sourceGroups ?? (channel.group === UNCATEGORIZED_GROUP ? [] : [channel.group]);
  for (const group of groups) {
    if (!existing.includes(group)) existing.push(group);
  }
  channel.sourceGroups = existing;
  if (override || channel.group === UNCATEGORIZED_GROUP) channel.group = groups[0];
}

function preserveUnknownAttributes(
  channel: Channel,
  attributes: Record<string, string>,
): void {
  let unknown: Record<string, string> | undefined;
  for (const key in attributes) {
    if (isKnownAttribute(key)) continue;
    if (!unknown) unknown = {};
    unknown[key] = attributes[key];
  }
  if (unknown) channel.sourceAttributes = unknown;
}

function isKnownAttribute(key: string): boolean {
  switch (key) {
    case 'tvg-id':
    case 'tvg-name':
    case 'tvg-logo':
    case 'logo':
    case 'group-title':
    case 'catchup':
    case 'catchup-type':
    case 'catchup-source':
    case 'catchup-days':
    case 'tvg-rec':
    case 'tvg-chno':
    case 'channel-number':
    case 'tvg-num':
    case 'tvg-shift':
    case 'timeshift':
    case 'radio':
      return true;
    default:
      return false;
  }
}

function addExtra(channel: Channel, body: string, kodi: boolean): void {
  const equals = body.indexOf('=');
  if (equals <= 0) return;
  if (!channel.extras) channel.extras = {};
  const key = body.slice(0, equals).trim().toLowerCase();
  channel.extras[key] = body.slice(equals + 1).trim();
  if (kodi) {
    if (!channel.sourceAttributes) channel.sourceAttributes = {};
    channel.sourceAttributes[`kodiprop:${key}`] = body.slice(equals + 1).trim();
  }
}

function parseHttpHeaders(
  channel: Channel,
  body: string,
  line: number,
  addIssue: (
    level: PlaylistParseIssue['level'],
    code: string,
    message: string,
    line: number,
  ) => void,
): void {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const headers: Record<string, string> = {};
    for (const key of Object.keys(value)) {
      const header = (value as Record<string, unknown>)[key];
      if (typeof header === 'string') headers[key] = header;
    }
    channel.httpHeaders = headers;
    if (!channel.extras) channel.extras = {};
    const userAgent = headerValue(headers, 'user-agent');
    const referrer = headerValue(headers, 'referer') || headerValue(headers, 'referrer');
    if (userAgent) channel.extras['http-user-agent'] = userAgent;
    if (referrer) channel.extras['http-referrer'] = referrer;
  } catch {
    addIssue('warning', 'bad-exthttp', 'EXTHTTP payload is not valid JSON', line);
  }
}

function headerValue(headers: Record<string, string>, wanted: string): string {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return '';
}

function collectEpgUrls(attributes: Record<string, string>): string[] {
  const urls: string[] = [];
  for (const key of ['url-tvg', 'x-tvg-url', 'tvg-url']) {
    for (const part of (attributes[key] || '').split(',')) {
      const url = part.trim();
      if (url && !urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

function directiveEnd(line: string): number {
  if (line.charCodeAt(0) !== 35) return -1;
  let index = 1;
  while (index < line.length) {
    const code = line.charCodeAt(index);
    const valid = (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || code === 45;
    if (!valid) break;
    index++;
  }
  return index;
}

function nameFromUrl(url: string): string {
  try {
    const { pathname, hostname } = new URL(url);
    const base = pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(base.replace(/\.[^./]+$/, '')) || hostname || 'Stream';
  } catch {
    return 'Stream';
  }
}

function isPlaylistLocation(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value)
    || value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../');
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function decodeUtf16(bytes: Uint8Array, offset: number, littleEndian: boolean): string {
  const chunks: string[] = [];
  const units: number[] = [];
  for (let index = offset; index + 1 < bytes.length; index += 2) {
    units.push(littleEndian
      ? bytes[index] | bytes[index + 1] << 8
      : bytes[index] << 8 | bytes[index + 1]);
    if (units.length === 4096) {
      chunks.push(String.fromCharCode(...units));
      units.length = 0;
    }
  }
  if (units.length) chunks.push(String.fromCharCode(...units));
  return chunks.join('');
}

function isWhitespace(code: number): boolean {
  return code === 32 || code === 9;
}
