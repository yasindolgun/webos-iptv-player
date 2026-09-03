import { CONFIG } from '../config';

export interface TelemetryConfig {
  enabled: boolean;
  endpoint: string;
}

export const TELEMETRY_CONFIG_KEY = 'telemetry_config';

export function normalizeTelemetryEndpoint(value: string): string {
  const input = value.trim();
  if (!input || input.length > 500 || /[\s\\?#]/.test(input)) return '';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input) && !/^https?:\/\//i.test(input)) return '';
  try {
    const address = /^https?:\/\//i.test(input) ? input : `http://${input}`;
    const url = new URL(address);
    if (!url.hostname || url.username || url.password || url.search || url.hash) return '';
    const authority = address.slice(address.indexOf('://') + 3).split('/')[0];
    if (!authority || authority.endsWith(':')) return '';
    const port = authority.match(/:(\d+)$/);
    if (port && Number(port[1]) === 0) return '';
    if (url.pathname === '/') url.pathname = '/api/v1/events';
    return `${url.protocol}//${url.hostname}:${port ? Number(port[1]) : 4318}${url.pathname}`;
  } catch {
    return '';
  }
}

export function validateTelemetryConfig(value: TelemetryConfig): TelemetryConfig {
  const endpoint = normalizeTelemetryEndpoint(value.endpoint);
  if ((value.endpoint.trim() && !endpoint) || (value.enabled && !endpoint)) {
    throw new Error('Invalid telemetry server address');
  }
  return { enabled: value.enabled === true, endpoint };
}

export function readTelemetryConfig(): TelemetryConfig {
  try {
    const stored = localStorage.getItem(`${CONFIG.STORAGE_PREFIX}${TELEMETRY_CONFIG_KEY}`);
    const value: unknown = stored !== null ? JSON.parse(stored) : {
      enabled: JSON.parse(localStorage.getItem(`${CONFIG.STORAGE_PREFIX}telemetry_enabled`) ?? 'false'),
      endpoint: JSON.parse(localStorage.getItem(`${CONFIG.STORAGE_PREFIX}telemetry_endpoint`) ?? '""'),
    };
    if (!value || typeof value !== 'object') return { enabled: false, endpoint: '' };
    const record = value as Partial<TelemetryConfig>;
    const endpoint = typeof record.endpoint === 'string'
      ? normalizeTelemetryEndpoint(record.endpoint) : '';
    return { enabled: record.enabled === true && !!endpoint, endpoint };
  } catch {
    return { enabled: false, endpoint: '' };
  }
}
