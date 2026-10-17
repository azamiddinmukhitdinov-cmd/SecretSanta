import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// A DOM stub checks client rendering and handlers without changing the live game.
function client({ storage = new Map(), storageFails = false, onRequest, search = '', reducedMotion = false } = {}) {
  const handlers = {};
  const elements = new Map();
  const element = () => ({ innerHTML: '', textContent: '', open: false, showModal() { this.open = true; }, close() { this.open = false; }, classList: { toggle() {}, add() {}, remove() {} }, querySelector() { return null; } });
  for (const id of ['#main', '#navigation', '#toast', '#access-dialog', '#access-error', '#access-title', '#access-description']) elements.set(id, element());
  let responseState = state();
  let replacedUrl = '';
  let now = Date.parse('2026-12-31T18:59:00Z');
  const context = vm.createContext({
    document: { querySelector: id => elements.get(id) || null, querySelectorAll: () => [], body: element(), addEventListener: (type, handler) => { handlers[type] = handler; } },
    window: { addEventListener() {}, matchMedia: () => ({ matches: reducedMotion }) },
    localStorage: { getItem(key) { return storage.get(key) || null; }, setItem(key, value) { if (storageFails) throw new Error('Storage disabled'); storage.set(key, value); }, removeItem(key) { storage.delete(key); } },
    FormData: class { constructor(form) { this.values = form.values; } get(key) { return this.values[key] ?? null; } },
    setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    URL, URLSearchParams, Blob,
    location: { hash: '#organizer', pathname: '/', search, origin: 'https://example.invalid' },
    history: { replaceState(_state, _title, url) { replacedUrl = url; } },
    fetch: async (path, options) => {
      if (onRequest && path !== '/api/state') return onRequest(path, options);
      assert.equal(path, '/api/state', 'Public organizer entry must not send an access token');
      return { ok: true, json: async () => responseState };
    },
    Date: class extends Date { static now() { return now; } },
  });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/^start\(\);$/m, '');
  vm.runInContext(source + `\nglobalThis.api = {
    setState(value) { state=value; }, select(id) { selectedProfileId=id; },
    familyPortrait, holidayMood, countdownText, participantForm, workshopPanel, memberView,
    personalInvitations, rememberInvitation, invitationMessage, render, openOrganizer, start,
    captureDraft, restoreDraft, clearDraft, draftKey, getFormData, draftStatusText, emailPanel, mailSetup, adminView, recipientCard
  };`, context);
  return { api: context.api, elements, handlers, setTime: value => { now = Date.parse(value); }, mockState: value => { responseState = value; }, replacedUrl: () => replacedUrl };
}

function state() {
  return {
    access: 'invited', participant: null, recipient: null,
    game: { exchangeAt: '2027-01-01T00:00:00+05:00', registrationOpen: true, phase: 'registration', readiness: { ready: 1, total: 2 } },
    profiles: [
      { id: 'a', name: 'Персонаж <А>', role: '', crop: [100, 200, 300, 300], claimed: false },
      { id: 'b', name: 'Персонаж Б', role: '', crop: [800, 200, 300, 300], claimed: true },
    ],
  };
}

test('portrait links follow crop coordinates, escape names and disable claimed profiles', () => {
  const c = client();
  c.api.setState(state());
  const html = c.api.familyPortrait();
  assert.ok(html.includes('viewBox="0 0 1536 1024"'));
  assert.ok(html.includes('cx="250" cy="350"'));
  assert.ok(html.includes('Персонаж &lt;А&gt;'));
  assert.ok(!html.includes('style='), 'Hotspot alignment must work with the existing CSP');
  assert.match(html, /data-profile="b"[^>]*aria-disabled="true"[^>]*tabindex="-1"/);
  c.api.render();
  assert.ok(c.elements.get('#main').innerHTML.includes('profile-picker'));
  assert.ok(c.elements.get('#main').innerHTML.includes('holiday-countdown'));
});

test('countdown uses Tashkent midnight and readiness is optional for locked visitors', () => {
  const c = client(), s = state();
  c.api.setState(s);
  assert.equal(c.api.countdownText(), '0 дн. · 00 ч. · 01 мин. · 00 сек.');
  assert.ok(c.api.holidayMood().includes('1 из 2'));
  c.setTime('2026-12-31T19:00:00Z');
  assert.ok(c.api.countdownText().includes('С Новым годом'));
  delete s.game.readiness;
  assert.ok(!c.api.holidayMood().includes('family-progress'));
});

test('wish suggestions append once, keep existing text and respect disabled fields', async () => {
  const c = client(); c.api.setState(state()); c.api.select('a');
  assert.ok(c.api.participantForm().includes('data-action="wish-prompt"'));
  const textarea = { value: 'Моя собственная идея', maxLength: 2000, disabled: false, focus() {}, scrollIntoView() {} };
  c.elements.set('#member-wishes', textarea);
  const button = { dataset: { action: 'wish-prompt', prompt: 'comfort' }, disabled: false, getAttribute() { return null; }, matches() { return false; } };
  const event = { target: { closest: () => button } };
  await c.handlers.click(event);
  assert.ok(textarea.value.startsWith('Моя собственная идея\nДля уюта:'));
  const after = textarea.value;
  await c.handlers.click(event);
  assert.equal(textarea.value, after);
  textarea.disabled = true; button.dataset.prompt = 'hobby';
  await c.handlers.click(event);
  assert.equal(textarea.value, after);
});

test('invitation package has per-person messages and workshop renders only its own three marks', () => {
  const c = client(), s = state(); s.access = 'organizer';
  c.api.setState(s);
  c.api.rememberInvitation({ id: 'one', profileId: 'a', name: 'Персонаж <А>', personalUrl: 'https://example.invalid/#personal=TEST' });
  const html = c.api.personalInvitations();
  assert.ok(html.includes('Подготовить все приглашения'));
  assert.ok(html.includes('Скачать подготовленные (1)'));
  assert.ok(html.includes('data-action="copy-invite-message"'));
  const message = c.api.invitationMessage({ name: 'Тест', personalUrl: 'https://example.invalid/#personal=TEST' });
  assert.ok(message.includes('\nТвоя личная ссылка: https://example.invalid/#personal=TEST'));
  assert.equal(c.api.workshopPanel(), '');
  s.workshop = { idea: true, bought: false, wrapped: false };
  const workshop = c.api.workshopPanel();
  assert.equal((workshop.match(/data-workshop=/g) || []).length, 3);
  assert.ok(workshop.includes('Готово 1 из 3'));
  const own = { name: 'Тест', wishes: '', avoid: '', links: [], ready: true, approved: true, profile: s.profiles[0], profileId: 'a' };
  assert.ok(c.api.participantForm(own).includes('ДОСТАВЛЕНО'));
});

test('public organizer entry requests private organizer access instead of granting permissions', async () => {
  const c = client();
  await c.api.start();
  assert.equal(c.elements.get('#access-dialog').open, true);
  assert.equal(c.elements.get('#access-title').textContent, 'Вход организатора');
  assert.ok(c.elements.get('#access-description').textContent.includes('личную ссылку организатора'));
  assert.ok(!c.elements.get('#main').innerHTML.includes('Кабинет организатора'));
  assert.ok(c.elements.get('#navigation').innerHTML.includes('data-action="open-organizer"'));
  assert.equal(c.replacedUrl(), '/#organizer');
});

test('participants can open and edit their wishes after the draw, while identity stays fixed', async () => {
  const c = client(), s = state();
  s.access = 'participant';
  s.game.registrationOpen = false;
  s.game.editingOpen = true;
  s.game.phase = 'drawn';
  s.participant = { name: 'Тест', wishes: 'Книга', avoid: '', links: [], ready: true, approved: true };
  c.api.setState(s);
  assert.match(c.api.memberView(), /data-action="edit-wishes"[^>]*>Изменить пожелания/);
  assert.match(c.api.memberView(), /id="wish-editor"/);
  const form = c.api.participantForm(s.participant);
  assert.match(form, /id="member-name"[^>]*readonly/);
  assert.doesNotMatch(form.match(/<textarea id="member-wishes"[^>]*>/)[0], /disabled/);
  let scrolled = false, focused = false;
  const editor = { open: false, scrollIntoView() { scrolled = true; } };
  c.elements.set('.detail-editor', editor);
  c.elements.set('#member-wishes', { focus() { focused = true; } });
  const button = { dataset: { action: 'edit-wishes' }, disabled: false, getAttribute() { return null; }, matches() { return false; } };
  await c.handlers.click({ target: { closest: () => button } });
  assert.equal(editor.open, true);
  assert.ok(scrolled && focused);
  s.game.editingOpen = false;
  assert.ok(!c.api.memberView().includes('data-action="edit-wishes"'));
  assert.match(c.api.participantForm(s.participant), /id="member-wishes"[^>]*disabled/);
});

test('public organizer entry opens the cabinet directly for an existing organizer session', async () => {
  const c = client(), s = state();
  s.access = 'organizer';
  s.admin = { participants: [], assignments: [], invitationUrl: 'https://example.invalid/#invite=TEST' };
  c.mockState(s);
  await c.api.start();
  assert.ok(c.elements.get('#main').innerHTML.includes('Кабинет организатора'));
  assert.equal(c.elements.get('#access-dialog').open, false);
});

test('draft survives closing the page, stays scoped to its participant and keeps its original revision', () => {
  const storage = new Map(), c = client({ storage }), s = state();
  s.access = 'participant';
  s.participant = { id: 'card-a', name: 'А', wishes: 'На сервере', avoid: '', links: [], ready: true, revision: 1 };
  c.api.setState(s);
  const form = { values: { name: 'А', wishes: 'Мой незавершённый черновик', avoid: 'Без сладкого', links: 'https://example.invalid/gift' } };
  c.elements.set('#participant-form', form);
  c.handlers.input({ target: { closest: () => form } });
  assert.ok(storage.has('santa-draft:v1:member:card-a'));
  const reopened = client({ storage });
  s.participant.revision = 2;
  reopened.api.setState(s); reopened.api.restoreDraft();
  const html = reopened.api.participantForm(s.participant);
  assert.ok(html.includes('Мой незавершённый черновик'));
  assert.ok(html.includes('Показать сохранённую карточку'));
  assert.equal(reopened.api.getFormData(form).revision, 1, 'Restoring a draft must not upgrade its revision silently');
  assert.equal(reopened.api.getFormData(form).participantId, 'card-a');
  const other = client({ storage });
  const second = { ...s, participant: { ...s.participant, id: 'card-b', name: 'Б' } };
  other.api.setState(second); other.api.restoreDraft();
  assert.ok(!other.api.participantForm(second.participant).includes('Мой незавершённый черновик'));
  reopened.api.clearDraft(); assert.equal(storage.has('santa-draft:v1:member:card-a'), false);
});

test('new participant drafts are separated by profile and storage failure is visible', () => {
  const storage = new Map(), c = client({ storage }); c.api.setState(state()); c.api.select('a');
  const form = { values: { name: 'А', wishes: 'Пожелание для А', avoid: '', links: '' } };
  c.elements.set('#participant-form', form);
  c.handlers.input({ target: { closest: () => form } });
  assert.ok(storage.has('santa-draft:v1:new:a'));
  const other = client({ storage }); other.api.setState(state()); other.api.select('b'); other.api.restoreDraft();
  assert.ok(!other.api.participantForm().includes('Пожелание для А'));
  const unavailable = client({ storageFails: true }); unavailable.api.setState(state()); unavailable.api.select('a');
  unavailable.elements.set('#participant-form', form);
  unavailable.handlers.input({ target: { closest: () => form } });
  assert.ok(unavailable.api.draftStatusText().includes('Не удалось сохранить черновик'));
});

test('both email forms submit JSON through their handlers without native navigation', async () => {
  for (const [id, path, values] of [
    ['email-form', '/api/email', { email: 'test@example.invalid', enabled: 'on' }],
    ['mail-setup-form', '/api/admin/mail', { provider: 'gmail', from: 'sender@example.invalid', password: 'test-application-password' }],
  ]) {
    const sent = [];
    const c = client({ onRequest: async (url, options) => {
      sent.push({ url, options }); return { ok: true, json: async () => ({ ok: true }) };
    } });
    const s = state(); s.access = 'participant';
    s.participant = { id: 'test-member', name: 'Тест', wishes: '', avoid: '', links: [], ready: true, approved: true };
    c.api.setState(s); c.mockState(s);
    let prevented = false, reset = false;
    const form = { id, values, querySelector: () => null, reset() { reset = true; } };
    await c.handlers.submit({ target: form, preventDefault() { prevented = true; } });
    assert.equal(prevented, true, `${id} must not perform a native form submission`);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, path);
    assert.equal(sent[0].options.method, 'POST');
    assert.ok(!sent[0].url.includes(values.password || values.email));
    const body = JSON.parse(sent[0].options.body);
    if (id === 'email-form') {
      assert.equal(body.participantId, s.participant.id);
      assert.equal(body.email, values.email);
      assert.equal(body.enabled, true);
      assert.match(c.api.emailPanel(), /method="post" action="\/api\/email"/);
    } else {
      assert.equal(body.password, values.password);
      assert.equal(reset, true, 'Clear password form after success');
      assert.match(c.api.mailSetup(), /method="post" action="\/api\/admin\/mail"/);
    }
  }
});

test('legacy native form query is removed from the current address and history entry', async () => {
  const c = client({ search: '?provider=gmail&from=test%40example.invalid&password=synthetic-password' });
  await c.api.start();
  assert.equal(c.replacedUrl(), '/#organizer');
});

test('November draw does not require finished wishes and recipient view explains waiting until December 6', () => {
  const c = client(), s = state();
  s.access = 'organizer';
  const a = { id: 'a', name: 'А', wishes: '', avoid: '', links: [], ready: false, approved: true };
  const b = { ...a, id: 'b', name: 'Б' };
  s.admin = { participants: [a, b], assignments: [], invitationUrl: 'https://example.invalid/#invite=TEST' };
  s.game.drawAvailable = false;
  c.api.setState(s);
  assert.match(c.api.adminView(), /data-action="draw" disabled/);
  s.game.drawAvailable = true;
  assert.doesNotMatch(c.api.adminView(), /data-action="draw" disabled/);
  s.participant = a; s.recipient = { ...b, wishesReady: false };
  s.game.phase = 'drawn'; s.game.registrationOpen = false; s.game.editingOpen = true;
  assert.ok(c.api.recipientCard().includes('Получатель ещё готовит письмо'));
  assert.ok(c.api.recipientCard().includes('до 6 декабря включительно'));
  assert.match(c.api.memberView(), /data-action="edit-wishes"[^>]*>Заполнить пожелания/);
  s.recipient.wishesReady = true;
  assert.ok(!c.api.recipientCard().includes('Получатель ещё готовит письмо'));
  const invitation = c.api.invitationMessage({ name: 'А', personalUrl: 'https://example.invalid/#personal=TEST' });
  assert.ok(invitation.includes('22 ноября') && invitation.includes('6 декабря'));
  assert.ok(!invitation.includes('25 декабря'));
});

test('sleigh interaction flies on request and motion controls stop it', async () => {
  for (const reducedMotion of [false, true]) {
    const c = client({ reducedMotion });
    const classes = new Set();
    const flight = { hidden: true, offsetWidth: 230, classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); } } };
    c.elements.set('#santa-flight', flight);
    const button = { dataset: { action: 'santa-ride' }, disabled: false, getAttribute() { return null; }, matches() { return false; } };
    await c.handlers.click({ target: { closest: () => button } });
    assert.equal(flight.hidden, reducedMotion);
    assert.equal(classes.has('is-flying'), !reducedMotion);
    assert.ok(c.elements.get('#toast').textContent.includes('Дед Мороз уже в пути'));
    button.dataset.action = 'toggle-motion';
    await c.handlers.click({ target: { closest: () => button } });
    assert.equal(flight.hidden, true);
    assert.equal(classes.has('is-flying'), false);
  }
});
