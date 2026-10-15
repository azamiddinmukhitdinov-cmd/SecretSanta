import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

export const DEADLINE = '2026-12-25T19:00:00.000Z';
export const EXCHANGE_DATE = '2027-01-01';
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value) => createHash('sha256').update(value).digest('hex');

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function validateCard(input, { allowDraft = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Проверьте данные карточки.');
  const { name, wishes = '', avoid = '', links = [], ready = !allowDraft } = input;
  if (typeof name !== 'string' || typeof wishes !== 'string' || typeof avoid !== 'string' || typeof ready !== 'boolean') {
    throw new AppError(400, 'Проверьте поля карточки.');
  }
  const cleanName = name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!cleanName || cleanName.length > 60 || /[\u0000-\u001f\u007f]/u.test(cleanName)) throw new AppError(400, 'Укажите имя длиной от 1 до 60 символов.');
  if (wishes.length > 2000 || avoid.length > 1000) throw new AppError(400, 'Пожелания — до 2000 символов, нежелательные подарки — до 1000.');
  if (!Array.isArray(links) || links.length > 5) throw new AppError(400, 'Можно добавить до пяти ссылок на подарки.');
  const cleanLinks = links.map((link) => {
    if (typeof link !== 'string' || link.length > 2000) throw new AppError(400, 'Проверьте ссылки на подарки.');
    let url;
    try { url = new URL(link.trim()); } catch { throw new AppError(400, 'Ссылки должны начинаться с https:// или http://.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new AppError(400, 'Разрешены только обычные ссылки http:// и https://.');
    return url.href;
  });
  return { name: cleanName, normalizedName: cleanName.toLocaleLowerCase('ru'), wishes: wishes.trim(), avoid: avoid.trim(), links: cleanLinks, ready };
}

// Uniformly sample permutations, rejecting self-assignments. Unlike a single
// forced cycle this also allows reciprocal gifts, as agreed for this family.
export function drawRecipients(ids) {
  if (ids.length < 2 || new Set(ids).size !== ids.length) throw new AppError(409, 'Для жеребьёвки нужны хотя бы два разных участника.');
  let receivers;
  do {
    receivers = [...ids];
    for (let i = receivers.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [receivers[i], receivers[j]] = [receivers[j], receivers[i]];
    }
  } while (receivers.some((id, index) => id === ids[index]));
  return receivers;
}

export function createStore(directory) {
  const dataDir = resolve(directory);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const databasePath = join(dataDir, 'santa.sqlite');
  const accessPath = join(dataDir, 'access.json');
  if (!existsSync(accessPath)) {
    if (existsSync(databasePath)) throw new Error('Не найден data/access.json. Восстановите его из резервной копии вместе с базой.');
    writeFileSync(accessPath, JSON.stringify({ adminToken: token(), inviteToken: token() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  chmodSync(accessPath, 0o600);
  const access = JSON.parse(readFileSync(accessPath, 'utf8'));
  if (![access.adminToken, access.inviteToken].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value))) {
    throw new Error('Повреждён файл доступа. Восстановите data/access.json из резервной копии.');
  }
  const db = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      phase TEXT NOT NULL DEFAULT 'registration' CHECK(phase IN ('registration', 'drawn')),
      registration_closed INTEGER NOT NULL DEFAULT 0,
      editing_open INTEGER NOT NULL DEFAULT 0,
      draw_version INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO settings(id) VALUES (1);
    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      wishes TEXT NOT NULL DEFAULT '',
      avoid TEXT NOT NULL DEFAULT '',
      links TEXT NOT NULL DEFAULT '[]',
      approved INTEGER NOT NULL DEFAULT 0,
      ready INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credentials (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('admin', 'participant')),
      participant_id TEXT UNIQUE REFERENCES participants(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS assignments (
      giver_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
      draw_version INTEGER NOT NULL,
      CHECK(giver_id <> recipient_id)
    );
    PRAGMA user_version = 1;
  `);
  db.prepare("INSERT OR IGNORE INTO credentials(token_hash,kind) VALUES (?, 'admin')").run(hash(access.adminToken));

  const card = row => row ? ({ id: row.id, name: row.name, wishes: row.wishes, avoid: row.avoid, links: JSON.parse(row.links), approved: Boolean(row.approved), ready: Boolean(row.ready) }) : null;
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const settings = () => db.prepare('SELECT * FROM settings WHERE id = 1').get();
  const participants = () => db.prepare('SELECT * FROM participants ORDER BY created_at, rowid').all().map(card);
  const participant = id => card(db.prepare('SELECT * FROM participants WHERE id = ?').get(id));
  const requireRegistrationPhase = () => {
    if (settings().phase !== 'registration') throw new AppError(409, 'Сначала отмените жеребьёвку. Прежние назначения станут недействительными.');
  };
  const registrationOpen = now => {
    const s = settings();
    return s.phase === 'registration' && !s.registration_closed && now.getTime() < Date.parse(DEADLINE);
  };
  const createParticipant = (input, now, { admin = false } = {}) => transaction(() => {
    requireRegistrationPhase();
    if (!admin && !registrationOpen(now)) throw new AppError(409, 'Приём карточек закрыт. Обратитесь к организатору.');
    if (db.prepare('SELECT COUNT(*) AS total FROM participants').get().total >= 100) throw new AppError(409, 'В игре уже 100 участников. Обратитесь к организатору.');
    const value = validateCard(input, { allowDraft: admin });
    if (db.prepare('SELECT 1 FROM participants WHERE normalized_name = ?').get(value.normalizedName)) {
      throw new AppError(409, 'Карточка с таким именем уже есть. Откройте свою личную ссылку или уточните имя.');
    }
    const id = randomUUID();
    const personalToken = token();
    db.prepare('INSERT INTO participants(id,name,normalized_name,wishes,avoid,links,approved,ready,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, value.name, value.normalizedName, value.wishes, value.avoid, JSON.stringify(value.links), admin ? 1 : 0, value.ready ? 1 : 0, now.getTime());
    db.prepare("INSERT INTO credentials(token_hash,kind,participant_id) VALUES (?, 'participant', ?)").run(hash(personalToken), id);
    return { participant: participant(id), personalToken };
  });
  const editParticipant = (id, input, now) => transaction(() => {
    const current = participant(id);
    if (!current) throw new AppError(403, 'Личный доступ больше не действует. Обратитесь к организатору.');
    const s = settings();
    if (!registrationOpen(now) && !s.editing_open) throw new AppError(409, 'Редактирование карточек закрыто. Обратитесь к организатору.');
    const value = validateCard({ ...current, ...input });
    if (s.phase === 'drawn' && value.name !== current.name) throw new AppError(409, 'После жеребьёвки можно менять только пожелания и ссылки.');
    const duplicate = db.prepare('SELECT id FROM participants WHERE normalized_name = ? AND id <> ?').get(value.normalizedName, id);
    if (duplicate) throw new AppError(409, 'Карточка с таким именем уже есть. Уточните имя.');
    const approved = value.name === current.name ? (current.approved ? 1 : 0) : 0;
    db.prepare('UPDATE participants SET name=?,normalized_name=?,wishes=?,avoid=?,links=?,ready=?,approved=? WHERE id=?')
      .run(value.name, value.normalizedName, value.wishes, value.avoid, JSON.stringify(value.links), s.phase === 'drawn' ? 1 : (value.ready ? 1 : 0), approved, id);
    return participant(id);
  });
  const adminAction = (input, now) => transaction(() => {
    const action = input?.action;
    if (['approve', 'remove', 'rotate-personal'].includes(action)) {
      if (typeof input.id !== 'string' || !participant(input.id)) throw new AppError(404, 'Участник не найден.');
      if (action !== 'rotate-personal') requireRegistrationPhase();
      if (action === 'approve') db.prepare('UPDATE participants SET approved = 1 WHERE id = ?').run(input.id);
      if (action === 'remove') db.prepare('DELETE FROM participants WHERE id = ?').run(input.id);
      if (action === 'rotate-personal') {
        const personalToken = token();
        db.prepare("DELETE FROM credentials WHERE participant_id = ? AND kind = 'participant'").run(input.id);
        db.prepare("INSERT INTO credentials(token_hash,kind,participant_id) VALUES (?, 'participant', ?)").run(hash(personalToken), input.id);
        return { personalToken };
      }
      return { ok: true };
    }
    if (action === 'draw') {
      requireRegistrationPhase();
      const people = participants();
      if (people.length < 2) throw new AppError(409, 'Для жеребьёвки нужны хотя бы два участника.');
      if (people.some(p => !p.approved || !p.ready)) throw new AppError(409, 'Сначала подтвердите всех участников и дождитесь заполнения карточек.');
      const ids = people.map(p => p.id);
      const receivers = drawRecipients(ids);
      const version = settings().draw_version + 1;
      const insert = db.prepare('INSERT INTO assignments(giver_id,recipient_id,draw_version) VALUES (?,?,?)');
      ids.forEach((id, index) => insert.run(id, receivers[index], version));
      db.prepare("UPDATE settings SET phase='drawn', registration_closed=1, editing_open=0, draw_version=? WHERE id=1").run(version);
      return { ok: true };
    }
    if (action === 'reset') {
      if (input.confirm !== true) throw new AppError(400, 'Подтвердите отмену: прежние назначения перестанут действовать для всех.');
      if (settings().phase !== 'drawn') throw new AppError(409, 'Активной жеребьёвки пока нет.');
      db.prepare('DELETE FROM assignments').run();
      db.prepare("UPDATE settings SET phase='registration',editing_open=0,draw_version=draw_version+1 WHERE id=1").run();
      return { ok: true };
    }
    if (action === 'set-editing') {
      if (typeof input.enabled !== 'boolean') throw new AppError(400, 'Укажите, открывать ли редактирование.');
      db.prepare('UPDATE settings SET editing_open=? WHERE id=1').run(input.enabled ? 1 : 0);
      return { ok: true };
    }
    if (action === 'close-registration') {
      db.prepare('UPDATE settings SET registration_closed=1 WHERE id=1').run();
      return { ok: true };
    }
    if (action === 'open-registration') {
      requireRegistrationPhase();
      if (now.getTime() >= Date.parse(DEADLINE)) throw new AppError(409, 'Срок приёма карточек закончился 25 декабря по Ташкенту. Можно отдельно открыть редактирование пожеланий.');
      db.prepare('UPDATE settings SET registration_closed=0 WHERE id=1').run();
      return { ok: true };
    }
    throw new AppError(400, 'Неизвестное действие организатора.');
  });
  const credential = value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    return db.prepare('SELECT kind,participant_id FROM credentials WHERE token_hash=?').get(hash(value)) ?? null;
  };
  const assignments = () => db.prepare(`SELECT a.giver_id AS giverId,g.name AS giverName,a.recipient_id AS recipientId,r.name AS recipientName
    FROM assignments a JOIN participants g ON g.id=a.giver_id JOIN participants r ON r.id=a.recipient_id ORDER BY g.created_at,g.rowid`).all();
  const recipient = id => {
    const row = db.prepare('SELECT p.* FROM assignments a JOIN participants p ON p.id=a.recipient_id WHERE a.giver_id=?').get(id);
    if (!row) return null;
    const { approved: _a, ready: _r, ...result } = card(row);
    return result;
  };

  return { db, dataDir, access, settings, participants, participant, registrationOpen, credential, assignments, recipient, createParticipant, editParticipant, adminAction, close: () => db.close() };
}
