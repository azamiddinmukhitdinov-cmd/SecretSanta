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

const normalizeName = name => name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
const normalizedNameKey = name => normalizeName(name).toLocaleLowerCase('ru');
const validName = name => typeof name === 'string' && name.length >= 1 && name.length <= 60 && !/[\u0000-\u001f\u007f]/u.test(name);
const copyProfile = profile => profile ? { id: profile.id, name: profile.name, role: profile.role, crop: [...profile.crop] } : null;

function readProfiles(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const invalid = () => new Error('Проверьте data/family-profiles.json: нужны уникальные id и имена, роль до 60 символов и crop внутри изображения 1536×1024.');
  let values;
  try { values = JSON.parse(raw); } catch { throw invalid(); }
  if (!Array.isArray(values)) throw invalid();
  const ids = new Set();
  const names = new Set();
  return values.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(value.id)) throw invalid();
    const name = typeof value.name === 'string' ? normalizeName(value.name) : null;
    if (!validName(name) || typeof value.role !== 'string' || value.role.length > 60 || /[\u0000-\u001f\u007f]/u.test(value.role)) throw invalid();
    if (!Array.isArray(value.crop) || value.crop.length !== 4 || !value.crop.every(part => typeof part === 'number' && Number.isFinite(part) && part >= 0)) throw invalid();
    const [x, y, width, height] = value.crop;
    if (width <= 0 || height <= 0 || x + width > 1536 || y + height > 1024) throw invalid();
    const key = normalizedNameKey(name);
    if (ids.has(value.id) || names.has(key)) throw invalid();
    ids.add(value.id);
    names.add(key);
    return { id: value.id, name, role: value.role.trim(), crop: [...value.crop] };
  });
}

export function validateCard(input, { allowDraft = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Проверьте данные карточки.');
  const { name, wishes = '', avoid = '', links = [], ready = !allowDraft } = input;
  if (typeof name !== 'string' || typeof wishes !== 'string' || typeof avoid !== 'string' || typeof ready !== 'boolean') {
    throw new AppError(400, 'Проверьте поля карточки.');
  }
  const cleanName = normalizeName(name);
  if (!validName(cleanName)) throw new AppError(400, 'Укажите имя длиной от 1 до 60 символов.');
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
  const profiles = readProfiles(join(dataDir, 'family-profiles.json'));
  const profileById = new Map(profiles.map(profile => [profile.id, profile]));
  const profileByName = new Map(profiles.map(profile => [normalizedNameKey(profile.name), profile]));
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
      editing_open INTEGER NOT NULL DEFAULT 1,
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
      created_at INTEGER NOT NULL,
      profile_id TEXT
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
    CREATE TABLE IF NOT EXISTS gift_progress (
      participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
      draw_version INTEGER NOT NULL,
      idea INTEGER NOT NULL DEFAULT 0,
      bought INTEGER NOT NULL DEFAULT 0,
      wrapped INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      draw_version INTEGER NOT NULL,
      event_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      read_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS mail_preferences (
      participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      verified_at INTEGER,
      verification_hash TEXT,
      verification_expires INTEGER,
      verification_requested INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mail_jobs (
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      kind TEXT NOT NULL,
      verification_token TEXT,
      notification_id INTEGER UNIQUE REFERENCES notifications(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Existing databases retain every card, credential and assignment. Profiles
  // are optional metadata, so legacy cards remain unbound until explicitly added.
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('PRAGMA table_info(participants)').all().some(column => column.name === 'profile_id')) {
      db.exec('ALTER TABLE participants ADD COLUMN profile_id TEXT');
    }
    // Enable wish updates once for existing games; later organizer choices persist.
    if (db.prepare('PRAGMA user_version').get().user_version < 4) {
      db.exec('UPDATE settings SET editing_open = 1 WHERE id = 1');
    }
    const columns = new Set(db.prepare('PRAGMA table_info(participants)').all().map(column => column.name));
    if (!columns.has('revision')) db.exec('ALTER TABLE participants ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    if (!columns.has('updated_at')) db.exec('ALTER TABLE participants ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS participants_profile_id_unique ON participants(profile_id); PRAGMA user_version = 5; COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  db.prepare("INSERT OR IGNORE INTO credentials(token_hash,kind) VALUES (?, 'admin')").run(hash(access.adminToken));

  const card = row => row ? ({ id: row.id, name: row.name, wishes: row.wishes, avoid: row.avoid, links: JSON.parse(row.links), approved: Boolean(row.approved), ready: Boolean(row.ready), profileId: row.profile_id ?? null, profile: copyProfile(profileById.get(row.profile_id)), revision: row.revision, updatedAt: row.updated_at || row.created_at }) : null;
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const settings = () => db.prepare('SELECT * FROM settings WHERE id = 1').get();
  const participants = () => db.prepare('SELECT * FROM participants ORDER BY created_at, rowid').all().map(card);
  const participant = id => card(db.prepare('SELECT * FROM participants WHERE id = ?').get(id));
  const listProfiles = () => {
    const claimed = new Set(db.prepare('SELECT profile_id FROM participants WHERE profile_id IS NOT NULL').all().map(row => row.profile_id));
    return profiles.map(profile => ({ ...copyProfile(profile), claimed: claimed.has(profile.id) }));
  };
  const requireRegistrationPhase = () => {
    if (settings().phase !== 'registration') throw new AppError(409, 'Сначала отмените жеребьёвку. Прежние назначения станут недействительными.');
  };
  const registrationOpen = now => {
    const s = settings();
    return s.phase === 'registration' && !s.registration_closed && now.getTime() < Date.parse(DEADLINE);
  };
  const createParticipantInTransaction = (input, now, { admin = false } = {}) => {
    requireRegistrationPhase();
    if (!admin && !registrationOpen(now)) throw new AppError(409, 'Приём карточек закрыт. Обратитесь к организатору.');
    if (db.prepare('SELECT COUNT(*) AS total FROM participants').get().total >= 100) throw new AppError(409, 'В игре уже 100 участников. Обратитесь к организатору.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Проверьте данные карточки.');
    let profile = null;
    if (input.profileId != null) {
      if (typeof input.profileId !== 'string') throw new AppError(400, 'Выберите участника на семейном фото.');
      profile = profileById.get(input.profileId);
      if (!profile) throw new AppError(404, 'Этот участник на семейном фото не найден.');
    } else if (!admin && profiles.length) {
      throw new AppError(400, 'Выберите себя на семейном фото.');
    } else if (admin && typeof input.name === 'string') {
      profile = profileByName.get(normalizedNameKey(input.name)) ?? null;
    }
    if (profile && db.prepare('SELECT 1 FROM participants WHERE profile_id = ?').get(profile.id)) {
      throw new AppError(409, 'Карточка этого участника уже создана. Откройте свою личную ссылку или обратитесь к организатору.');
    }
    const value = validateCard(profile ? { ...input, name: profile.name } : input, { allowDraft: admin });
    if (db.prepare('SELECT 1 FROM participants WHERE normalized_name = ?').get(value.normalizedName)) {
      throw new AppError(409, 'Карточка с таким именем уже есть. Откройте свою личную ссылку или уточните имя.');
    }
    const id = randomUUID();
    const personalToken = token();
    db.prepare('INSERT INTO participants(id,name,normalized_name,wishes,avoid,links,approved,ready,created_at,profile_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, value.name, value.normalizedName, value.wishes, value.avoid, JSON.stringify(value.links), admin ? 1 : 0, value.ready ? 1 : 0, now.getTime(), profile?.id ?? null);
    db.prepare("INSERT INTO credentials(token_hash,kind,participant_id) VALUES (?, 'participant', ?)").run(hash(personalToken), id);
    return { participant: participant(id), personalToken };
  };
  const createParticipant = (input, now, options) => transaction(() => createParticipantInTransaction(input, now, options));
  const prepareInvitations = now => transaction(() => {
    requireRegistrationPhase();
    const existing = new Set(participants().map(person => person.profileId));
    const missing = profiles.filter(profile => !existing.has(profile.id));
    if (participants().length + missing.length > 100) throw new AppError(409, 'В игре может быть не больше 100 участников.');
    return missing.map(profile => {
      const result = createParticipantInTransaction({ profileId: profile.id, ready: false }, now, { admin: true });
      return { id: result.participant.id, profileId: profile.id, name: profile.name, personalToken: result.personalToken };
    });
  });
  const editParticipant = (id, input, now) => transaction(() => {
    const current = participant(id);
    if (!current) throw new AppError(403, 'Личный доступ больше не действует. Обратитесь к организатору.');
    if (input.participantId !== id) throw new AppError(409, 'В другой вкладке выполнен вход другого участника. Откройте свою личную ссылку; ваш черновик сохранён отдельно.');
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new AppError(428, 'Обновите страницу перед сохранением карточки.');
    if (input.revision !== current.revision) throw new AppError(409, 'Карточка уже изменена в другой вкладке или на другом устройстве. Ваш черновик сохранён. Сравните его с актуальной карточкой перед сохранением.');
    const s = settings();
    if (!registrationOpen(now) && !s.editing_open) throw new AppError(409, 'Редактирование карточек закрыто. Обратитесь к организатору.');
    if (Object.hasOwn(input, 'profileId') && input.profileId !== current.profileId) throw new AppError(409, 'Нельзя заменить участника в существующей карточке. Обратитесь к организатору.');
    const value = validateCard({ ...current, ...input });
    if (current.profileId && value.name !== current.name) throw new AppError(409, 'Имя участника на семейном фото изменить нельзя. Обратитесь к организатору.');
    if (!current.profileId && value.name !== current.name && profileByName.has(value.normalizedName)) throw new AppError(409, 'Для участника на семейном фото нужно создать отдельную карточку по приглашению.');
    if (!registrationOpen(now) && value.name !== current.name) throw new AppError(409, 'После закрытия приёма можно менять только пожелания и ссылки.');
    const duplicate = db.prepare('SELECT id FROM participants WHERE normalized_name = ? AND id <> ?').get(value.normalizedName, id);
    if (duplicate) throw new AppError(409, 'Карточка с таким именем уже есть. Уточните имя.');
    const approved = value.name === current.name ? (current.approved ? 1 : 0) : 0;
    db.prepare('UPDATE participants SET name=?,normalized_name=?,wishes=?,avoid=?,links=?,ready=?,approved=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
      .run(value.name, value.normalizedName, value.wishes, value.avoid, JSON.stringify(value.links), s.phase === 'drawn' ? 1 : (value.ready ? 1 : 0), approved, now.getTime(), id, current.revision);
    if (s.phase === 'drawn' && (value.wishes !== current.wishes || value.avoid !== current.avoid || JSON.stringify(value.links) !== JSON.stringify(current.links))) {
      const giver = db.prepare('SELECT giver_id FROM assignments WHERE recipient_id=?').get(id);
      if (giver) addNotification(giver.giver_id, 'wishes', `wishes:${id}:${current.revision + 1}`, now);
    }
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
      db.prepare('DELETE FROM gift_progress').run();
      ids.forEach((id, index) => insert.run(id, receivers[index], version));
      db.prepare("UPDATE settings SET phase='drawn', registration_closed=1, draw_version=? WHERE id=1").run(version);
      for (const id of ids) addNotification(id, 'wishes', `draw:${version}:${id}`, now);
      return { ok: true };
    }
    if (action === 'reset') {
      if (input.confirm !== true) throw new AppError(400, 'Подтвердите отмену: прежние назначения перестанут действовать для всех.');
      if (settings().phase !== 'drawn') throw new AppError(409, 'Активной жеребьёвки пока нет.');
      db.prepare('DELETE FROM assignments').run();
      db.prepare('DELETE FROM gift_progress').run();
      db.prepare('DELETE FROM notifications').run();
      db.prepare("UPDATE settings SET phase='registration',draw_version=draw_version+1 WHERE id=1").run();
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
    const { approved: _a, ready: _r, revision: _v, ...result } = card(row);
    return result;
  };

  const workshop = id => {
    if (settings().phase !== 'drawn' || !participant(id)?.approved || !recipient(id)) return null;
    const row = db.prepare('SELECT idea,bought,wrapped FROM gift_progress WHERE participant_id=? AND draw_version=?').get(id, settings().draw_version);
    return { idea: Boolean(row?.idea), bought: Boolean(row?.bought), wrapped: Boolean(row?.wrapped) };
  };
  const updateWorkshop = (id, input, now = new Date()) => transaction(() => {
    const current = workshop(id);
    if (!current) throw new AppError(409, 'Мастерская откроется после жеребьёвки для её участников.');
    const keys = Object.keys(input);
    if (!keys.length || keys.some(key => !['idea', 'bought', 'wrapped'].includes(key) || typeof input[key] !== 'boolean')) {
      throw new AppError(400, 'Отметки мастерской должны быть логическими значениями.');
    }
    const value = { ...current, ...input };
    db.prepare(`INSERT INTO gift_progress(participant_id,draw_version,idea,bought,wrapped) VALUES(?,?,?,?,?)
      ON CONFLICT(participant_id) DO UPDATE SET draw_version=excluded.draw_version,idea=excluded.idea,bought=excluded.bought,wrapped=excluded.wrapped`)
      .run(id, settings().draw_version, Number(value.idea), Number(value.bought), Number(value.wrapped));
    if (value.idea && !current.idea) addNotification(recipient(id).id, 'gift', `gift:${settings().draw_version}:${id}`, now);
    return value;
  });

  const addNotification = (id, kind, key, now) => {
    const result = db.prepare('INSERT OR IGNORE INTO notifications(participant_id,draw_version,event_key,kind,created_at) VALUES(?,?,?,?,?)')
      .run(id, settings().draw_version, key, kind, now.getTime());
    const prefs = mailPreferences(id);
    if (result.changes && prefs.enabled && prefs.verified) {
      if (kind === 'wishes') db.prepare("DELETE FROM mail_jobs WHERE participant_id=? AND kind='wishes' AND sent_at IS NULL").run(id);
      db.prepare('INSERT INTO mail_jobs(id,participant_id,email,kind,notification_id,created_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), id, prefs.email, kind, Number(result.lastInsertRowid), now.getTime());
    }
  };
  const notifications = id => db.prepare('SELECT id,kind,created_at AS createdAt,read_at AS readAt FROM notifications WHERE participant_id=? AND draw_version=? ORDER BY id DESC LIMIT 50').all(id, settings().draw_version);
  const readNotifications = (id, now) => db.prepare('UPDATE notifications SET read_at=? WHERE participant_id=? AND read_at IS NULL').run(now.getTime(), id);

  const mailPreferences = id => {
    const row = db.prepare('SELECT email,enabled,verified_at FROM mail_preferences WHERE participant_id=?').get(id);
    const delivery = db.prepare('SELECT COUNT(*) AS pending,SUM(CASE WHEN attempts>=5 THEN 1 ELSE 0 END) AS failed FROM mail_jobs WHERE participant_id=? AND sent_at IS NULL').get(id);
    return { email: row?.email || '', enabled: Boolean(row?.enabled), verified: Boolean(row?.verified_at), deliveryPending: delivery.pending, deliveryFailed: delivery.failed || 0 };
  };
  const requestVerification = (id, now) => {
    const row = db.prepare('SELECT * FROM mail_preferences WHERE participant_id=?').get(id);
    if (!row?.enabled || row.verified_at || now.getTime() - row.verification_requested < 600000) return false;
    const secret = token();
    db.prepare("DELETE FROM mail_jobs WHERE participant_id=? AND kind='verify' AND sent_at IS NULL").run(id);
    db.prepare('UPDATE mail_preferences SET verification_hash=?,verification_expires=?,verification_requested=? WHERE participant_id=?')
      .run(hash(secret), now.getTime() + 86400000, now.getTime(), id);
    db.prepare("INSERT INTO mail_jobs(id,participant_id,email,kind,verification_token,created_at) VALUES(?,?,?,'verify',?,?)")
      .run(randomUUID(), id, row.email, secret, now.getTime());
    return true;
  };
  const setMailPreferences = (id, input, now, configured) => transaction(() => {
    if (typeof input.email !== 'string' || typeof input.enabled !== 'boolean') throw new AppError(400, 'Укажите почту и согласие на уведомления.');
    const email = input.email.trim().toLowerCase();
    if (email && (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email))) throw new AppError(400, 'Проверьте адрес электронной почты.');
    if (input.enabled && !email) throw new AppError(400, 'Для уведомлений нужен адрес почты.');
    const current = mailPreferences(id);
    if (current.email !== email) {
      db.prepare('DELETE FROM mail_jobs WHERE participant_id=? AND sent_at IS NULL').run(id);
      db.prepare('DELETE FROM mail_preferences WHERE participant_id=?').run(id);
    }
    db.prepare('INSERT INTO mail_preferences(participant_id,email,enabled) VALUES(?,?,?) ON CONFLICT(participant_id) DO UPDATE SET enabled=excluded.enabled')
      .run(id, email, Number(input.enabled));
    if (!input.enabled) db.prepare('DELETE FROM mail_jobs WHERE participant_id=? AND sent_at IS NULL').run(id);
    if (configured && input.enabled) requestVerification(id, now);
    return mailPreferences(id);
  });
  const verifyMail = (secret, now) => transaction(() => {
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new AppError(400, 'Ссылка подтверждения недействительна.');
    const row = db.prepare('SELECT participant_id FROM mail_preferences WHERE verification_hash=? AND verification_expires>? AND enabled=1').get(hash(secret), now.getTime());
    if (!row) throw new AppError(400, 'Ссылка устарела или почта уже подтверждена. Запросите новое письмо в личной карточке.');
    db.prepare('UPDATE mail_preferences SET verified_at=?,verification_hash=NULL,verification_expires=NULL WHERE participant_id=?').run(now.getTime(), row.participant_id);
    return { ok: true };
  });
  const queueVerifications = now => transaction(() => {
    for (const row of db.prepare('SELECT participant_id FROM mail_preferences WHERE enabled=1 AND verified_at IS NULL').all()) requestVerification(row.participant_id, now);
  });
  const pendingMail = now => db.prepare(`SELECT j.* FROM mail_jobs j JOIN mail_preferences p ON p.participant_id=j.participant_id AND p.email=j.email
    WHERE j.sent_at IS NULL AND j.attempts<5 AND j.next_attempt<=? AND p.enabled=1
    AND ((j.kind='verify' AND p.verified_at IS NULL AND p.verification_expires>?) OR (j.kind<>'verify' AND p.verified_at IS NOT NULL))
    ORDER BY j.created_at LIMIT 10`).all(now.getTime(), now.getTime());
  const finishMail = (id, now, success) => {
    if (success) db.prepare('UPDATE mail_jobs SET sent_at=?,verification_token=NULL WHERE id=?').run(now.getTime(), id);
    else db.prepare('UPDATE mail_jobs SET attempts=attempts+1,next_attempt=? WHERE id=?').run(now.getTime() + 300000, id);
  };

  return { db, dataDir, access, settings, participants, participant, listProfiles, registrationOpen, credential, assignments, recipient, createParticipant, prepareInvitations, editParticipant, adminAction, workshop, updateWorkshop, notifications, readNotifications, mailPreferences, setMailPreferences, verifyMail, queueVerifications, pendingMail, finishMail, close: () => db.close() };
}
