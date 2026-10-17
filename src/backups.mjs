import { backup, DatabaseSync } from 'node:sqlite';
import { mkdir, readdir, readFile, copyFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const WEEK = 7 * 24 * 60 * 60 * 1000;

export function createBackups(store, { directory = resolve(store.dataDir, '../backups/weekly'), clock = () => new Date() } = {}) {
  const root = resolve(directory);
  let running = null;
  const run = async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    let latest = 0;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('backup-')) continue;
      try {
        const manifest = JSON.parse(await readFile(join(root, entry.name, 'manifest.json'), 'utf8'));
        if (manifest.complete && Number.isFinite(Date.parse(manifest.createdAt))) latest = Math.max(latest, Date.parse(manifest.createdAt));
      } catch { /* Incomplete copies never postpone the next backup. */ }
    }
    const now = clock();
    if (latest && now.getTime() - latest < WEEK) return { created: false, latest: new Date(latest).toISOString() };
    const name = `backup-${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const staging = resolve(root, `.incomplete-${randomUUID()}`);
    if (!staging.startsWith(root + sep)) throw new Error('Invalid backup destination');
    await mkdir(staging, { mode: 0o700 });
    try {
      // SQLite's online backup includes committed WAL data while the site stays up.
      await backup(store.db, join(staging, 'santa.sqlite'));
      const check = new DatabaseSync(join(staging, 'santa.sqlite'), { readOnly: true });
      try { if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Backup integrity check failed'); }
      finally { check.close(); }
      for (const entry of await readdir(store.dataDir, { withFileTypes: true })) {
        if (entry.isFile() && !entry.name.startsWith('santa.sqlite') && !entry.name.endsWith('.log') && !entry.name.endsWith('.tmp')) {
          await copyFile(join(store.dataDir, entry.name), join(staging, entry.name));
        }
      }
      const files = {};
      for (const file of await readdir(staging)) files[file] = createHash('sha256').update(await readFile(join(staging, file))).digest('hex');
      await writeFile(join(staging, 'manifest.json'), JSON.stringify({ complete: true, createdAt: now.toISOString(), files }, null, 2), { mode: 0o600 });
      await rename(staging, join(root, name));
      return { created: true, latest: now.toISOString(), directory: join(root, name) };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  };
  return { directory: root, check() { if (!running) running = run().finally(() => { running = null; }); return running; } };
}
