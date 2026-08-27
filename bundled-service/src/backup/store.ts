export type BackupImportMode = 'merge' | 'replace';

export interface BackupImportRequest {
  id: number;
  archive: unknown;
  groups: string[];
  mode: BackupImportMode;
}

export interface BackupImportStatus {
  id: number;
  status: 'pending' | 'applied' | 'error';
  error?: string;
}

const BACKUP_SCHEMA = 'webos-iptv-player-backup';
const BACKUP_VERSION = 1;
const BACKUP_GROUPS = [
  'favorites',
  'customization',
  'epg',
  'watchlist',
  'preferences',
  'recentlyWatched',
  'playback',
];

function objectValue(value: unknown): { [key: string]: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid backup archive');
  }
  return value as { [key: string]: unknown };
}

function validateArchive(value: unknown): unknown {
  const root = objectValue(value);
  if (root.schema !== BACKUP_SCHEMA || root.version !== BACKUP_VERSION) {
    throw new Error('Unsupported backup version');
  }
  objectValue(root.data);
  return value;
}

function validateGroups(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > BACKUP_GROUPS.length) {
    throw new Error('Select at least one backup data group');
  }
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const group = value[i];
    if (typeof group !== 'string' || BACKUP_GROUPS.indexOf(group) < 0) {
      throw new Error('Invalid backup data group');
    }
    if (result.indexOf(group) < 0) result.push(group);
  }
  return result;
}

export class BackupStore {
  private archive: unknown = null;
  private nextId = 1;
  private pending: BackupImportRequest[] = [];
  private statuses: { [id: string]: BackupImportStatus | undefined } = Object.create(null);

  publish(value: unknown): void {
    this.archive = validateArchive(value);
  }

  export(groups: string[]): unknown {
    if (this.archive === null) throw new Error('Backup is not ready');
    const archive = objectValue(this.archive);
    const data = objectValue(archive.data);
    const selected: { [key: string]: unknown } = {};
    const validGroups = validateGroups(groups);
    for (let i = 0; i < validGroups.length; i++) {
      const group = validGroups[i];
      if (data[group] !== undefined) selected[group] = data[group];
    }
    return {
      schema: archive.schema,
      version: archive.version,
      appVersion: archive.appVersion,
      exportedAt: archive.exportedAt,
      data: selected,
    };
  }

  add(value: unknown): BackupImportRequest {
    const input = objectValue(value);
    const mode = input.mode;
    if (mode !== 'merge' && mode !== 'replace') throw new Error('Invalid import mode');
    const request: BackupImportRequest = {
      id: this.nextId++,
      archive: validateArchive(input.archive),
      groups: validateGroups(input.groups),
      mode,
    };
    this.pending.push(request);
    this.statuses[String(request.id)] = { id: request.id, status: 'pending' };
    return request;
  }

  list(): BackupImportRequest[] {
    return this.pending.slice();
  }

  complete(id: number, error = ''): boolean {
    const index = this.pending.map(item => item.id).indexOf(id);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    this.statuses[String(id)] = error
      ? { id, status: 'error', error: error.slice(0, 500) }
      : { id, status: 'applied' };
    return true;
  }

  status(id: number): BackupImportStatus | null {
    return this.statuses[String(id)] || null;
  }
}
