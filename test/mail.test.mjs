import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createMail } from '../src/mail.mjs';

test('mail requires consent and verified addresses, keeps Santa secret, retries and persists sent status', async t => {
  const root = await mkdtemp(join(tmpdir(), 'santa-mail-test-'));
  const store = createStore(root);
  let mail;
  t.after(async () => { await mail?.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  let now = new Date('2026-12-01T12:00:00Z'), fail = false;
  const messages = [], factories = [];
  const options = { appUrl: 'https://example.invalid', clock: () => now, transportFactory: config => {
    factories.push(config);
    return { verify: async () => true, close() {}, sendMail: async message => { if (fail) throw new Error('Test SMTP outage'); messages.push(message); } };
  } };
  mail = await createMail(store, options);
  const a = store.createParticipant({ name: 'А', wishes: 'Книга', ready: true }, now, { admin: true });
  const b = store.createParticipant({ name: 'Б', wishes: 'Игра', ready: true }, now, { admin: true });
  store.setMailPreferences(a.participant.id, { email: 'a@example.invalid', enabled: true }, now, false);
  store.setMailPreferences(b.participant.id, { email: 'b@example.invalid', enabled: true }, now, false);
  await mail.flush(); assert.equal(messages.length, 0);
  const status = await mail.save({ provider: 'gmail', from: 'sender@example.invalid', password: 'fake-application-password' });
  assert.equal(status.configured, true);
  assert.ok(!JSON.stringify(status).includes('fake-application-password'));
  assert.equal(factories[0].secure, true);
  await mail.flush(); assert.equal(messages.length, 2);
  for (const message of messages) {
    const secret = message.text.match(/#verify-email=([A-Za-z0-9_-]{43})/)[1];
    assert.ok(!JSON.stringify(store.mailPreferences(a.participant.id)).includes(secret));
    store.verifyMail(secret, now);
    assert.throws(() => store.verifyMail(secret, now));
  }
  store.adminAction({ action: 'draw' }, now);
  fail = true; await mail.flush(); assert.equal(messages.length, 2);
  now = new Date(now.getTime() + 300000); fail = false;
  await mail.flush(); assert.equal(messages.length, 4);
  assert.ok(messages[2].subject.includes('пожеланиями'));
  store.updateWorkshop(a.participant.id, { idea: true }, now);
  await mail.flush(); assert.equal(messages.length, 5);
  const gift = messages[4];
  assert.equal(gift.to, 'b@example.invalid');
  assert.ok(gift.subject.includes('выбрал подарок'));
  assert.ok(!gift.text.includes(a.participant.id) && !gift.text.includes('#personal='));
  await mail.close(); mail = await createMail(store, options);
  await mail.flush(); assert.equal(messages.length, 5, 'Sent emails must not be resent on restart');
  store.setMailPreferences(a.participant.id, { email: 'a@example.invalid', enabled: false }, now, true);
  store.updateWorkshop(b.participant.id, { idea: true }, now);
  await mail.flush(); assert.equal(messages.length, 5, 'Opt-out stops future email');
  assert.ok(!Object.hasOwn(store.recipient(b.participant.id), 'email'));
});

test('Mail.ru addresses select the correct SMTP server and show their own authentication error', async t => {
  const root = await mkdtemp(join(tmpdir(), 'santa-mail-provider-test-'));
  const store = createStore(root);
  let options, code = 'EAUTH', mail;
  t.after(async () => { await mail?.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  mail = await createMail(store, { appUrl: 'https://example.invalid', transportFactory: config => {
    options = config;
    return { verify: async () => { throw Object.assign(new Error('Synthetic failure'), { code }); }, close() {} };
  } });
  const input = { provider: 'gmail', from: 'sender@mail.ru', password: 'synthetic-password' };
  await assert.rejects(() => mail.save(input), error => error.status === 400 && error.message.includes('Mail.ru отклонил вход') && !error.message.includes('Gmail'));
  assert.equal(options.host, 'smtp.mail.ru');
  assert.equal(mail.status().configured, false);
  code = 'ETIMEDOUT';
  await assert.rejects(() => mail.save(input), error => error.message.includes('Не удалось связаться') && !error.message.includes('пароль'));
});
