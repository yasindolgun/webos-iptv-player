import { rmSync } from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
if (!target) throw new Error('Usage: node scripts/clean-dir.mjs <directory>');

const resolved = path.resolve(target);
const root = path.resolve('build');
if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
  throw new Error(`Refusing to clean outside build: ${resolved}`);
}
rmSync(resolved, { recursive: true, force: true });
