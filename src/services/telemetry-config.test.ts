// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeTelemetryEndpoint, readTelemetryConfig, validateTelemetryConfig } from './telemetry-config';

beforeEach(() => localStorage.clear());

describe('telemetry addresses', () => {
  it.each([
    [' host ', 'http://host:4318/api/v1/events'],
    ['host:9000/', 'http://host:9000/api/v1/events'],
    ['https://host', 'https://host:4318/api/v1/events'],
    ['http://host:80', 'http://host:80/api/v1/events'],
    ['https://host:443', 'https://host:443/api/v1/events'],
    ['http://host:4318/api/v1/events', 'http://host:4318/api/v1/events'],
    ['https://host:9000/a/events', 'https://host:9000/a/events'],
    ['http://host/a/', 'http://host:4318/a/'],
    ['[2001:db8::1]', 'http://[2001:db8::1]:4318/api/v1/events'],
    ['http://[2001:db8::1]:9000/a', 'http://[2001:db8::1]:9000/a'],
  ])('normalizes %s and keeps normalization idempotent', (input, expected) => {
    expect(normalizeTelemetryEndpoint(input)).toBe(expected);
    expect(normalizeTelemetryEndpoint(expected)).toBe(expected);
  });

  it.each([
    '', ' ', 'ftp://host', 'file:///a', 'javascript:alert(1)', '//host', 'http:///host',
    'http://', 'host:', 'host:0', 'host:65536', 'host:abc', 'ho st', 'host\\a',
    'http://user:secret@host', 'host?token=secret', 'host/a?b=1', 'host/#a',
    '2001:db8::1', '[2001:db8::1', 'x'.repeat(501),
  ])('rejects %s without guessing a different receiver', input => {
    expect(normalizeTelemetryEndpoint(input)).toBe('');
    expect(() => validateTelemetryConfig({ enabled: true, endpoint: input })).toThrow();
  });

  it('allows an empty address only while disabled', () => {
    expect(validateTelemetryConfig({ enabled: false, endpoint: '' })).toEqual({ enabled: false, endpoint: '' });
  });
});

describe('telemetry configuration reads', () => {
  it('reads legacy settings until a single atomic record is saved', () => {
    localStorage.setItem('iptv_telemetry_enabled', 'true');
    localStorage.setItem('iptv_telemetry_endpoint', '"host"');
    expect(readTelemetryConfig()).toEqual({ enabled: true, endpoint: 'http://host:4318/api/v1/events' });
    localStorage.setItem('iptv_telemetry_config', JSON.stringify({ enabled: false, endpoint: 'host:9000' }));
    expect(readTelemetryConfig()).toEqual({ enabled: false, endpoint: 'http://host:9000/api/v1/events' });
  });

  it.each(['null', '[]', '1', '"x"', '{', '{"enabled":"true","endpoint":"host"}',
    '{"enabled":true,"endpoint":"host?token=secret"}'])('fails closed for malformed state %s', value => {
    localStorage.setItem('iptv_telemetry_enabled', 'true');
    localStorage.setItem('iptv_telemetry_endpoint', '"host"');
    localStorage.setItem('iptv_telemetry_config', value);
    expect(readTelemetryConfig().enabled).toBe(false);
  });
});
