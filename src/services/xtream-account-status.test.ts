import { describe, expect, it } from 'vitest';
import { accountStatusSnapshot } from './xtream-account-status';

const base = {
  auth: true,
  status: 'Active',
  expiresAt: 2_000,
  maxConnections: 2,
  activeConnections: 1,
  allowedOutputFormats: [],
};

describe('accountStatusSnapshot', () => {
  it('normalizes active, expired and unlimited accounts', () => {
    expect(accountStatusSnapshot(base, 1_000_000).state).toBe('active');
    expect(accountStatusSnapshot(base, 3_000_000).state).toBe('expired');
    expect(accountStatusSnapshot({ ...base, status: 'Expired', expiresAt: null }).state)
      .toBe('expired');
    expect(accountStatusSnapshot({ ...base, expiresAt: null }, 3_000_000)).toMatchObject({
      state: 'active',
      expiresAt: null,
    });
  });

  it('distinguishes provider disablement and an unreachable panel', () => {
    expect(accountStatusSnapshot({ ...base, status: 'Disabled' }, 1_000_000).state)
      .toBe('disabled');
    expect(accountStatusSnapshot({ ...base, auth: false }, 1_000_000).state).toBe('disabled');
    expect(accountStatusSnapshot({ ...base, auth: false, expiresAt: 1 }, 1_000_000).state)
      .toBe('disabled');
    expect(accountStatusSnapshot(null).state).toBe('unreachable');
  });

  it('accepts provider type variants after the client has normalized them', () => {
    expect(accountStatusSnapshot({ ...base, status: ' ENABLED ' }, 1_000_000).state)
      .toBe('active');
    expect(accountStatusSnapshot({ ...base, maxConnections: 0 }, 1_000_000)).toMatchObject({
      state: 'active',
      maxConnections: 0,
    });
    expect(accountStatusSnapshot({
      ...base,
      expiresAt: Number.MAX_VALUE,
      maxConnections: -2,
      activeConnections: -1,
    }, 1_000_000)).toMatchObject({
      state: 'active',
      expiresAt: null,
      maxConnections: 0,
      activeConnections: 0,
    });
  });
});
