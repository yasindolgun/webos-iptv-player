import { describe, expect, it } from 'vitest';
import {
  containerMime,
  mpdOpeningVerdict,
  sniffStreamContentType,
  streamMime,
  streamRouteKey,
  streamUrlMime,
} from './url';

const DASH = 'application/dash+xml';

describe('streamRouteKey', () => {
  it('scopes proxy MIME results to each resource path', () => {
    expect(streamRouteKey('http://host/play/token-a'))
      .not.toBe(streamRouteKey('http://host/play/token-b'));
  });

  it('keeps stream identity and format without persisting credentials', () => {
    const key = streamRouteKey(
      'http://host/play?username=u&password=p&stream_id=42&output=m3u8',
    );
    expect(key).toMatch(/^http:\/\/host\/\.stream\/[a-f0-9]+$/);
    expect(key).not.toMatch(/(?:username|password|\bu\b|\bp\b)/);
    expect(key).toBe(streamRouteKey(
      'http://host/play?username=other&password=secret&stream_id=42&output=m3u8',
    ));
  });

  it('does not persist path credentials or opaque tokens', () => {
    const key = streamRouteKey('http://host/live/user/pass/42');
    expect(key).not.toMatch(/user|pass|42/);
    expect(streamRouteKey('http://host/play/token-a')).not.toContain('token-a');
  });

  it('keeps Xtream resources stable when path credentials rotate', () => {
    expect(streamRouteKey('http://host/live/user/pass/42.ts'))
      .toBe(streamRouteKey('http://host/live/other/secret/42.ts'));
    expect(streamRouteKey('http://host/live/user/pass/42.ts'))
      .not.toBe(streamRouteKey('http://host/live/user/pass/43.ts'));
  });

  it('separates stream resources and requested formats', () => {
    expect(streamRouteKey('http://host/play?id=42&token=a'))
      .toBe(streamRouteKey('http://host/play?id=42&token=b'));
    expect(streamRouteKey('http://host/play?id=42'))
      .not.toBe(streamRouteKey('http://host/play?id=43'));
    expect(streamRouteKey('http://host/play?id=42&output=ts'))
      .not.toBe(streamRouteKey('http://host/play?id=42&output=m3u8'));
  });
});

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// A synthetic TS payload: 0x47 sync bytes at the packet stride the sniffer scans.
function tsPrefix(packetSize: number, payload = ''): Uint8Array {
  const buffer = new Uint8Array(packetSize * 3 + 1);
  buffer[0] = 0x47;
  buffer[packetSize] = 0x47;
  buffer[packetSize * 2] = 0x47;
  buffer.set(bytes(payload), 1);
  return buffer;
}

describe('streamUrlMime', () => {
  it('keeps the existing TS, FLV and HLS classifications', () => {
    expect(streamUrlMime('http://host/a.ts')).toBe('video/mp2t');
    expect(streamUrlMime('http://host/a?extension=ts')).toBe('video/mp2t');
    expect(streamUrlMime('http://host/a?output=ts')).toBe('video/mp2t');
    expect(streamUrlMime('http://host/a?output_format=ts')).toBe('video/mp2t');
    expect(streamUrlMime('http://host/a.flv')).toBe('video/x-flv');
    expect(streamUrlMime('http://host/a.m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(streamUrlMime('http://host/a?output=m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(streamUrlMime('http://host/a?output_format=m3u8'))
      .toBe('application/vnd.apple.mpegurl');
    expect(streamUrlMime('http://host/a')).toBe('');
  });

  it('classifies an .mpd URL as DASH', () => {
    expect(streamUrlMime('http://host/a.mpd')).toBe(DASH);
    expect(streamUrlMime('http://host/a.MPD')).toBe(DASH);
    expect(streamUrlMime('http://host/a.mpd?token=1')).toBe(DASH);
    expect(streamUrlMime('http://host/a.mpd#f')).toBe(DASH);
  });

  it('classifies a requested mpd format as DASH', () => {
    expect(streamUrlMime('http://host/a?extension=mpd')).toBe(DASH);
    expect(streamUrlMime('http://host/a?x=1&output=mpd')).toBe(DASH);
    expect(streamUrlMime('http://host/a?output_format=mpd&x=1')).toBe(DASH);
  });

  it('does not classify a path that merely contains mpd', () => {
    expect(streamUrlMime('http://host/mpd/a')).toBe('');
    expect(streamUrlMime('http://host/a.mpd2')).toBe('');
  });
});

describe('streamMime', () => {
  it('classifies the DASH content types', () => {
    expect(streamMime('application/dash+xml')).toBe(DASH);
    expect(streamMime('Application/DASH+XML; charset=utf-8')).toBe(DASH);
    expect(streamMime('application/vnd.mpeg.dash.mpd')).toBe(DASH);
  });

  it('keeps the existing classifications', () => {
    expect(streamMime('video/mp2t')).toBe('video/mp2t');
    expect(streamMime('application/vnd.apple.mpegurl')).toBe('application/vnd.apple.mpegurl');
    expect(streamMime('text/html')).toBe('');
  });
});

describe('sniffStreamContentType', () => {
  it('sniffs an MPD served as octet-stream', () => {
    expect(sniffStreamContentType('application/octet-stream',
      bytes('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011">'))).toBe(DASH);
    expect(sniffStreamContentType('application/octet-stream', bytes('<MPD '))).toBe(DASH);
    expect(sniffStreamContentType('application/octet-stream',
      bytes('\uFEFF\n  <?xml version="1.0" encoding="UTF-8"?>\n<MPD>'))).toBe(DASH);
    expect(sniffStreamContentType('application/octet-stream',
      bytes('<?xml version="1.0"?>\n<!-- c -->\n<MPD>'))).toBe(DASH);
    expect(sniffStreamContentType('application/octet-stream', bytes('<dash:MPD/>')))
      .toBe(DASH);
    expect(sniffStreamContentType('application/xml', bytes('<MPD/>'))).toBe(DASH);
    expect(sniffStreamContentType('text/xml', bytes('<?xml version="1.0"?><MPD/>')))
      .toBe(DASH);
  });

  describe('mpdOpeningVerdict', () => {
    it('accepts legal MPD preambles split across chunks', () => {
      expect(mpdOpeningVerdict(bytes(' \n<!-- lead'), false)).toBe('undecided');
      expect(mpdOpeningVerdict(
        bytes(' \n<!-- lead -->\n<?xml version="1.0"?>\n<dash:MPD>'),
        false,
      )).toBe('match');
    });

    it('rejects a completed non-MPD root', () => {
      expect(mpdOpeningVerdict(bytes('<html><body>error</body>'), false))
        .toBe('mismatch');
    });
  });

  it('leaves other XML alone', () => {
    expect(sniffStreamContentType('application/octet-stream',
      bytes('<?xml version="1.0"?><error>no</error>')))
      .toBe('application/octet-stream');
    expect(sniffStreamContentType('application/xml', bytes('<error>no</error>')))
      .toBe('application/xml');
  });

  it('prefers a TS payload that happens to carry MPD bytes', () => {
    expect(sniffStreamContentType('application/octet-stream', tsPrefix(188, '<MPD')))
      .toBe('video/mp2t');
    expect(sniffStreamContentType('application/octet-stream', tsPrefix(192)))
      .toBe('video/mp2t');
  });

  it('keeps a declared content type', () => {
    expect(sniffStreamContentType('application/dash+xml', bytes('<MPD>'))).toBe(DASH);
    expect(sniffStreamContentType('application/octet-stream', bytes('#EXTM3U\n')))
      .toBe('application/vnd.apple.mpegurl');
  });
});

describe('containerMime', () => {
  it('never treats an MPD as a progressive container', () => {
    expect(containerMime('http://host/a.mpd')).toBe('');
    expect(containerMime('http://host/a.mp4')).toBe('video/mp4');
  });
});
