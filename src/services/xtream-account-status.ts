import type {
  PlaylistEntry,
  XtreamAccountStatusSnapshot,
} from '../types';
import { createXtreamClient, type XtreamAccountInfo } from './xtream-client';
import { StorageService } from './storage-service';

export const XTREAM_ACCOUNT_STATUS_EVENT = 'xtream-account-status-changed';

export function accountStatusSnapshot(
  info: XtreamAccountInfo | null,
  checkedAt = Date.now(),
): XtreamAccountStatusSnapshot {
  const expiresAt = info?.expiresAt !== null && info?.expiresAt !== undefined
    && Number.isFinite(info.expiresAt)
    && Number.isFinite(new Date(info.expiresAt * 1000).getTime())
    ? info.expiresAt
    : null;
  let state: XtreamAccountStatusSnapshot['state'];
  const normalized = info?.status.trim().toLowerCase() ?? '';
  if (!info) state = 'unreachable';
  else if (normalized === 'expired') state = 'expired';
  else if (!info.auth || (normalized && normalized !== 'active' && normalized !== 'enabled')) {
    state = 'disabled';
  } else state = expiresAt !== null && expiresAt * 1000 <= checkedAt ? 'expired' : 'active';
  return {
    state,
    expiresAt,
    maxConnections: Math.max(0, Math.floor(info?.maxConnections ?? 0)),
    activeConnections: Math.max(0, Math.floor(info?.activeConnections ?? 0)),
    checkedAt,
  };
}

function announce(accountId: string): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(XTREAM_ACCOUNT_STATUS_EVENT, {
    detail: { accountId },
  }));
}

/** Refresh without retaining credentials or making callers log provider payloads. */
export async function refreshXtreamAccountStatus(
  account: PlaylistEntry,
): Promise<XtreamAccountInfo | null> {
  if (account.source !== 'xtream' || !account.xtream) return null;
  const info = await createXtreamClient({
    baseUrl: account.url,
    username: account.xtream.username,
    password: account.xtream.password,
  }, account.id).getAccountInfo();
  StorageService.setXtreamAccountStatus(account.id, accountStatusSnapshot(info));
  announce(account.id);
  return info;
}
