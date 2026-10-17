import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { createStore, hash, AppError, DEADLINE, EXCHANGE_DATE, DRAW_DATE, DRAW_AT } from './store.mjs';
import { createMail } from './mail.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const cookieNames = { invite: 'santa_invite', personal: 'santa_personal', admin: 'santa_admin' };
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const equalToken = (a, b) => typeof a === 'string' && TOKEN_PATTERN.test(a) && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));

export function validateAppUrl(value, production = false) {
  if (!value) {
    if (production) throw new Error('Для production укажите APP_URL с публичным HTTPS-адресом сайта.');
    return null;
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('APP_URL должен быть полным адресом сайта.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || (production && url.protocol !== 'https:')) {
    throw new Error('APP_URL должен содержать только origin сайта; production требует https://.');
  }
  return url.origin;
}

export async function createApp({ dataDir = './data', clock = () => new Date(), rateLimit = true, appUrl, production = false, transportFactory } = {}) {
  const configuredOrigin = validateAppUrl(appUrl, production);
  const store = createStore(dataDir);
  let mail;
  try { mail = await createMail(store, { appUrl: configuredOrigin, clock, transportFactory }); }
  catch (error) { store.close(); throw error; }
  const mailTimer = setInterval(() => { mail.flush().catch(() => {}); }, 60000);
  mailTimer.unref();
  const limits = new Map();
  let requestsSinceCleanup = 0;
  const cookie = (name, value, maxAge = 31536000) => `${name}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${configuredOrigin?.startsWith('https:') ? '; Secure' : ''}`;
  const cookies = request => Object.fromEntries((request.headers.cookie ?? '').split(';').map(piece => piece.trim().split('=')).filter(parts => parts.length === 2));
  const auth = request => {
    const values = cookies(request);
    const admin = store.credential(values.santa_admin);
    const personal = store.credential(values.santa_personal);
    return { admin: admin?.kind === 'admin', participantId: personal?.kind === 'participant' ? personal.participant_id : null, invited: equalToken(values.santa_invite, store.access.inviteToken) };
  };
  const requireAdmin = value => { if (!value.admin) throw new AppError(403, 'Это действие доступно только организатору.'); };
  const requestOrigin = request => {
    if (configuredOrigin) return configuredOrigin;
    let url;
    try { url = new URL(`http://${request.headers.host}`); } catch { throw new AppError(400, 'Некорректный адрес запроса.'); }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new AppError(421, 'Для доступа по внешнему адресу настройте APP_URL.');
    return url.origin;
  };
  const guardOrigin = (request, origin) => {
    if (request.headers.origin !== origin) throw new AppError(403, 'Запрос с другого сайта отклонён. Обновите страницу и повторите действие.');
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'Откройте страницу игры перед выполнением действия.');
  };
  const rateGuard = request => {
    if (!rateLimit) return;
    const ip = request.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const windowStart = Math.floor(now / 60000);
    const path = request.url?.split('?')[0];
    const sensitive = request.method === 'POST' && ['/api/participants', '/api/access'].includes(path);
    const key = `${ip}:${sensitive ? 'access' : 'api'}`;
    const entry = limits.get(key);
    const count = entry?.windowStart === windowStart ? entry.count + 1 : 1;
    limits.set(key, { windowStart, count });
    if (++requestsSinceCleanup % 100 === 0) for (const [k, value] of limits) if (value.windowStart < windowStart) limits.delete(k);
    if (count > (sensitive ? 30 : 180)) throw new AppError(429, 'Слишком много запросов. Попробуйте снова через минуту.');
  };
  const readJson = request => new Promise((resolve, reject) => {
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
      request.resume();
      reject(new AppError(415, 'Ожидается запрос JSON.'));
      return;
    }
    const chunks = [];
    let size = 0;
    let exceeded = false;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 32768) { exceeded = true; chunks.length = 0; }
      else if (!exceeded) chunks.push(chunk);
    });
    request.on('end', () => {
      if (exceeded) return reject(new AppError(413, 'Карточка слишком большая. Сократите текст или ссылки.'));
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { reject(new AppError(400, 'Не удалось прочитать данные. Проверьте карточку и попробуйте ещё раз.')); }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new AppError(400, 'Запрос прерван.')));
  });
  const send = (response, status, value, headers = {}) => {
    const body = JSON.stringify(value);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    response.end(body);
  };
  const makeState = (authentication, origin) => {
    const now = clock();
    const s = store.settings();
    const participant = authentication.participantId ? store.participant(authentication.participantId) : null;
    const access = authentication.admin ? 'organizer' : participant ? 'participant' : authentication.invited ? 'invited' : 'locked';
    const people = store.participants();
    const profiles = store.listProfiles();
    const result = {
      game: { title: 'Семейный Тайный Санта — 2027', budgetMin: 50, budgetMax: 100, currency: 'USD', deadline: DEADLINE, exchangeDate: EXCHANGE_DATE, timezone: 'Asia/Tashkent', phase: s.phase, registrationOpen: store.registrationOpen(now), editingOpen: Boolean(s.editing_open), drawVersion: s.draw_version, participantCount: store.participants().length },
      access, participant, recipient: participant?.approved && s.phase === 'drawn' ? store.recipient(participant.id) : null,
      profiles: access === 'locked' ? [] : store.listProfiles(),
    };
    result.game.exchangeAt = '2027-01-01T00:00:00+05:00';
    result.game.drawDate = DRAW_DATE;
    result.game.drawAt = DRAW_AT;
    result.game.drawAvailable = now.getTime() >= Date.parse(DRAW_AT);
    if (access !== 'locked') result.game.readiness = {
      ready: people.filter(person => person.ready).length,
      total: profiles.length + people.filter(person => !person.profileId).length,
    };
    if (participant) result.workshop = store.workshop(participant.id);
    if (participant) result.notifications = store.notifications(participant.id);
    if (participant) result.email = { ...store.mailPreferences(participant.id), deliveryConfigured: mail.status().configured };
    if (authentication.admin) result.admin = { participants: store.participants(), assignments: store.assignments(), invitationUrl: `${origin}/#invite=${store.access.inviteToken}` };
    if (authentication.admin) result.admin.mail = mail.status();
    return result;
  };

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store, private');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (configuredOrigin?.startsWith('https:')) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const path = (request.url ?? '/').split('?')[0];
      if (path === '/healthz' && ['GET', 'HEAD'].includes(request.method)) return send(response, 200, { ok: true });
      const origin = requestOrigin(request);
      if (path.startsWith('/api/')) {
        rateGuard(request);
        const authentication = auth(request);
        if (request.method === 'GET' && path === '/api/state') return send(response, 200, makeState(authentication, origin));
        if (request.method === 'GET' && path === '/api/photo') {
          if (!authentication.admin && !authentication.participantId && !authentication.invited) throw new AppError(403, 'Фото доступно участникам семейной игры.');
          try {
            const photo = join(store.dataDir, 'family-portrait.png');
            const file = await readFile(photo);
            response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': file.length });
            return response.end(file);
          } catch (error) {
            if (error.code === 'ENOENT') throw new AppError(404, 'Семейное фото пока не добавлено.');
            throw error;
          }
        }
        if (!['POST', 'PATCH'].includes(request.method)) throw new AppError(404, 'Страница не найдена.');
        guardOrigin(request, origin);
        const input = await readJson(request);
        if (request.method === 'POST' && path === '/api/access') {
          const { type, token: value } = input;
          if (!Object.hasOwn(cookieNames, type) || typeof value !== 'string' || !TOKEN_PATTERN.test(value)) throw new AppError(403, 'Ссылка недействительна. Проверьте приглашение или обратитесь к организатору.');
          const credential = store.credential(value);
          const valid = type === 'invite' ? equalToken(value, store.access.inviteToken) : type === 'admin' ? credential?.kind === 'admin' : credential?.kind === 'participant';
          if (!valid) throw new AppError(403, 'Ссылка недействительна или была заменена. Обратитесь к организатору.');
          return send(response, 200, { ok: true }, { 'Set-Cookie': cookie(cookieNames[type], value, type === 'admin' ? 2592000 : 31536000) });
        }
        if (request.method === 'POST' && path === '/api/logout') return send(response, 200, { ok: true }, { 'Set-Cookie': Object.values(cookieNames).map(name => cookie(name, '', 0)) });
        if (request.method === 'POST' && path === '/api/email/verify') return send(response, 200, store.verifyMail(input.token, clock()));
        if (request.method === 'POST' && path === '/api/email') {
          if (!authentication.participantId) throw new AppError(403, 'Откройте свою личную ссылку.');
          if (input.participantId !== authentication.participantId) throw new AppError(409, 'Откройте личную ссылку нужного участника.');
          const email = store.setMailPreferences(authentication.participantId, input, clock(), mail.status().configured);
          return send(response, 200, { email });
        }
        if (request.method === 'POST' && path === '/api/admin/mail') {
          requireAdmin(authentication);
          if (!configuredOrigin) throw new AppError(400, 'Сначала настройте публичный HTTPS-адрес сайта.');
          return send(response, 200, { mail: await mail.save(input) });
        }
        if (request.method === 'POST' && path === '/api/participants') {
          if (!authentication.admin && !authentication.invited) throw new AppError(403, 'Сначала откройте общее приглашение из семейной группы.');
          if (authentication.participantId) throw new AppError(409, 'У вас уже есть карточка. Отредактируйте её вместо создания новой.');
          const result = store.createParticipant(input, clock());
          return send(response, 201, { personalUrl: `${origin}/#personal=${result.personalToken}` }, { 'Set-Cookie': cookie(cookieNames.personal, result.personalToken) });
        }
        if (request.method === 'PATCH' && path === '/api/me') {
          if (!authentication.participantId) throw new AppError(403, 'Откройте свою личную ссылку для редактирования карточки.');
          store.editParticipant(authentication.participantId, input, clock());
          return send(response, 200, { ok: true });
        }
        if (request.method === 'PATCH' && path === '/api/workshop') {
          if (!authentication.participantId) throw new AppError(403, 'Откройте свою личную ссылку.');
          return send(response, 200, { workshop: store.updateWorkshop(authentication.participantId, input, clock()) });
        }
        if (request.method === 'POST' && path === '/api/notifications/read') {
          if (!authentication.participantId) throw new AppError(403, 'Откройте свою личную ссылку.');
          store.readNotifications(authentication.participantId, clock());
          return send(response, 200, { ok: true });
        }
        if (request.method === 'POST' && path === '/api/admin/invitations') {
          requireAdmin(authentication);
          const invitations = store.prepareInvitations(clock()).map(({ personalToken, ...person }) => ({
            ...person, personalUrl: `${origin}/#personal=${personalToken}`,
          }));
          return send(response, 200, { invitations });
        }
        if (request.method === 'POST' && path === '/api/admin/participants') {
          requireAdmin(authentication);
          const result = store.createParticipant(input, clock(), { admin: true });
          return send(response, 201, { personalUrl: `${origin}/#personal=${result.personalToken}` });
        }
        if (request.method === 'POST' && path === '/api/admin/action') {
          requireAdmin(authentication);
          const result = store.adminAction(input, clock());
          if (result.personalToken) return send(response, 200, { personalUrl: `${origin}/#personal=${result.personalToken}` });
          return send(response, 200, result);
        }
        throw new AppError(404, 'Страница не найдена.');
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw new AppError(405, 'Метод не поддерживается.');
      if (path === '/robots.txt') {
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return response.end('User-agent: *\nDisallow: /\n');
      }
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/winter-scene.webp': ['winter-scene.webp', 'image/webp'] };
      if (!Object.hasOwn(files, path)) throw new AppError(404, 'Страница не найдена.');
      const [name, contentType] = files[path];
      const body = await readFile(join(publicDir, name));
      response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      const status = error instanceof AppError ? error.status : 500;
      if (status === 429) response.setHeader('Retry-After', '60');
      if (status === 500) console.error('Ошибка сервера:', error.code ?? error.name);
      send(response, status, { error: status === 500 ? 'Не удалось выполнить действие. Попробуйте ещё раз.' : error.message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return { server, store, mail, access: { ...store.access }, close: async () => { clearInterval(mailTimer); if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await mail.close(); store.close(); } };
}
