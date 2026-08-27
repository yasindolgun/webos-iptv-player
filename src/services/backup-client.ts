import { fetchWithTimeout } from '../utils/fetch-helper';
import { createLogger } from '../utils/logger';
import {
  BACKUP_GROUPS,
  BackupService,
  type BackupGroup,
  type BackupImportMode,
} from './backup-service';
import { serviceBase } from './service-http';

const log = createLogger('Backup');
const TIMEOUT = 8000;

interface PendingBackupImport {
  id: number;
  archive: unknown;
  groups: BackupGroup[];
  mode: BackupImportMode;
}

function validGroup(value: unknown): value is BackupGroup {
  return typeof value === 'string' && (BACKUP_GROUPS as readonly string[]).indexOf(value) >= 0;
}

function validRequest(value: unknown): value is PendingBackupImport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<PendingBackupImport>;
  return Number.isSafeInteger(item.id)
    && (item.mode === 'merge' || item.mode === 'replace')
    && Array.isArray(item.groups)
    && item.groups.length > 0
    && item.groups.every(validGroup)
    && item.archive !== undefined;
}

class BackupClientImpl {
  async publishArchive(): Promise<boolean> {
    const base = serviceBase();
    if (!base) return false;
    try {
      const archive = await BackupService.createArchive();
      const response = await fetchWithTimeout(`${base}/backup`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(archive),
      }, TIMEOUT);
      if (!response.ok) log.warn('Backup publish failed: HTTP', response.status);
      return response.ok;
    } catch (error) {
      log.warn('Backup publish failed:', error);
      return false;
    }
  }

  private async complete(id: number, error = ''): Promise<void> {
    const base = serviceBase();
    if (!base) return;
    try {
      const response = await fetchWithTimeout(`${base}/backup-import/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(error ? { error } : {}),
      }, TIMEOUT);
      if (!response.ok) log.warn('Backup import acknowledgement failed: HTTP', response.status);
    } catch (ackError) {
      log.warn('Backup import acknowledgement failed:', ackError);
    }
  }

  async applyPendingImports(): Promise<boolean> {
    const base = serviceBase();
    if (!base) return false;
    let response: Response;
    try {
      response = await fetchWithTimeout(`${base}/backup-import`, {}, TIMEOUT);
    } catch (error) {
      log.warn('Backup import sync failed:', error);
      return false;
    }
    if (!response.ok) {
      log.warn('Backup import sync failed: HTTP', response.status);
      return false;
    }
    const raw = await response.json();
    if (!Array.isArray(raw)) {
      log.warn('Backup import sync returned a non-array response');
      return false;
    }

    let applied = false;
    for (const value of raw) {
      if (!validRequest(value)) {
        log.warn('Ignoring invalid backup import request');
        continue;
      }
      try {
        await BackupService.importArchive(value.archive, value.mode, value.groups);
        await this.complete(value.id);
        applied = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn('Backup import rejected:', message);
        await this.complete(value.id, message);
      }
    }
    if (applied) await this.publishArchive();
    return applied;
  }
}

export const BackupClient = new BackupClientImpl();
