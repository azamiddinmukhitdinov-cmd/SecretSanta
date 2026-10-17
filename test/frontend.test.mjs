import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// A DOM stub checks client rendering and handlers without changing the live game.
function client() {
  const handlers = {};
  const elements = new Map();
  const element = () => ({ innerHTML: '', textContent: '', open: false, showModal() { this.open = true; }, close() { this.open = false; }, classList: { toggle() {}, add() {}, remove() {} }, querySelector() { return null; } });
  for (const id of ['#main', '#navigation', '#toast', '#access-dialog', '#access-error', '#access-title', '#access-description']) elements.set(id, element());
  let responseState = state();
  let replacedUrl = '';
  let now = Date.parse('2026-12-31T18:59:00Z');
  const context = vm.createContext({
    document: { querySelector: id => elements.get(id) || null, body: element(), addEventListener: (type, handler) => { handlers[type] = handler; } },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
    localStorage: { getItem() { return null; } },
    setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    URL, URLSearchParams, Blob,
    location: { hash: '#organizer', pathname: '/', search: '', origin: 'https://example.invalid' },
    history: { replaceState(_state, _title, url) { replacedUrl = url; } },
    fetch: async path => {
      assert.equal(path, '/api/state', 'Public organizer entry must not send an access token');
      return { ok: true, json: async () => responseState };
    },
    Date: class extends Date { static now() { return now; } },
  });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/^start\(\);$/m, '');
  vm.runInContext(source + `\nglobalThis.api = {
    setState(value) { state=value; }, select(id) { selectedProfileId=id; },
    familyPortrait, holidayMood, countdownText, participantForm, workshopPanel,
    personalInvitations, rememberInvitation, invitationMessage, render, openOrganizer, start
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

test('public organizer entry opens the cabinet directly for an existing organizer session', async () => {
  const c = client(), s = state();
  s.access = 'organizer';
  s.admin = { participants: [], assignments: [], invitationUrl: 'https://example.invalid/#invite=TEST' };
  c.mockState(s);
  await c.api.start();
  assert.ok(c.elements.get('#main').innerHTML.includes('Кабинет организатора'));
  assert.equal(c.elements.get('#access-dialog').open, false);
});
