import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.mjs';
import { createBackups, WEEK } from '../src/backups.mjs';

test('weekly online backups restore committed WAL data and access, skip early runs and catch up after downtime', async t => {
  const root = await mkdtemp(join(tmpdir(), 'santa-backup-test-'));
  const store = createStore(join(root, 'data'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  let now = new Date('2026-12-01T00:00:00Z');
  const manager = createBackups(store, { directory: join(root, 'weekly'), clock: () => now });
  const a = store.createParticipant({ name: 'А', wishes: 'Книга', ready: true }, now, { admin: true });
  store.createParticipant({ name: 'Б', ready: true }, now, { admin: true });
  store.adminAction({ action: 'draw' }, now);
  const before = store.assignments();
  const first = await manager.check();
  assert.equal(first.created, true);
  const restored = createStore(first.directory);
  try {
    assert.deepEqual(restored.assignments(), before);
    assert.equal(restored.participant(a.participant.id).wishes, 'Книга');
    assert.deepEqual(restored.access, store.access);
    assert.ok(restored.credential(a.personalToken));
  } finally { restored.close(); }
  const manifest = JSON.parse(await readFile(join(first.directory, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files['santa.sqlite'] && manifest.files['access.json']);
  now = new Date(now.getTime() + WEEK - 1);
  assert.equal((await manager.check()).created, false);
  now = new Date(now.getTime() + WEEK);
  const restarted = createBackups(store, { directory: manager.directory, clock: () => now });
  assert.equal((await restarted.check()).created, true);
  const db = new DatabaseSync(join(first.directory, 'santa.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); } finally { db.close(); }
});
