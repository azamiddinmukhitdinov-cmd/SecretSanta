import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.mjs';

const BEFORE_DEADLINE = '2026-12-01T12:00:00.000Z';
const SYNTHETIC_PROFILES = [
  { id: 'test-person-a', name: 'Тестовый участник А', role: 'Тестовая роль А', crop: [0, 0, 128, 128] },
  { id: 'test-person-b', name: 'Тестовый участник Б', role: 'Тестовая роль Б', crop: [256, 0, 128, 128] },
  { id: 'test-person-c', name: 'Тестовый участник В', role: 'Тестовая роль В', crop: [512, 0, 128, 128] },
];

function expectStatus(result, status) {
  assert.equal(result.status, status, JSON.stringify(result.data));
  return result.data;
}

function personalToken(personalUrl) {
  const token = new URLSearchParams(new URL(personalUrl).hash.slice(1)).get('personal');
  assert.ok(token, 'The personal URL must contain an access token');
  return token;
}

function card(name, extra = {}) {
  return { name, wishes: `Пожелания: ${name}`, avoid: 'Без сладостей', links: [], ready: true, ...extra };
}

async function fixture(t, initialTime = BEFORE_DEADLINE, { profiles, beforeStart } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'secret-santa-test-'));
  let now = new Date(initialTime);
  let active;
  const f = { origin: '', access: null, dataDir };

  async function stop() {
    if (!active) return;
    const previous = active;
    active = null;
    await previous.close();
  }

  async function start() {
    active = await createApp({ dataDir, clock: () => new Date(now), rateLimit: false });
    await new Promise((resolve, reject) => {
      active.server.once('error', reject);
      active.server.listen(0, '127.0.0.1', () => {
        active.server.off('error', reject);
        resolve();
      });
    });
    f.origin = `http://127.0.0.1:${active.server.address().port}`;
    f.access = active.access;
  }

  t.after(async () => {
    try {
      await stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  f.client = () => {
    const jar = new Map();
    return {
      async request(path, { method = 'GET', body, origin = f.origin } = {}) {
        const headers = {};
        if (jar.size) headers.Cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
        if (method !== 'GET' && method !== 'HEAD') headers.Origin = origin;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetch(`${f.origin}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
        });
        const cookies = response.headers.getSetCookie();
        for (const cookie of cookies) {
          const pair = cookie.split(';', 1)[0];
          const index = pair.indexOf('=');
          const key = pair.slice(0, index);
          const value = pair.slice(index + 1);
          if (/max-age=0(?:;|$)/i.test(cookie) || !value) jar.delete(key);
          else jar.set(key, value);
        }
        const raw = await response.text();
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        return { status: response.status, data, cookies };
      },
      async state() {
        return expectStatus(await this.request('/api/state'), 200);
      },
      async authorize(type, token) {
        const result = await this.request('/api/access', { method: 'POST', body: { type, token } });
        expectStatus(result, 200);
        assert.ok(result.cookies.some(cookie => /;\s*HttpOnly(?:;|$)/i.test(cookie)), 'Access must use an HttpOnly cookie');
        return this;
      },
    };
  };
  f.admin = async () => f.client().authorize('admin', f.access.adminToken);
  f.invited = async () => f.client().authorize('invite', f.access.inviteToken);
  f.personal = async url => f.client().authorize('personal', personalToken(url));
  f.add = async (admin, fields) => {
    const data = expectStatus(await admin.request('/api/admin/participants', { method: 'POST', body: fields }), 201);
    const client = await f.personal(data.personalUrl);
    return { client, personalUrl: data.personalUrl, participant: (await client.state()).participant };
  };
  f.action = (admin, action, extra = {}) => admin.request('/api/admin/action', { method: 'POST', body: { action, ...extra } });
  f.setTime = value => { now = new Date(value); };
  f.restart = async () => { await stop(); await start(); };
  if (profiles !== undefined) await writeFile(join(dataDir, 'family-profiles.json'), JSON.stringify(profiles), { mode: 0o600 });
  if (beforeStart) await beforeStart(dataDir);
  await start();
  return f;
}

function assertPrivateState(state) {
  assert.ok(state.admin == null, 'Only the organizer may receive the admin payload');
  assert.ok(!Object.hasOwn(state, 'assignments'), 'Assignments must not be sent outside the admin payload');
}

test('access is scoped: public visitors and invitees cannot read cards or administer the game', async t => {
  const f = await fixture(t);
  const anonymous = f.client();
  const locked = await anonymous.state();
  assert.equal(locked.access, 'locked');
  assert.ok(locked.participant == null);
  assert.ok(locked.recipient == null);
  assert.deepEqual(locked.profiles, []);
  assertPrivateState(locked);
  assert.ok(!JSON.stringify(locked).includes(f.access.adminToken));
  assert.ok(!JSON.stringify(locked).includes(f.access.inviteToken));
  expectStatus(await anonymous.request('/api/participants', { method: 'POST', body: card('Анна') }), 403);
  expectStatus(await anonymous.request('/api/access', { method: 'POST', body: { type: 'admin', token: 'invalid-token' } }), 403);
  const photo = await anonymous.request('/api/photo');
  assert.ok([401, 403].includes(photo.status), 'The family photo must require access');

  const invited = await f.invited();
  const invitedState = await invited.state();
  assert.equal(invitedState.access, 'invited');
  assert.ok(invitedState.participant == null);
  assert.ok(invitedState.recipient == null);
  assertPrivateState(invitedState);
  expectStatus(await f.action(invited, 'draw'), 403);
  expectStatus(await invited.request('/api/me', { method: 'PATCH', body: card('Чужая карточка') }), 403);

  const admin = await f.admin();
  const adminState = await admin.state();
  assert.equal(adminState.access, 'organizer');
  assert.ok(Array.isArray(adminState.admin.participants));
  assert.ok(adminState.admin.invitationUrl.includes(f.access.inviteToken));
  expectStatus(await f.action(admin, 'approve', { id: 'missing-participant' }), 404);
  expectStatus(await f.action(admin, 'remove', { id: 'missing-participant' }), 404);
  expectStatus(await f.action(admin, 'rotate-personal', { id: 'missing-participant' }), 404);
});

test('registration creates a private pending card, rejects duplicate names, unsafe links and cross-origin writes', async t => {
  const f = await fixture(t);
  const invited = await f.invited();
  const fields = card('Анна', { links: ['https://example.com/gift'] });
  const created = expectStatus(await invited.request('/api/participants', { method: 'POST', body: fields }), 201);
  assert.equal(new URL(created.personalUrl).origin, f.origin);
  const personal = await f.personal(created.personalUrl);
  const state = await personal.state();
  assert.equal(state.access, 'participant');
  assert.equal(state.participant.name, fields.name);
  assert.equal(state.participant.wishes, fields.wishes);
  assert.deepEqual(state.participant.links, fields.links);
  assert.equal(state.participant.ready, true);
  assert.equal(state.participant.approved, false);
  assert.equal(state.participant.profileId, null);
  assert.equal(state.participant.profile, null);
  assertPrivateState(state);

  const anotherInvite = await f.invited();
  expectStatus(await anotherInvite.request('/api/participants', { method: 'POST', body: card('  АННА  ') }), 409);
  expectStatus(await anotherInvite.request('/api/participants', { method: 'POST', body: card('Борис', { links: ['javascript:alert(1)'] }) }), 400);
  expectStatus(await anotherInvite.request('/api/participants', {
    method: 'POST', body: card('Вера'), origin: 'https://unrelated.example',
  }), 403);
  expectStatus(await personal.request('/api/me', {
    method: 'PATCH', body: { wishes: 'Подменённые пожелания' }, origin: 'https://unrelated.example',
  }), 403);
  assert.equal((await personal.state()).participant.wishes, fields.wishes);
  assert.equal((await anotherInvite.state()).game.participantCount, 1);
  expectStatus(await personal.request('/api/me', { method: 'PATCH', body: { wishes: 'Книги и настольные игры' } }), 200);
  assert.equal((await personal.state()).participant.wishes, 'Книги и настольные игры');
});

test('drawing requires at least two approved participants with ready cards', async t => {
  const f = await fixture(t);
  const admin = await f.admin();
  expectStatus(await f.action(admin, 'draw'), 409);
  const invited = await f.invited();
  const firstUrl = expectStatus(await invited.request('/api/participants', { method: 'POST', body: card('Анна') }), 201).personalUrl;
  const first = await f.personal(firstUrl);
  const firstId = (await first.state()).participant.id;
  expectStatus(await f.action(admin, 'approve', { id: firstId }), 200);
  expectStatus(await f.action(admin, 'draw'), 409);

  const secondUrl = expectStatus(await (await f.invited()).request('/api/participants', { method: 'POST', body: card('Борис') }), 201).personalUrl;
  const second = await f.personal(secondUrl);
  const secondId = (await second.state()).participant.id;
  expectStatus(await f.action(admin, 'draw'), 409);
  expectStatus(await f.action(admin, 'approve', { id: secondId }), 200);
  expectStatus(await second.request('/api/me', { method: 'PATCH', body: { ready: false } }), 200);
  expectStatus(await f.action(admin, 'draw'), 409);
  assert.equal((await admin.state()).game.phase, 'registration');
  expectStatus(await second.request('/api/me', { method: 'PATCH', body: { ready: true } }), 200);
  expectStatus(await f.action(admin, 'draw'), 200);
  const firstState = await first.state();
  assert.equal(firstState.game.phase, 'drawn');
  assert.equal(firstState.recipient.id, secondId);
  assert.equal((await second.state()).recipient.id, firstId);
});

test('nine-person draw gives exactly one unique recipient per person and reveals only the personal result', async t => {
  const f = await fixture(t);
  const admin = await f.admin();
  const members = [];
  for (let index = 1; index <= 9; index++) members.push(await f.add(admin, card(`Участник ${index}`)));
  expectStatus(await f.action(admin, 'draw'), 200);
  const organizer = await admin.state();
  assert.equal(organizer.game.phase, 'drawn');
  assert.equal(organizer.game.participantCount, 9);
  assert.equal(organizer.admin.assignments.length, 9);
  const ids = new Set(members.map(member => member.participant.id));
  assert.equal(new Set(organizer.admin.assignments.map(pair => pair.giverId)).size, 9);
  assert.deepEqual(new Set(organizer.admin.assignments.map(pair => pair.recipientId)), ids);
  const recipients = new Set();
  for (const member of members) {
    const state = await member.client.state();
    assertPrivateState(state);
    assert.equal(state.participant.id, member.participant.id);
    assert.notEqual(state.recipient.id, member.participant.id);
    assert.ok(ids.has(state.recipient.id));
    assert.deepEqual(Object.keys(state.recipient).sort(), ['avoid', 'id', 'links', 'name', 'profile', 'profileId', 'wishes']);
    assert.equal(state.recipient.profileId, null);
    assert.equal(state.recipient.profile, null);
    recipients.add(state.recipient.id);
    const pair = organizer.admin.assignments.find(item => item.giverId === member.participant.id);
    assert.equal(state.recipient.id, pair.recipientId);
  }
  assert.equal(recipients.size, 9);
  const inviteState = await (await f.invited()).state();
  assertPrivateState(inviteState);
  assert.ok(inviteState.recipient == null);
  assert.ok(inviteState.participant == null);

  expectStatus(await f.action(admin, 'draw'), 409);
  expectStatus(await admin.request('/api/admin/participants', { method: 'POST', body: card('Поздний участник') }), 409);
  expectStatus(await f.action(admin, 'remove', { id: members[0].participant.id }), 409);
  assert.equal(organizer.game.editingOpen, true);
  expectStatus(await members[0].client.request('/api/me', { method: 'PATCH', body: { wishes: 'Новые пожелания' } }), 200);
  const giver = organizer.admin.assignments.find(pair => pair.recipientId === members[0].participant.id);
  const giverClient = members.find(member => member.participant.id === giver.giverId).client;
  assert.equal((await giverClient.state()).recipient.wishes, 'Новые пожелания');
  assert.deepEqual((await admin.state()).admin.assignments, organizer.admin.assignments);
});

test('wish updates stay available after the deadline and draw, persist and reach only the giver', async t => {
  const f = await fixture(t);
  let admin = await f.admin();
  const a = await f.add(admin, card('Участник А'));
  const b = await f.add(admin, card('Участник Б'));
  const c = await f.add(admin, card('Участник В'));
  f.setTime('2026-12-26T00:00:00+05:00');
  assert.equal((await a.client.state()).game.registrationOpen, false);
  const update = { wishes: 'Теперь хочу настольную игру', avoid: 'Без шоколада', links: ['https://example.invalid/gift'] };
  expectStatus(await a.client.request('/api/me', { method: 'PATCH', body: update }), 200);
  expectStatus(await a.client.request('/api/me', { method: 'PATCH', body: { name: 'Другое имя' } }), 409);
  const invited = await f.invited();
  expectStatus(await invited.request('/api/me', { method: 'PATCH', body: update }), 403);
  expectStatus(await invited.request('/api/participants', { method: 'POST', body: card('Поздний участник') }), 409);
  expectStatus(await f.action(admin, 'draw'), 200);
  const before = await admin.state();
  const giverId = before.admin.assignments.find(pair => pair.recipientId === a.participant.id).giverId;
  const giver = [b, c].find(member => member.participant.id === giverId);
  expectStatus(await giver.client.request('/api/workshop', { method: 'PATCH', body: { bought: true } }), 200);
  const progress = (await giver.client.state()).workshop;
  update.wishes = 'Передумал: книга о путешествиях';
  expectStatus(await a.client.request('/api/me', { method: 'PATCH', body: update }), 200);
  await f.restart();
  admin = await f.admin();
  const own = await a.client.state();
  assert.equal(own.game.editingOpen, true);
  for (const key of ['wishes', 'avoid', 'links']) assert.deepEqual(own.participant[key], update[key]);
  assert.equal(own.participant.name, 'Участник А');
  assert.equal(own.participant.ready, true);
  assert.equal(own.participant.approved, true);
  const giverState = await giver.client.state();
  for (const key of ['wishes', 'avoid', 'links']) assert.deepEqual(giverState.recipient[key], update[key]);
  assert.deepEqual(giverState.workshop, progress);
  assert.deepEqual((await admin.state()).admin.assignments, before.admin.assignments);
  const other = [b, c].find(member => member !== giver);
  assert.ok(!JSON.stringify(await other.client.state()).includes(update.wishes));
  assert.ok(!JSON.stringify(await invited.state()).includes(update.wishes));
});

test('organizer can lock post-close wish updates and the choice survives draw, reset and restart', async t => {
  const f = await fixture(t);
  let admin = await f.admin();
  const a = await f.add(admin, card('Участник А'));
  await f.add(admin, card('Участник Б'));
  expectStatus(await f.action(admin, 'set-editing', { enabled: false }), 200);
  expectStatus(await f.action(admin, 'draw'), 200);
  await f.restart();
  assert.equal((await a.client.state()).game.editingOpen, false);
  expectStatus(await a.client.request('/api/me', { method: 'PATCH', body: { wishes: 'Новая идея' } }), 409);
  admin = await f.admin();
  expectStatus(await f.action(admin, 'reset', { confirm: true }), 200);
  assert.equal((await a.client.state()).game.editingOpen, false);
  expectStatus(await f.action(admin, 'set-editing', { enabled: true }), 200);
  expectStatus(await a.client.request('/api/me', { method: 'PATCH', body: { wishes: 'Новая идея' } }), 200);
});

test('reset clears every result, advances the draw version and allows roster changes', async t => {
  const f = await fixture(t);
  const admin = await f.admin();
  const first = await f.add(admin, card('Анна'));
  const second = await f.add(admin, card('Борис'));
  expectStatus(await f.action(admin, 'draw'), 200);
  const previous = await admin.state();
  const unconfirmed = await f.action(admin, 'reset');
  assert.ok(unconfirmed.status >= 400, 'Reset must require explicit confirmation');
  assert.equal((await first.client.state()).recipient.id, second.participant.id);
  expectStatus(await f.action(admin, 'reset', { confirm: true }), 200);
  const reset = await admin.state();
  assert.equal(reset.game.phase, 'registration');
  assert.ok(reset.game.drawVersion > previous.game.drawVersion);
  assert.equal(reset.game.participantCount, 2);
  assert.equal(reset.admin.assignments.length, 0);
  for (const member of [first, second]) {
    const state = await member.client.state();
    assert.equal(state.access, 'participant');
    assert.ok(state.recipient == null);
    assert.equal(state.participant.id, member.participant.id);
  }
  expectStatus(await f.action(admin, 'remove', { id: second.participant.id }), 200);
  await f.add(admin, card('Вера'));
  assert.equal((await admin.state()).game.participantCount, 2);
  expectStatus(await f.action(admin, 'draw'), 200);
  assert.notEqual((await first.client.state()).recipient.id, second.participant.id);
});

test('rotating a personal link revokes the previous token and existing access cookie', async t => {
  const f = await fixture(t);
  const admin = await f.admin();
  const member = await f.add(admin, card('Анна'));
  const rotated = expectStatus(await f.action(admin, 'rotate-personal', { id: member.participant.id }), 200);
  assert.notEqual(personalToken(rotated.personalUrl), personalToken(member.personalUrl));
  expectStatus(await f.client().request('/api/access', {
    method: 'POST', body: { type: 'personal', token: personalToken(member.personalUrl) },
  }), 403);
  const revokedState = await member.client.request('/api/state');
  if (revokedState.status === 200) {
    assert.equal(revokedState.data.access, 'locked');
    assert.ok(revokedState.data.participant == null);
    assert.ok(revokedState.data.recipient == null);
    assertPrivateState(revokedState.data);
  } else assert.ok([401, 403].includes(revokedState.status));
  const replacement = await f.personal(rotated.personalUrl);
  assert.equal((await replacement.state()).participant.id, member.participant.id);
  expectStatus(await member.client.request('/api/me', { method: 'PATCH', body: { wishes: 'Чужое изменение' } }), 403);
});

test('participants, access links and the exact drawn pairs survive a server restart', async t => {
  const f = await fixture(t);
  let admin = await f.admin();
  const members = [];
  for (const name of ['Анна', 'Борис', 'Вера', 'Глеб']) members.push(await f.add(admin, card(name)));
  expectStatus(await f.action(admin, 'draw'), 200);
  const previousState = await admin.state();
  const previousAccess = { ...f.access };
  const previousResults = new Map();
  for (const member of members) previousResults.set(member.participant.id, (await member.client.state()).recipient.id);
  await f.restart();
  assert.deepEqual(f.access, previousAccess);
  admin = await f.admin();
  const restoredState = await admin.state();
  assert.equal(restoredState.game.phase, 'drawn');
  assert.equal(restoredState.game.drawVersion, previousState.game.drawVersion);
  assert.deepEqual(restoredState.admin.participants, previousState.admin.participants);
  assert.deepEqual(restoredState.admin.assignments, previousState.admin.assignments);
  for (const member of members) {
    const state = await (await f.personal(member.personalUrl)).state();
    assert.equal(state.participant.id, member.participant.id);
    assert.equal(state.recipient.id, previousResults.get(member.participant.id));
  }
});

test('registration closes exactly at midnight on December 26 in Tashkent', async t => {
  const f = await fixture(t, '2026-12-25T18:59:59.999Z');
  const invited = await f.invited();
  assert.equal((await invited.state()).game.registrationOpen, true);
  expectStatus(await invited.request('/api/participants', { method: 'POST', body: card('Анна') }), 201);
  f.setTime('2026-12-25T19:00:00.000Z');
  assert.equal((await invited.state()).game.registrationOpen, false);
  const closed = await (await f.invited()).request('/api/participants', { method: 'POST', body: card('Борис') });
  assert.ok(closed.status >= 400, 'A card submitted at the deadline must be rejected');
  assert.equal((await invited.state()).game.participantCount, 1);
});

test('the organizer can close and reopen registration before the deadline', async t => {
  const f = await fixture(t);
  const admin = await f.admin();
  const invited = await f.invited();
  expectStatus(await f.action(admin, 'close-registration'), 200);
  assert.equal((await invited.state()).game.registrationOpen, false);
  const closed = await invited.request('/api/participants', { method: 'POST', body: card('Анна') });
  assert.ok(closed.status >= 400);
  expectStatus(await f.action(admin, 'open-registration'), 200);
  assert.equal((await invited.state()).game.registrationOpen, true);
  expectStatus(await invited.request('/api/participants', { method: 'POST', body: card('Анна') }), 201);
});

test('configured profiles stay private to the invitation and contain no card data or access tokens', async t => {
  const f = await fixture(t, BEFORE_DEADLINE, {
    profiles: SYNTHETIC_PROFILES.map(profile => ({ ...profile, wishes: 'PRIVATE_CONFIGURATION_MARKER', token: 'PRIVATE_TOKEN_MARKER', cardId: 'private-id' })),
  });
  const locked = await f.client().state();
  assert.deepEqual(locked.profiles, []);
  for (const profile of SYNTHETIC_PROFILES) assert.ok(!JSON.stringify(locked).includes(profile.name));
  const invited = await f.invited();
  const initial = await invited.state();
  assert.deepEqual(initial.profiles, SYNTHETIC_PROFILES.map(profile => ({ ...profile, claimed: false })));
  for (const profile of initial.profiles) assert.deepEqual(Object.keys(profile).sort(), ['claimed', 'crop', 'id', 'name', 'role']);
  expectStatus(await invited.request('/api/participants', { method: 'POST', body: card('Произвольное имя') }), 400);
  expectStatus(await invited.request('/api/participants', { method: 'POST', body: { profileId: 'unknown-person', ready: true } }), 404);
  const created = expectStatus(await invited.request('/api/participants', {
    method: 'POST', body: { profileId: SYNTHETIC_PROFILES[0].id, name: 'Игнорируемое имя', wishes: 'PRIVATE_WISH_MARKER', ready: true },
  }), 201);
  const personal = await f.personal(created.personalUrl);
  const own = await personal.state();
  assert.equal(own.participant.name, SYNTHETIC_PROFILES[0].name);
  assert.equal(own.participant.profileId, SYNTHETIC_PROFILES[0].id);
  assert.deepEqual(own.participant.profile, SYNTHETIC_PROFILES[0]);
  const another = await (await f.invited()).state();
  assert.equal(another.profiles[0].claimed, true);
  assert.ok(another.participant == null);
  assert.ok(another.recipient == null);
  for (const marker of ['PRIVATE_CONFIGURATION_MARKER', 'PRIVATE_TOKEN_MARKER', 'PRIVATE_WISH_MARKER', personalToken(created.personalUrl), own.participant.id]) {
    assert.ok(!JSON.stringify(another).includes(marker), `Invitation metadata leaked: ${marker}`);
  }
  expectStatus(await f.client().request('/api/access', {
    method: 'POST', body: { type: 'personal', token: SYNTHETIC_PROFILES[0].id },
  }), 403);
});

test('profile claims have fixed identity, survive draws and restart, and release only when the card is removed', async t => {
  const f = await fixture(t, BEFORE_DEADLINE, { profiles: SYNTHETIC_PROFILES });
  let admin = await f.admin();
  const members = [];
  for (const [index, profile] of SYNTHETIC_PROFILES.slice(0, 2).entries()) {
    const invited = await f.invited();
    const created = expectStatus(await invited.request('/api/participants', {
      method: 'POST', body: { profileId: profile.id, name: 'Подмена имени', wishes: `PRIVATE_WISH_${index}`, ready: true },
    }), 201);
    const client = await f.personal(created.personalUrl);
    const participant = (await client.state()).participant;
    members.push({ client, personalUrl: created.personalUrl, participant });
    expectStatus(await f.action(admin, 'approve', { id: participant.id }), 200);
  }
  expectStatus(await (await f.invited()).request('/api/participants', {
    method: 'POST', body: { profileId: SYNTHETIC_PROFILES[0].id, name: 'Другое имя', ready: true },
  }), 409);
  expectStatus(await members[0].client.request('/api/me', { method: 'PATCH', body: { profileId: SYNTHETIC_PROFILES[1].id } }), 409);
  expectStatus(await members[0].client.request('/api/me', { method: 'PATCH', body: { profileId: null } }), 409);
  expectStatus(await members[0].client.request('/api/me', { method: 'PATCH', body: { name: 'Новое имя' } }), 409);
  assert.ok(!JSON.stringify(await members[0].client.state()).includes('PRIVATE_WISH_1'));
  expectStatus(await members[0].client.request('/api/me', {
    method: 'PATCH', body: { profileId: SYNTHETIC_PROFILES[0].id, name: SYNTHETIC_PROFILES[0].name, wishes: 'Изменённые пожелания' },
  }), 200);
  const matched = await f.add(admin, card(`  ${SYNTHETIC_PROFILES[2].name.toUpperCase()}  `));
  assert.equal(matched.participant.profileId, SYNTHETIC_PROFILES[2].id);
  assert.equal(matched.participant.name, SYNTHETIC_PROFILES[2].name);
  members.push(matched);
  const outside = await f.add(admin, card('Тестовый гость вне фотографии'));
  assert.equal(outside.participant.profileId, null);
  assert.equal(outside.participant.profile, null);
  expectStatus(await outside.client.request('/api/me', { method: 'PATCH', body: { profileId: SYNTHETIC_PROFILES[0].id } }), 409);
  expectStatus(await f.action(admin, 'remove', { id: outside.participant.id }), 200);
  expectStatus(await f.action(admin, 'draw'), 200);
  const beforeRestart = await admin.state();
  for (const member of members) {
    const state = await member.client.state();
    assert.deepEqual(state.participant.profile, SYNTHETIC_PROFILES.find(profile => profile.id === state.participant.profileId));
    assert.deepEqual(state.recipient.profile, SYNTHETIC_PROFILES.find(profile => profile.id === state.recipient.profileId));
    assert.notEqual(state.recipient.profileId, state.participant.profileId);
  }
  await f.restart();
  admin = await f.admin();
  assert.deepEqual((await admin.state()).admin.assignments, beforeRestart.admin.assignments);
  assert.ok((await admin.state()).profiles.every(profile => profile.claimed));
  expectStatus(await f.action(admin, 'reset', { confirm: true }), 200);
  assert.ok((await admin.state()).profiles.every(profile => profile.claimed));
  expectStatus(await f.action(admin, 'remove', { id: members[0].participant.id }), 200);
  const released = (await admin.state()).profiles;
  assert.equal(released.find(profile => profile.id === SYNTHETIC_PROFILES[0].id).claimed, false);
  assert.equal(released.filter(profile => profile.claimed).length, 2);
  const revoked = await members[0].client.state();
  assert.equal(revoked.access, 'locked');
  assert.deepEqual(revoked.profiles, []);
  assert.ok(revoked.participant == null);
  expectStatus(await f.action(admin, 'open-registration'), 200);
  const reclaimedUrl = expectStatus(await (await f.invited()).request('/api/participants', {
    method: 'POST', body: { profileId: SYNTHETIC_PROFILES[0].id, ready: true },
  }), 201).personalUrl;
  assert.notEqual(personalToken(reclaimedUrl), personalToken(members[0].personalUrl));
  const reclaimed = await (await f.personal(reclaimedUrl)).state();
  assert.notEqual(reclaimed.participant.id, members[0].participant.id);
  assert.equal(reclaimed.participant.wishes, '');
});

test('migration from schema v1 preserves cards, credentials and existing assignments', async t => {
  const legacyAccess = { adminToken: 'A'.repeat(43), inviteToken: 'I'.repeat(43) };
  const legacyPersonal = ['P'.repeat(43), 'Q'.repeat(43)];
  const digest = value => createHash('sha256').update(value).digest('hex');
  const f = await fixture(t, BEFORE_DEADLINE, {
    profiles: SYNTHETIC_PROFILES,
    beforeStart: async dataDir => {
      await writeFile(join(dataDir, 'access.json'), JSON.stringify(legacyAccess), { mode: 0o600 });
      const db = new DatabaseSync(join(dataDir, 'santa.sqlite'));
      try {
        db.exec(`
          CREATE TABLE settings(id INTEGER PRIMARY KEY,phase TEXT NOT NULL,registration_closed INTEGER NOT NULL,editing_open INTEGER NOT NULL,draw_version INTEGER NOT NULL);
          INSERT INTO settings VALUES(1,'drawn',1,0,7);
          CREATE TABLE participants(id TEXT PRIMARY KEY,name TEXT NOT NULL,normalized_name TEXT NOT NULL UNIQUE,wishes TEXT NOT NULL,avoid TEXT NOT NULL,links TEXT NOT NULL,approved INTEGER NOT NULL,ready INTEGER NOT NULL,created_at INTEGER NOT NULL);
          CREATE TABLE credentials(token_hash TEXT PRIMARY KEY,kind TEXT NOT NULL,participant_id TEXT UNIQUE REFERENCES participants(id) ON DELETE CASCADE);
          CREATE TABLE assignments(giver_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,recipient_id TEXT NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,draw_version INTEGER NOT NULL,CHECK(giver_id <> recipient_id));
          PRAGMA user_version=1;
        `);
        const insert = db.prepare('INSERT INTO participants VALUES(?,?,?,?,?,?,?,?,?)');
        insert.run('legacy-a', 'Старый тестовый участник А', 'старый тестовый участник а', 'Сохранённые пожелания А', '', '[]', 1, 1, 1);
        insert.run('legacy-b', 'Старый тестовый участник Б', 'старый тестовый участник б', 'Сохранённые пожелания Б', '', '[]', 1, 1, 2);
        db.prepare("INSERT INTO credentials VALUES(?,'admin',NULL)").run(digest(legacyAccess.adminToken));
        for (const [index, id] of ['legacy-a', 'legacy-b'].entries()) db.prepare("INSERT INTO credentials VALUES(?,'participant',?)").run(digest(legacyPersonal[index]), id);
        db.exec("INSERT INTO assignments VALUES('legacy-a','legacy-b',7),('legacy-b','legacy-a',7)");
      } finally { db.close(); }
    },
  });
  const admin = await f.admin();
  const state = await admin.state();
  assert.equal(state.game.phase, 'drawn');
  assert.equal(state.game.drawVersion, 7);
  assert.equal(state.game.participantCount, 2);
  assert.equal(state.game.editingOpen, true);
  assert.deepEqual(state.admin.assignments.map(pair => [pair.giverId, pair.recipientId]), [['legacy-a', 'legacy-b'], ['legacy-b', 'legacy-a']]);
  assert.ok(state.admin.participants.every(participant => participant.profileId === null && participant.profile === null));
  assert.ok(state.profiles.every(profile => profile.claimed === false));
  const personal = await f.client().authorize('personal', legacyPersonal[0]);
  const own = await personal.state();
  assert.equal(own.participant.id, 'legacy-a');
  assert.equal(own.participant.wishes, 'Сохранённые пожелания А');
  assert.equal(own.recipient.id, 'legacy-b');
  assert.equal(own.recipient.wishes, 'Сохранённые пожелания Б');
  const db = new DatabaseSync(join(f.dataDir, 'santa.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.ok(db.prepare('PRAGMA table_info(participants)').all().some(column => column.name === 'profile_id'));
    assert.ok(db.prepare('PRAGMA index_list(participants)').all().some(index => index.name === 'participants_profile_id_unique' && index.unique));
  } finally { db.close(); }
  await f.restart();
  assert.deepEqual((await (await f.admin()).state()).admin.assignments, state.admin.assignments);
  assert.equal((await (await f.client().authorize('personal', legacyPersonal[0])).state()).recipient.id, 'legacy-b');
});

test('invalid private profile configuration fails startup instead of silently exposing or misidentifying people', async t => {
  const first = SYNTHETIC_PROFILES[0];
  const cases = [
    ['unsafe id', [{ ...first, id: '../private' }]],
    ['duplicate ids', [first, { ...SYNTHETIC_PROFILES[1], id: first.id }]],
    ['duplicate normalized names', [first, { ...SYNTHETIC_PROFILES[1], name: `  ${first.name.toUpperCase()}  ` }]],
    ['invalid name', [{ ...first, name: '   ' }]],
    ['oversized role', [{ ...first, role: 'x'.repeat(61) }]],
    ['non-numeric crop', [{ ...first, crop: [0, 0, null, 128] }]],
    ['negative crop', [{ ...first, crop: [-1, 0, 128, 128] }]],
    ['zero-sized crop', [{ ...first, crop: [0, 0, 0, 128] }]],
    ['crop outside portrait', [{ ...first, crop: [1500, 1000, 128, 128] }]],
  ];
  for (const [name, profiles] of cases) {
    await t.test(name, async inner => {
      const dataDir = await mkdtemp(join(tmpdir(), 'secret-santa-invalid-profiles-'));
      inner.after(() => rm(dataDir, { recursive: true, force: true }));
      await writeFile(join(dataDir, 'family-profiles.json'), JSON.stringify(profiles), { mode: 0o600 });
      assert.throws(() => createApp({ dataDir, rateLimit: false }), /family-profiles\.json/);
    });
  }
});

test('batch invitations preserve existing links, make private drafts, and are idempotent', async t => {
  const f = await fixture(t, BEFORE_DEADLINE, { profiles: SYNTHETIC_PROFILES });
  const admin = await f.admin();
  const existing = await f.add(admin, {profileId:SYNTHETIC_PROFILES[0].id, wishes:'EXISTING_PRIVATE_WISH',ready:true});
  expectStatus(await (await f.invited()).request('/api/admin/invitations',{method:'POST',body:{}}),403);
  const batch = expectStatus(await admin.request('/api/admin/invitations',{method:'POST',body:{}}),200);
  assert.equal(batch.invitations.length,2);
  assert.deepEqual(batch.invitations.map(p=>p.profileId),SYNTHETIC_PROFILES.slice(1).map(p=>p.id));
  const newClients=[];
  for (const invitation of batch.invitations) {
    const client=await f.personal(invitation.personalUrl);
    newClients.push(client);
    const state=await client.state();
    assert.equal(state.participant.id,invitation.id);
    assert.equal(state.participant.name,invitation.name);
    assert.equal(state.participant.ready,false);
    assert.equal(state.participant.wishes,'');
  }
  assert.equal((await existing.client.state()).participant.wishes,'EXISTING_PRIVATE_WISH');
  assert.deepEqual((await (await f.invited()).state()).game.readiness,{ready:1,total:3});
  assert.ok(!Object.hasOwn((await f.client().state()).game,'readiness'));
  assert.deepEqual(expectStatus(await admin.request('/api/admin/invitations',{method:'POST',body:{}}),200).invitations,[]);
  assert.equal((await admin.state()).admin.participants.length,3);
  for (const [i,client] of newClients.entries()) {
    expectStatus(await client.request('/api/me',{method:'PATCH',body:{wishes:'NEW_PRIVATE_WISH_'+i,ready:true}}),200);
  }
  const invited=await (await f.invited()).state();
  assert.deepEqual(invited.game.readiness,{ready:3,total:3});
  assert.ok(!JSON.stringify(invited).includes('PRIVATE_WISH'));
  for (const invitation of batch.invitations) assert.ok(!JSON.stringify(invited).includes(personalToken(invitation.personalUrl)));
  expectStatus(await f.action(admin,'draw'),200);
  expectStatus(await admin.request('/api/admin/invitations',{method:'POST',body:{}}),409);
  await f.restart();
  assert.equal((await existing.client.state()).participant.name,SYNTHETIC_PROFILES[0].name);
  assert.equal((await newClients[0].state()).participant.ready,true);
});

test('workshop is private to the giver, persists, and resets with assignments', async t => {
  const f=await fixture(t);
  let admin=await f.admin();
  const a=await f.add(admin,card('Первый тестовый Санта'));
  const b=await f.add(admin,card('Второй тестовый Санта'));
  expectStatus(await a.client.request('/api/workshop',{method:'PATCH',body:{idea:true}}),409);
  expectStatus(await admin.request('/api/workshop',{method:'PATCH',body:{idea:true}}),403);
  expectStatus(await (await f.invited()).request('/api/workshop',{method:'PATCH',body:{idea:true}}),403);
  expectStatus(await f.action(admin,'draw'),200);
  const empty={idea:false,bought:false,wrapped:false};
  assert.deepEqual((await a.client.state()).workshop,empty);
  expectStatus(await a.client.request('/api/workshop',{method:'PATCH',body:{idea:true,bought:true,wrapped:true}}),200);
  assert.deepEqual((await a.client.state()).workshop,{idea:true,bought:true,wrapped:true});
  assert.deepEqual((await b.client.state()).workshop,empty);
  assert.ok(!Object.hasOwn((await b.client.state()).recipient,'workshop'));
  const adminState=await admin.state();
  assert.ok(!Object.hasOwn(adminState,'workshop'));
  assert.ok(adminState.admin.participants.every(p=>!Object.hasOwn(p,'workshop')));
  expectStatus(await a.client.request('/api/workshop',{method:'PATCH',body:{idea:'yes'}}),400);
  expectStatus(await a.client.request('/api/workshop',{method:'PATCH',body:{id:b.participant.id,idea:true}}),400);
  expectStatus(await a.client.request('/api/workshop',{method:'PATCH',body:{}}),400);
  expectStatus(await a.client.request('/api/workshop',{method:'PATCH',origin:'https://other.invalid',body:{wrapped:false}}),403);
  await f.restart();
  assert.deepEqual((await a.client.state()).workshop,{idea:true,bought:true,wrapped:true});
  admin=await f.admin();
  const rotated=expectStatus(await f.action(admin,'rotate-personal',{id:a.participant.id}),200);
  const newAccess=await f.personal(rotated.personalUrl);
  assert.deepEqual((await newAccess.state()).workshop,{idea:true,bought:true,wrapped:true});
  expectStatus(await a.client.request('/api/workshop',{method:'PATCH',body:{idea:false}}),403);
  expectStatus(await f.action(admin,'reset',{confirm:true}),200);
  assert.equal((await newAccess.state()).workshop,null);
  expectStatus(await f.action(admin,'draw'),200);
  assert.deepEqual((await newAccess.state()).workshop,empty);
});

test('schema v2 upgrade keeps existing cards, access and exact assignments', async t => {
  const f=await fixture(t);
  const admin=await f.admin();
  const a=await f.add(admin,card('Сохранённый участник А'));
  await f.add(admin,card('Сохранённый участник Б'));
  expectStatus(await f.action(admin,'draw'),200);
  const before=await admin.state();
  const legacy=new DatabaseSync(join(f.dataDir,'santa.sqlite'));
  legacy.exec('DROP TABLE gift_progress; PRAGMA user_version=2');
  legacy.close();
  await f.restart();
  const after=await (await f.admin()).state();
  assert.deepEqual(after.admin.participants,before.admin.participants);
  assert.deepEqual(after.admin.assignments,before.admin.assignments);
  assert.equal((await a.client.state()).participant.id,a.participant.id);
  assert.deepEqual((await a.client.state()).workshop,{idea:false,bought:false,wrapped:false});
});

test('a batch invitation conflict rolls back every new card', async t => {
  const f=await fixture(t,BEFORE_DEADLINE,{profiles:SYNTHETIC_PROFILES});
  const admin=await f.admin();
  const legacy=await f.add(admin,{profileId:SYNTHETIC_PROFILES[1].id,ready:true});
  const db=new DatabaseSync(join(f.dataDir,'santa.sqlite'));
  db.prepare('UPDATE participants SET profile_id=NULL WHERE id=?').run(legacy.participant.id);
  db.close();
  expectStatus(await admin.request('/api/admin/invitations',{method:'POST',body:{}}),409);
  const state=await admin.state();
  assert.equal(state.admin.participants.length,1);
  assert.ok(state.profiles.every(profile=>!profile.claimed));
  assert.equal((await legacy.client.state()).participant.id,legacy.participant.id);
});
