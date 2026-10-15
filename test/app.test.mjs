import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';

const BEFORE_DEADLINE = '2026-12-01T12:00:00.000Z';

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

async function fixture(t, initialTime = BEFORE_DEADLINE) {
  const dataDir = await mkdtemp(join(tmpdir(), 'secret-santa-test-'));
  let now = new Date(initialTime);
  let active;
  const f = { origin: '', access: null };

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
    assert.deepEqual(Object.keys(state.recipient).sort(), ['avoid', 'id', 'links', 'name', 'wishes']);
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
  expectStatus(await members[0].client.request('/api/me', { method: 'PATCH', body: { wishes: 'Новые пожелания' } }), 409);
  expectStatus(await f.action(admin, 'set-editing', { enabled: true }), 200);
  expectStatus(await members[0].client.request('/api/me', { method: 'PATCH', body: { wishes: 'Новые пожелания' } }), 200);
  const giver = organizer.admin.assignments.find(pair => pair.recipientId === members[0].participant.id);
  const giverClient = members.find(member => member.participant.id === giver.giverId).client;
  assert.equal((await giverClient.state()).recipient.wishes, 'Новые пожелания');
  assert.deepEqual((await admin.state()).admin.assignments, organizer.admin.assignments);
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
