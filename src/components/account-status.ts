import type { XtreamAccountStatusSnapshot } from '../types';
import { t } from '../i18n';
import { formatLocalDateTime, formatUtcDate } from '../utils/time';

export interface AccountStatusDisplay {
  summary: string;
  checked: string;
  tone: 'ok' | 'warn' | 'err';
}

export function accountStatusDisplay(
  status: XtreamAccountStatusSnapshot,
): AccountStatusDisplay {
  const checked = t('accountStatus.checked', {
    time: formatLocalDateTime(new Date(status.checkedAt)),
  });
  if (status.state === 'unreachable') {
    return { summary: t('accountStatus.unreachable'), checked, tone: 'err' };
  }
  const state = status.state === 'active'
    ? t('settings.active')
    : t(status.state === 'expired' ? 'accountStatus.expired' : 'accountStatus.disabled');
  const expiry = status.expiresAt === null
    ? t('settings.neverExpires')
    : t('settings.expires', {
      date: formatUtcDate(new Date(status.expiresAt * 1000)),
    });
  const connections = status.maxConnections > 0
    ? t('settings.connections', {
      active: status.activeConnections,
      max: status.maxConnections,
    })
    : t('accountStatus.unlimitedConnections', { active: status.activeConnections });
  return {
    summary: `${state} · ${expiry} · ${connections}`,
    checked,
    tone: status.state === 'active' ? 'ok' : 'warn',
  };
}
