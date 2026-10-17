const main = document.querySelector('#main');
const navigation = document.querySelector('#navigation');
const toastElement = document.querySelector('#toast');
let state;
let activeTab = 'member';
let revealed = false;
let opening = false;
let busy = false;
let personalLink = null;
let toastTimer;
let draft = null;
let formDirty = false;
let initialError = '';
let pollSequence = 0;
let selectedProfileId = null;
let invitationBatch = [];
let letterJustSent = false;
let organizerLogin = false;
let motionPaused = false;
try { motionPaused = localStorage.getItem('santa-motion-paused') === 'true'; } catch {}

function applyMotionPreference() {
  document.body.classList.toggle('motion-paused', motionPaused);
  const button = document.querySelector('[data-action="toggle-motion"]');
  if (button) {
    button.setAttribute('aria-pressed', String(motionPaused));
    button.setAttribute('aria-label', motionPaused ? 'Включить анимацию снега и гирлянды' : 'Остановить анимацию снега и гирлянды');
    const label = button.querySelector('.motion-toggle-label');
    if (label) label.textContent = motionPaused ? 'Включить анимацию' : 'Остановить анимацию';
  }
}
applyMotionPreference();

const symbols = {
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  gift: '<path d="M3 8h18v4H3zM5 12v9h14v-9M12 8v13M12 8H7.5A2.5 2.5 0 1 1 10 5.5L12 8Zm0 0h4.5A2.5 2.5 0 1 0 14 5.5L12 8Z"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 11h16m-12 4h2m4 0h2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  share: '<path d="M12 16V3m-4 4 4-4 4 4M7 10H4v11h16V10h-3"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 .2 8M20 3v5h-5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  key: '<circle cx="8" cy="8" r="4"/><path d="m11 11 10 10m-5-5 3-3m-6 0 3-3"/>',
  exit: '<path d="M9 4H4v16h5m5-12 4 4-4 4m-5-4h12"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  heart: '<path d="M20.5 5.5a5 5 0 0 0-7.1 0L12 7l-1.4-1.5a5 5 0 0 0-7.1 7.1L12 21l8.5-8.4a5 5 0 0 0 0-7.1Z"/>',
};
const icon = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${symbols[name] || symbols.gift}</svg>`;
const escape = (value = '') => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const initials = (name) => String(name).trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0] || '').join('').toUpperCase();
const safeLink = (value) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
};

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let data;
  try { data = await response.json(); } catch { throw new Error('Сервер не ответил. Попробуйте ещё раз чуть позже.'); }
  if (!response.ok) throw new Error(data.error || 'Не получилось выполнить действие. Попробуйте ещё раз.');
  return data;
}
const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) });

function notify(message, isError = false) {
  clearTimeout(toastTimer);
  toastElement.classList.toggle('error', isError);
  toastElement.textContent = message;
  toastElement.classList.add('visible');
  toastTimer = setTimeout(() => toastElement.classList.remove('visible'), isError ? 8500 : 5500);
}

async function task(button, action, errorTarget) {
  if (busy) return;
  busy = true;
  const buttons = [...document.querySelectorAll('button:not(dialog button)')].map(element => [element, element.disabled]);
  for (const [element] of buttons) element.disabled = true;
  if (button) button.setAttribute('aria-busy', 'true');
  if (errorTarget) errorTarget.textContent = '';
  try { await action(); }
  catch (error) {
    const message = error instanceof TypeError ? 'Не удалось связаться с сайтом. Проверьте интернет и попробуйте снова.' : error.message;
    if (errorTarget?.isConnected) { errorTarget.textContent = message; errorTarget.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    else notify(message, true);
  } finally {
    busy = false;
    if (button) button.removeAttribute('aria-busy');
    for (const [element, disabled] of buttons) if (element.isConnected) element.disabled = disabled;
  }
}

function ask(title, message, acceptLabel, danger = false) {
  return new Promise(resolve => {
    const dialog = document.querySelector('#confirm-dialog');
    document.querySelector('#confirm-title').textContent = title;
    document.querySelector('#confirm-message').textContent = message;
    const accept = document.querySelector('#confirm-accept');
    accept.textContent = acceptLabel;
    accept.className = `button ${danger ? 'button-danger' : 'button-primary'}`;
    dialog.returnValue = 'cancel';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

function getFormData(form) {
  const values = new FormData(form);
  const links = String(values.get('links') || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (links.length > 5) throw new Error('Можно добавить не больше пяти ссылок на подарки.');
  if (links.some(value => !safeLink(value))) throw new Error('Каждая ссылка должна начинаться с https:// или http://.');
  const name = String(values.get('name') || '').trim();
  if (!name) throw new Error('Напишите, пожалуйста, ваше имя.');
  return { name, wishes: String(values.get('wishes') || '').trim(), avoid: String(values.get('avoid') || '').trim(), links, ready: true, ...(!state.participant && selectedProfileId ? { profileId: selectedProfileId } : {}) };
}

function captureDraft() {
  const form = document.querySelector('#participant-form');
  if (!form || !formDirty) return;
  const values = new FormData(form);
  draft = { name: values.get('name'), wishes: values.get('wishes'), avoid: values.get('avoid'), linksText: values.get('links'), open: document.querySelector('.detail-editor')?.open ?? true };
}

async function refresh({ silent = false } = {}) {
  const sequence = ++pollSequence;
  const next = await request('/api/state');
  if (sequence !== pollSequence) return;
  const previous = state;
  state = next;
  if (state.access !== 'organizer') invitationBatch = [];
  else invitationBatch = invitationBatch.filter(item => state.admin.participants.some(person => person.id === item.id));
  if (state.participant || state.access === 'locked') selectedProfileId = null;
  else if (selectedProfileId && !state.profiles?.some(profile => profile.id === selectedProfileId && !profile.claimed)) {
    selectedProfileId = null;
    draft = null;
    formDirty = false;
  }
  const changedDraw = previous && previous.game.drawVersion !== state.game.drawVersion;
  if (changedDraw) {
    revealed = false;
    opening = false;
    notify(state.game.phase === 'drawn' ? 'Жеребьёвка проведена! Ваш конверт уже ждёт.' : 'Организатор отменил жеребьёвку. Предыдущее назначение больше не действует.');
  }
  if (state.access !== 'organizer') activeTab = 'member';
  const needsRender = !silent || changedDraw || !previous || JSON.stringify(previous) !== JSON.stringify(next);
  if (needsRender) {
    captureDraft();
    render();
  }
}

function placeholder() {
  return `<div class="photo-placeholder"><svg class="placeholder-sprig" viewBox="0 0 180 160" fill="none" aria-hidden="true"><path d="M32 145C69 107 110 68 145 16" stroke="currentColor" stroke-width="2"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="m52 125-5-40m9 34-1-46m9 39 3-47m3 41 12-46m-5 38 14-42m-7 32 17-40m-10 29 21-37m-13 25 24-34m-15 22 23-29m-16 17 22-26M48 130l40-1m-31-9 43-5m-34-3 44-11m-34 1 43-15m-34 7 45-20m-38 11 45-24m-37 13 40-27m-31 15 34-27m-25 15 30-28"/><path d="M131 29l-2-16m8 9 15-8"/></g><g fill="#a48148"><circle cx="50" cy="90" r="4"/><circle cx="84" cy="128" r="4"/><circle cx="113" cy="69" r="3"/></g><path d="m39 52 2-7 2 7 7 2-7 2-2 7-2-7-7-2 7-2Zm101 62 2-7 2 7 7 2-7 2-2 7-2-7-7-2 7-2Z" fill="#a48148"/></svg><p class="placeholder-title">В кругу<br>самых близких</p><p class="placeholder-note">Наша маленькая традиция</p></div>`;
}

function hero() {
  const member = state.participant;
  const locked = state.access === 'locked';
  return `<section class="hero hero-festive" aria-labelledby="hero-title">
    <div class="hero-copy"><span class="eyebrow eyebrow-dot">Немного волшебства для своих</span><span class="hero-ornament" aria-hidden="true">✧</span>
      <h1 id="hero-title">Семейный<br>Тайный Санта<br><em>— 2027</em></h1>
      <p class="hero-description">Один маленький секрет, много улыбок и подарки, выбранные с теплом. Пусть этот Новый год начнётся с радости.</p>
      <p class="hero-caption">Ведь главное — мы вместе.</p>
      <div class="hero-buttons">${locked ? `<button class="button button-primary" data-action="open-access">У меня есть личная ссылка ${icon('arrow')}</button>` : `<a class="button button-primary" href="${member && !member.ready ? '#participant-form' : '#participation'}">${member?.ready ? 'К моему конверту' : 'Заполнить мою карточку'} ${icon('arrow')}</a>`}</div>
    </div>
    <figure class="hero-visual">${locked ? placeholder() : familyPortrait()}<figcaption><span>${!locked && state.profiles?.length && !member ? 'Нажмите на своего персонажа' : 'Когда вся семья рядом'}</span><span>Ташкент · 2027</span></figcaption><span class="photo-star" aria-hidden="true">✧</span><div class="photo-badge" aria-hidden="true">С ЛЮБОВЬЮ<b>2027</b>ДЛЯ СВОИХ</div></figure>
  </section>
  <div class="occasion-bar" aria-label="Условия игры"><div class="occasion">${icon('gift', 'occasion-icon')}<div><span class="occasion-label">Бюджет на подарок</span><strong>$50–100</strong></div></div><div class="occasion">${icon('calendar', 'occasion-icon')}<div><span class="occasion-label">Заполняем карточки</span><strong>до 25 декабря 2026</strong></div></div><div class="occasion">${icon('heart', 'occasion-icon')}<div><span class="occasion-label">Вручаем подарки</span><strong>1 января 2027</strong></div></div><span class="timezone-note">Все даты по Ташкенту · UTC+5</span></div>${holidayMood()}`;
}

function familyPortrait() {
  const hotspots = (state.profiles || []).map(profile => {
    const [x, y, width, height] = profile.crop;
    const available = !state.participant && !profile.claimed && state.game.registrationOpen;
    const cx = x + width / 2, cy = y + height / 2;
    return `<a href="#participation" class="portrait-hotspot" data-action="select-profile" data-profile="${escape(profile.id)}" aria-label="${escape(profile.name)}${available ? ' — заполнить анкету' : ' — используйте личную ссылку'}" aria-disabled="${!available}" ${available ? '' : 'tabindex="-1"'}><ellipse cx="${cx}" cy="${cy}" rx="${width * .43}" ry="${height * .43}" /><text x="${cx}" y="${cy + height * .34}" text-anchor="middle" class="hotspot-name">${escape(profile.name)}</text><title>${escape(profile.name)}${available ? '' : ': карточка недоступна для выбора'}</title></a>`;
  }).join('');
  return `<div class="family-portrait-map"><img src="/api/photo" alt="Наша семья в новогоднем оформлении" fetchpriority="high" width="1536" height="1024" />${hotspots ? `<svg class="portrait-hotspots" viewBox="0 0 1536 1024" aria-label="Выбор участника на семейном портрете">${hotspots}</svg>` : ''}</div>`;
}

function countdownText() {
  let seconds = Math.max(0, Math.floor((Date.parse(state.game.exchangeAt || '2027-01-01T00:00:00+05:00') - Date.now()) / 1000));
  if (!seconds) return 'С Новым годом! Пора дарить подарки 🎁';
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  return `${days} дн. · ${String(hours).padStart(2, '0')} ч. · ${String(Math.floor(seconds / 60)).padStart(2, '0')} мин. · ${String(seconds % 60).padStart(2, '0')} сек.`;
}

function holidayMood() {
  const readiness = state.game.readiness;
  return `<section class="holiday-mood" aria-label="Ждём семейный праздник"><div><span class="eyebrow">До 1 января · по Ташкенту</span><p id="holiday-countdown" class="holiday-countdown" role="timer">${countdownText()}</p></div>${readiness ? `<div class="family-readiness"><label for="family-progress">Письма отправили <strong>${readiness.ready} из ${readiness.total}</strong></label><progress id="family-progress" value="${readiness.ready}" max="${Math.max(1, readiness.total)}"></progress><p>${readiness.total && readiness.ready === readiness.total ? (state.game.phase === 'drawn' ? 'Все письма доставлены — готовим сюрпризы!' : 'Все письма на месте — ждём жеребьёвку!') : 'Каждое письмо приближает наш праздник.'}</p></div>` : ''}</section>`;
}

const wishPrompts = {
  comfort: { label: 'Для уюта', text: 'Для уюта: например, мягкий плед, красивый светильник или любимый чай.' },
  hobby: { label: 'Для хобби', text: 'Для хобби: например, книга, материалы для творчества или аксессуар для любимого занятия.' },
  experience: { label: 'Впечатления', text: 'Впечатления: например, мастер-класс, билеты на событие или небольшой семейный выход.' },
};
function wishInspiration(disabled) {
  return `<aside class="wish-inspiration"><span class="eyebrow">Если пока нет идеи</span><p>Выберите подсказку и поправьте пример под себя.</p><div class="wish-chips">${Object.entries(wishPrompts).map(([key, prompt]) => `<button type="button" class="wish-chip" data-action="wish-prompt" data-prompt="${key}" ${disabled ? 'disabled' : ''}>${escape(prompt.label)} ＋</button>`).join('')}</div></aside>`;
}

function workshopPanel() {
  if (!state.workshop) return '';
  const labels = { idea: 'Придумал подарок', bought: 'Купил или сделал', wrapped: 'Упаковал' };
  const complete = Object.values(state.workshop).filter(Boolean).length;
  return `<section class="card santa-workshop" aria-labelledby="workshop-title"><span class="eyebrow">Только для вас</span><h3 id="workshop-title">Моя мастерская Санты</h3><p>Маленький план большого сюрприза. Эти отметки видите только вы.</p><div class="workshop-checks">${Object.entries(labels).map(([key, label]) => `<label><input type="checkbox" data-workshop="${key}" ${state.workshop[key] ? 'checked' : ''} /><span>${label}</span></label>`).join('')}</div><p class="workshop-result" role="status">${complete === 3 ? 'Всё готово! Осталось дождаться встречи 🎁' : `Готово ${complete} из 3 — идём к празднику шаг за шагом.`}</p></section>`;
}

function savedLink() {
  if (!personalLink) return '';
  return `<aside class="notice save-link" role="status"><div class="save-icon">${icon('key')}</div><div class="save-content"><div class="save-title"><strong>${escape(personalLink.name ? `Личный доступ: ${personalLink.name}` : 'Сохраните личный доступ')}</strong><button class="icon-button" data-action="dismiss-link" aria-label="Скрыть напоминание">${icon('close')}</button></div><p>Сохраните эту ссылку, чтобы открыть карточку с другого телефона. Она даёт доступ к карточке и секретному получателю — отправляйте её только владельцу.</p><div class="button-stack"><button class="button button-secondary" data-action="share-personal">${icon('share')} Поделиться</button><button class="button button-secondary" data-action="copy-personal">${icon('copy')} Скопировать ссылку</button><button class="button button-quiet" data-action="download-personal">${icon('download')} Скачать ссылку</button></div></div></aside>`;
}

function steps() {
  return `<section class="steps" aria-label="Как всё устроено"><div class="step"><span class="step-number">01</span><h3>Расскажите о желаниях</h3><p>Пара идей поможет вашему Санте выбрать что-то особенное.</p></div><div class="step"><span class="step-number">02</span><h3>Откройте свой конверт</h3><p>После жеребьёвки узнайте, кого вы порадуете в этом году.</p></div><div class="step"><span class="step-number">03</span><h3>Подарите немного счастья</h3><p>Встречаемся 1 января. Имя вашего Санты останется сюрпризом!</p></div></section>`;
}

function portrait(profile, className = 'profile-avatar') {
  if (!profile || !Array.isArray(profile.crop) || profile.crop.length !== 4 || !profile.crop.every(Number.isFinite)) return '';
  return `<svg class="${className}" viewBox="${profile.crop.join(' ')}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Мультяшный портрет: ${escape(profile.name)}"><image href="/api/photo" width="1536" height="1024" /></svg>`;
}

function avatarPanel(profile) {
  if (!profile) return '';
  return `<div class="avatar-panel">${portrait(profile, 'avatar-panel-image')}<div class="avatar-panel-copy"><span class="eyebrow">Ваше новогоднее письмо</span><h3 class="avatar-panel-name">${escape(profile.name)}</h3><p>Ваш мультяшный портрет уже здесь. Осталось рассказать Санте, что вас порадует.</p></div></div>`;
}

function profilePicker() {
  const closed = !state.game.registrationOpen;
  return `<section class="section" id="participation"><div class="section-intro"><div><span class="eyebrow">Каждому — своё маленькое волшебство</span><h2>Найдите себя на семейном портрете</h2><p>Выберите своё имя. Затем откроется письмо Санте с вашим мультяшным портретом.</p></div></div>${closed ? '<div class="notice notice-warning"><strong>Приём новых карточек завершён</strong>Если вы уже участвуете, откройте личную ссылку. Присоединиться поможет организатор.</div>' : ''}<fieldset class="profile-picker"><legend class="profile-picker-title">Кто заполняет карточку?</legend><div class="profile-grid">${state.profiles.map(profile => `<button class="profile-option ${profile.claimed ? 'is-claimed' : ''}" type="button" data-action="select-profile" data-profile="${escape(profile.id)}" aria-pressed="false" ${profile.claimed || closed ? 'disabled' : ''}>${portrait(profile)}<span class="profile-name">${escape(profile.name)}</span><span class="profile-role">${profile.claimed ? 'Карточка уже создана' : 'Написать Санте'}</span></button>`).join('')}</div><p class="profile-return-note">Уже заполняли карточку? Выбор имени не открывает сохранённые пожелания. <button class="text-button" type="button" data-action="open-access">Войти по личной ссылке</button></p></fieldset></section>${steps()}`;
}

function fields(member, disabled) {
  const chosen = member?.profile || state.profiles?.find(profile => profile.id === selectedProfileId);
  const values = draft || member || (chosen ? { name: chosen.name } : {});
  const linksText = values.linksText ?? (values.links || []).join('\n');
  const nameFixed = Boolean(chosen) || Boolean(member && state.game.phase === 'drawn');
  return `<div class="field"><label for="member-name">Как вас зовут <span>обязательно</span></label><input id="member-name" name="name" maxlength="60" autocomplete="nickname" placeholder="Имя, по которому вас узнает семья" value="${escape(values.name)}" required ${disabled ? 'disabled' : ''} ${nameFixed ? 'readonly aria-describedby="name-fixed-hint"' : ''} />${nameFixed ? `<p class="field-hint" id="name-fixed-hint">${chosen ? 'Имя связано с выбранным семейным портретом.' : 'После жеребьёвки имя изменить нельзя.'}</p>` : ''}</div>
    <div class="field"><label for="member-wishes">Чему вы будете рады?</label><textarea id="member-wishes" name="wishes" maxlength="2000" rows="4" placeholder="Мечта, любимое увлечение или несколько идей для подарка…" ${disabled ? 'disabled' : ''}>${escape(values.wishes)}</textarea><p class="field-hint">Можно написать несколько вариантов — так сюрприз сохранится.</p></div>
    <div class="field"><label for="member-avoid">Что лучше не дарить?</label><textarea class="short" id="member-avoid" name="avoid" maxlength="1000" rows="2" placeholder="Например, сладости или косметику с ароматом" ${disabled ? 'disabled' : ''}>${escape(values.avoid)}</textarea></div>
    <div class="field"><label for="member-links">Ссылки на подарки <span>по желанию</span></label><textarea class="links-input" id="member-links" name="links" rows="2" maxlength="10240" spellcheck="false" placeholder="https://…" ${disabled ? 'disabled' : ''}>${escape(linksText)}</textarea><p class="field-hint">До 5 ссылок, каждая с новой строки. Начните с https:// или http://.</p></div>`;
}

function participantForm(member = null) {
  const allowed = state.game.registrationOpen || (Boolean(member) && state.game.editingOpen);
  const profile = member?.profile || state.profiles?.find(profile => profile.id === selectedProfileId);
  return `<form id="participant-form"><div class="letter-header"><div><span class="letter-kicker">Семейная почта · Новый год 2027</span><h3 class="letter-title">Письмо моему Тайному Санте</h3></div><span class="letter-stamp ${member?.ready ? 'is-delivered' : ''} ${letterJustSent ? 'stamp-just-sent' : ''}" aria-hidden="true">${member?.ready ? '✓' : '✧'}<small>${member?.ready ? 'ДОСТАВЛЕНО' : 'С ЛЮБОВЬЮ'}</small></span></div>${avatarPanel(profile)}<p class="letter-salutation">Дорогой Тайный Санта!</p>${wishInspiration(!allowed)}${fields(member, !allowed)}${member?.ready ? '<p class="letter-received">✓ Письмо доставлено Санте.</p>' : ''}<p class="letter-signature">С теплом и в ожидании маленького чуда${profile ? `, ${escape(profile.name)}` : ''}.</p><p class="form-error" id="participant-error" role="alert"></p><div class="form-bottom"><p>${allowed ? 'Пожелания увидят ваш Санта и организатор.' : 'Сейчас изменение карточек закрыто. Обратитесь к организатору.'}</p><button class="button button-primary" type="submit" ${allowed ? '' : 'disabled'}>${member?.ready ? `${icon('check')} Сохранить изменения` : `Отправить моё письмо ${icon('arrow')}`}</button></div></form>`;
}

function registration() {
  if (state.access === 'locked') return `<section class="welcome-panel"><div><div class="lock-symbol">${icon('lock')}</div><h2>Праздник для самых близких</h2><p>Для участия откройте приглашение из семейной группы. Если вы уже заполняли карточку, войдите по сохранённой личной ссылке.</p></div><button class="button button-secondary" data-action="open-access">Открыть мою ссылку ${icon('arrow')}</button></section>${steps()}`;
  if (state.profiles?.length && !selectedProfileId) return profilePicker();
  const chosen = state.profiles?.find(profile => profile.id === selectedProfileId);
  const closed = !state.game.registrationOpen;
  return `<section class="section" id="participation"><div class="section-intro"><div><span class="eyebrow">Пожелания отправляются прямо к волшебству</span><h2>${chosen ? `Новогоднее письмо: ${escape(chosen.name)}` : 'Ваше письмо Санте'}</h2><p>Пара идей поможет выбрать подарок с теплом.</p></div>${chosen ? '<button class="text-button" type="button" data-action="change-profile">← Выбрать другого участника</button>' : ''}</div>${closed ? '<div class="notice notice-warning"><strong>Приём новых карточек завершён</strong>Организатор может помочь вам присоединиться к игре.</div>' : ''}<div class="registration-layout"><div class="card letter-card">${participantForm()}</div><aside class="aside-note"><span class="aside-star" aria-hidden="true">✧</span><span class="eyebrow">Маленькая подсказка</span><h3>Хороший подарок начинается с идеи</h3><p>Напишите, что делает вас счастливее: уютные вечера, книги, путешествия или новое увлечение.</p><p>Не обязательно выбирать точный подарок. Оставьте вашему Санте немного места для волшебства.</p><hr class="tiny-rule"><p class="note-footer">Подарок на $50–100<br>Карточки заполняем до 25 декабря включительно.</p></aside></div></section>`;
}

function envelopeCard() {
  const drawn = state.game.phase === 'drawn';
  const member = state.participant;
  const needsCard = !member.ready && !drawn;
  const canFillCard = state.game.registrationOpen || state.game.editingOpen;
  let title = 'Ваш секрет ещё впереди';
  let text = member.approved ? 'Организатор проведёт жеребьёвку, и здесь появится имя того, кому вы подарите немного радости.' : 'Ваша карточка сохранена. Организатор подтвердит участие, а затем проведёт жеребьёвку.';
  if (needsCard) { title = 'Напишите ваше письмо Санте'; text = canFillCard ? 'Личное приглашение готово. Заполните пожелания и отправьте письмо, чтобы ваша карточка была готова к жеребьёвке.' : 'Анкета ещё не заполнена, а изменение карточек закрыто. Обратитесь к организатору, чтобы заполнить пожелания.'; }
  else if (drawn && state.recipient) { title = 'Кого вы порадуете?'; text = 'Ваш Санта хранит свой секрет. Пора узнать ваш.'; }
  else if (drawn) { title = 'Жеребьёвка уже прошла'; text = 'Для вашей карточки пока нет назначения. Обратитесь к организатору.'; }
  return `<section class="gift-card ${opening ? 'is-opening' : ''}" aria-label="${needsCard ? 'Заполнение вашей анкеты' : 'Ваш секретный получатель'}"><span class="eyebrow">${needsCard ? 'Осталось заполнить анкету' : drawn && state.recipient ? 'Для вас есть особенное имя' : 'Здесь будет ваше назначение'}</span><span class="gift-star" aria-hidden="true">✧</span><span class="gift-star second" aria-hidden="true">✧</span><div class="envelope" aria-hidden="true"><div class="envelope-body"></div><div class="envelope-flap"></div><div class="envelope-seal">✧</div></div><h3>${title}</h3><p>${text}</p>${needsCard && canFillCard ? `<a class="button button-primary" href="#participant-form">Заполнить пожелания ${icon('arrow')}</a>` : drawn && state.recipient ? `<button class="button button-primary" data-action="reveal" ${opening ? 'disabled' : ''}>${opening ? 'Открываем…' : 'Открыть мой конверт'} ${icon('arrow')}</button>` : ''}</section>`;
}

function recipientCard() {
  const recipient = state.recipient;
  return `<section class="recipient-card" aria-labelledby="recipient-name" tabindex="-1"><span class="eyebrow">Вы — Тайный Санта для</span>${recipient.profile ? portrait(recipient.profile, "avatar-panel-image recipient-portrait") : ""}<h3 class="recipient-name" id="recipient-name">${escape(recipient.name)}</h3><p class="recipient-intro">Пусть ваш подарок станет ещё одной причиной улыбнуться в новом году.</p><div class="recipient-block"><h3>Будет радостью</h3><p class="${recipient.wishes ? '' : 'empty-wish'}">${escape(recipient.wishes || 'Пожеланий пока нет. Самое время придумать добрый сюрприз!')}</p></div>${recipient.avoid ? `<div class="recipient-block"><h3>Лучше не дарить</h3><p>${escape(recipient.avoid)}</p></div>` : ''}${recipient.links?.length ? `<div class="recipient-block"><h3>Идеи подарков</h3><ul class="recipient-links">${recipient.links.map((url, index) => safeLink(url) ? `<li><a href="${escape(safeLink(url))}" target="_blank" rel="noopener noreferrer">Идея ${index + 1} · ${escape(new URL(url).hostname)} ↗</a></li>` : '').join('')}</ul></div>` : ''}<p class="reveal-footer">Секрет между вами и новогодним чудом.</p></section>`;
}

function memberView() {
  const member = state.participant;
  return `<section class="section" id="participation"><div class="member-heading"><div class="member-name"><div class="avatar" aria-hidden="true">${member.profile ? portrait(member.profile, "profile-avatar") : escape(initials(member.name))}</div><div><span class="eyebrow">Ваш уголок волшебства</span><h2>Привет, ${escape(member.name)}!</h2><div class="member-meta"><span class="status-pill ${member.approved ? '' : 'status-pending'}">${member.approved ? 'Участие подтверждено' : 'Ждём подтверждения'}</span><span>${member.ready ? 'Карточка сохранена' : 'Анкета ещё не заполнена'}</span></div></div></div><button class="text-button" data-action="refresh">${icon('refresh')} Обновить</button></div>${savedLink()}<div class="member-grid"><div>${revealed && state.recipient ? recipientCard() : envelopeCard()}${workshopPanel()}<p class="member-note"><strong>Один подарок — одному человеку.</strong> Каждый участник получает подарок от одного Санты. Имена получателей знает организатор.</p></div><div><details class="detail-editor" ${draft?.open || !member.ready ? 'open' : ''}><summary><div><h3>Мои пожелания</h3><p>${!member.ready ? (state.game.registrationOpen || state.game.editingOpen ? 'Заполните пожелания и отправьте письмо Санте' : 'Анкета не заполнена. Обратитесь к организатору') : state.game.registrationOpen || state.game.editingOpen ? 'Посмотреть и изменить карточку' : 'Посмотреть сохранённую карточку'}</p></div></summary><div class="editor-body letter-card">${participantForm(member)}</div></details><p class="member-note">Вручение — <strong>1 января 2027 года</strong>.<br>Бюджет подарка — <strong>$50–100</strong>.</p></div></div></section>`;
}

function participantRow(participant) {
  const drawn = state.game.phase === 'drawn';
  return `<li class="participant-row"><div class="avatar" aria-hidden="true">${participant.profile ? portrait(participant.profile, "profile-avatar") : escape(initials(participant.name))}</div><div class="participant-details"><h3>${escape(participant.name)}${participant.id === state.participant?.id ? ' <span class="field-hint">(вы)</span>' : ''}</h3><div class="participant-badges"><span class="status-pill ${participant.approved ? '' : 'status-pending'}">${participant.approved ? 'Подтверждён' : 'На проверке'}</span><span class="status-pill ${participant.ready ? '' : 'status-pending'}">${participant.ready ? 'Карточка готова' : 'Ждём карточку'}</span></div><details class="participant-more"><summary>Пожелания участника</summary><p><strong>Хочет:</strong> ${escape(participant.wishes || 'Пока не указано')}</p>${participant.avoid ? `<p><strong>Не дарить:</strong> ${escape(participant.avoid)}</p>` : ''}${participant.links?.map((url, index) => safeLink(url) ? `<p><a href="${escape(safeLink(url))}" target="_blank" rel="noopener noreferrer">Идея подарка ${index + 1} ↗</a></p>` : '').join('') || ''}</details></div><div class="participant-actions">${!drawn && !participant.approved ? `<button class="button button-secondary" data-action="approve" data-id="${escape(participant.id)}">Подтвердить</button>` : ''}<button class="button button-secondary button-small new-personal-link" data-action="rotate-personal" data-id="${escape(participant.id)}" title="Выдать новую личную ссылку" aria-label="Выдать новую личную ссылку: ${escape(participant.name)}">${icon('key')}<span>Новая ссылка</span></button>${!drawn ? `<button class="icon-button danger" data-action="remove" data-id="${escape(participant.id)}" title="Удалить участника" aria-label="Удалить участника: ${escape(participant.name)}">${icon('trash')}</button>` : ''}</div></li>`;
}

function rememberInvitation(person) {
  invitationBatch = [...invitationBatch.filter(item => item.id !== person.id), person];
}
function invitationMessage(person) {
  return person.name + ', привет! 🎄 Приглашаю в наш семейный «Тайный Санта — 2027».\nЗаполни пожелания до 25 декабря. Бюджет подарка — $50–100, встречаемся 1 января.\nТвоя личная ссылка: ' + person.personalUrl + '\nСохрани её: после жеребьёвки здесь появится твой получатель.';
}
function downloadInvitations() {
  if (!invitationBatch.length) return;
  const text = 'ЛИЧНЫЕ ПРИГЛАШЕНИЯ — только для организатора. Каждому отправляйте только его сообщение.\n\n' + invitationBatch.map(invitationMessage).join('\n\n──────────\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = 'Тайный-Санта-личные-приглашения.txt'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function personalInvitations() {
  if (state.access !== 'organizer' || !state.profiles?.length) return '';
  const drawn = state.game.phase === 'drawn';
  const missing = state.profiles.filter(profile => !profile.claimed).length;
  const tiles = state.profiles.map(profile => {
    const prepared = invitationBatch.find(person => person.profileId === profile.id);
    let controls = '<span class="invitation-status">Карточка уже создана</span>';
    if (prepared) controls = '<p class="invitation-caption">Личное приглашение готово к отправке</p><button class="button button-secondary button-small" data-action="copy-invite-message" data-id="' + escape(prepared.id) + '">Скопировать сообщение</button>';
    else if (!profile.claimed && !drawn) controls = '<button class="button button-secondary button-small" data-action="invite-profile" data-profile="' + escape(profile.id) + '">Создать личную ссылку</button>';
    else if (!profile.claimed) controls = '<span class="invitation-caption">Не участвует в текущей игре</span>';
    return '<li class="personal-invitation ' + (profile.claimed ? 'invitation-prepared' : '') + '"><div class="invitation-person"><div class="avatar">' + portrait(profile) + '</div><h3 class="invitation-name">' + escape(profile.name) + '</h3></div>' + controls + '</li>';
  }).join('');
  return '<section class="card personal-invitations" id="personal-invitations" aria-labelledby="personal-invitations-title"><div class="card-topline"><h2 id="personal-invitations-title">Личные приглашения</h2><span class="eyebrow">Каждому — своё письмо</span></div><p class="card-description">Подготовьте недостающие приглашения одним нажатием. Готовый текст с личной ссылкой можно скопировать отдельно для каждого. Отправляете сообщения вы сами.</p><div class="invitation-tools"><button class="button button-primary" data-action="prepare-invitations" ' + (drawn || !missing ? 'disabled' : '') + '>Подготовить все приглашения' + (missing ? ' (' + missing + ')' : '') + '</button>' + (invitationBatch.length ? '<button class="button button-secondary" data-action="download-invitations">Скачать подготовленные (' + invitationBatch.length + ')</button>' : '') + '</div>' + (drawn ? '<p class="notice">Состав игры зафиксирован жеребьёвкой. Новую ссылку действующему участнику можно выдать в списке ниже.</p>' : '') + '<ul class="personal-invitation-grid">' + tiles + '</ul><p class="admin-footnote">Скачайте подготовленные сообщения до закрытия страницы: ссылки хранятся здесь только в текущем сеансе. Уже созданные карточки и ссылки не заменяются. Для потерянной ссылки используйте «Новая ссылка» в списке участников.</p></section>';
}

function adminView() {
  const people = state.admin.participants;
  const approved = people.filter(person => person.approved).length;
  const ready = people.filter(person => person.ready).length;
  const drawn = state.game.phase === 'drawn';
  const canDraw = people.length >= 2 && approved === people.length && ready === people.length;
  const cutoffPassed = Date.now() >= Date.parse(state.game.deadline);
  return `<section class="admin-intro"><span class="eyebrow">Всё для семейного праздника</span><h1>Кабинет организатора</h1><p>Приглашайте близких, проверяйте карточки и запускайте новогоднее волшебство.</p></section>${savedLink()}<div class="admin-stats"><div class="stat"><strong>${people.length}</strong><span>участников<br>в семейной игре</span></div><div class="stat"><strong>${approved}</strong><span>участие<br>подтверждено</span></div><div class="stat"><strong>${ready}</strong><span>карточек<br>готово к жеребьёвке</span></div></div>${personalInvitations()}<div class="admin-layout"><section class="card admin-card"><div class="card-topline"><h2>Наша семья</h2><button class="text-button" data-action="refresh" aria-label="Обновить список участников">${icon('refresh')} Обновить</button></div>${people.length ? `<ul class="participant-list">${people.map(participantRow).join('')}</ul>` : '<div class="empty-state"><span class="empty-icon" aria-hidden="true">✧</span>Здесь пока тихо.<br>Отправьте общую ссылку в семейную группу.</div>'}${!drawn ? '<details class="add-person"><summary>＋ Добавить участника вручную</summary><form id="add-person-form"><label class="sr-only" for="add-name">Имя участника</label><input id="add-name" name="name" maxlength="60" placeholder="Имя участника" required /><button class="button button-primary button-small" type="submit">Добавить</button><p class="form-error" id="add-person-error" role="alert"></p></form><p class="field-hint">После добавления передайте человеку личную ссылку для заполнения карточки.</p></details>' : '<p class="admin-footnote">Чтобы изменить состав участников, сначала отмените жеребьёвку.</p>'}</section><aside class="admin-side"><section class="card"><span class="eyebrow">Вся семья по одной ссылке</span><h3 class="invite-heading">Пригласим близких</h3><p class="card-description">Отправьте общее приглашение в семейную группу. Каждый заполнит свою карточку и получит личный доступ.</p><button class="button button-secondary button-full" data-action="copy-invitation">${icon('copy')} Скопировать приглашение</button><p class="admin-footnote">Не отправляйте в группу ссылку организатора или чью-либо личную ссылку.</p></section><section class="card"><div class="card-topline"><h3 class="game-heading">Ход игры</h3><span class="status-pill ${drawn ? '' : state.game.registrationOpen ? '' : 'status-closed'}">${drawn ? 'Имена назначены' : state.game.registrationOpen ? 'Приём открыт' : 'Приём закрыт'}</span></div>${drawn ? '<p class="card-description">Конверты готовы. Участники уже могут открыть своих получателей.</p>' : `<p class="card-description">Для жеребьёвки нужны хотя бы два участника. Подтвердите всех и дождитесь готовых карточек.</p><button class="button button-primary button-full" data-action="draw" ${canDraw ? '' : 'disabled'}>${icon('gift')} Провести жеребьёвку</button>${!canDraw ? `<p class="admin-footnote">${people.length < 2 ? 'Пригласите ещё участников.' : `${people.length - approved ? `Ожидают подтверждения: ${people.length - approved}. ` : ''}${people.length - ready ? `Не заполнили карточку: ${people.length - ready}.` : ''}`}</p>` : ''}`}<div class="action-group"><h4>Приём новых карточек</h4><p>До 25 декабря включительно, по времени Ташкента. Приём можно закончить раньше.</p>${!drawn ? `<button class="button button-quiet button-full" data-action="${state.game.registrationOpen ? 'close-registration' : 'open-registration'}" ${!state.game.registrationOpen && cutoffPassed ? 'disabled' : ''}>${state.game.registrationOpen ? 'Закрыть приём карточек' : cutoffPassed ? 'Срок приёма завершён' : 'Открыть приём карточек'}</button>` : '<p>Завершён после жеребьёвки.</p>'}</div><div class="action-group"><label class="toggle-label"><input id="editing-toggle" type="checkbox" data-action="set-editing" ${state.game.editingOpen ? 'checked' : ''} /><span>Разрешить менять пожелания после закрытия приёма</span></label></div>${drawn ? '<div class="action-group"><h4>Изменить состав или назначения</h4><p>Отмена аннулирует все выданные конверты. После изменений потребуется новая жеребьёвка.</p><button class="button button-quiet button-full" data-action="reset">Отменить жеребьёвку</button></div>' : ''}</section></aside></div>${drawn ? `<section class="section assignments-section"><div class="section-intro"><div><span class="eyebrow">Только для организатора</span><h2>Кто кого порадует</h2><p>Каждый дарит один подарок и получает один подарок.</p></div></div>${state.admin.assignments.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">Тайный Санта</th><th aria-label="дарит" class="arrow-cell">→</th><th scope="col">Получатель</th></tr></thead><tbody>${state.admin.assignments.map(pair => `<tr><td>${escape(pair.giverName)}</td><td class="arrow-cell" aria-hidden="true">→</td><td>${escape(pair.recipientName)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="admin-info">Назначения пока не появились. Обновите страницу.</p>'}</section>` : '<div class="section"></div>'}`;
}

function renderNavigation() {
  navigation.innerHTML = state.access === 'organizer' ? `<button class="nav-button ${activeTab === 'member' ? 'active' : ''}" data-tab="member">Моя карточка</button><button class="nav-button ${activeTab === 'admin' ? 'active' : ''}" data-tab="admin">Организатор</button><button class="nav-button nav-exit" data-action="logout" aria-label="Выйти"><span>Выйти</span>${icon('exit', 'mobile-exit')}</button>` : state.access === 'participant' || state.access === 'invited' ? `<span class="nav-label">Семейный круг</span><button class="nav-button nav-exit" data-action="logout" aria-label="Выйти"><span>Выйти</span>${icon('exit', 'mobile-exit')}</button>` : '<span class="nav-label">Только для своих</span>';
  if (state.access !== 'organizer') navigation.innerHTML += '<button class="nav-button" data-action="open-organizer">Организатор</button>';
}

function openAccess(organizer = false) {
  organizerLogin = organizer;
  document.querySelector('#access-error').textContent = '';
  document.querySelector('#access-title').textContent = organizer ? 'Вход организатора' : 'Ваш маленький секрет';
  document.querySelector('#access-description').textContent = organizer
    ? 'Вставьте вашу личную ссылку организатора из чата. После входа вы получите полное управление игрой; браузер запомнит доступ на 30 дней.'
    : 'Вставьте приглашение или личную ссылку, которую вы сохранили раньше.';
  document.querySelector('#access-dialog').showModal();
}

function openOrganizer() {
  if (state.access === 'organizer') {
    captureDraft(); activeTab = 'admin'; render();
  } else openAccess(true);
}

function render() {
  renderNavigation();
  main.innerHTML = state.access === 'organizer' && activeTab === 'admin' ? adminView() : `${hero()}${initialError ? `<div class="notice notice-warning" role="alert"><strong>Не удалось открыть ссылку</strong>${escape(initialError)}</div>` : ''}${!state.participant ? savedLink() : ''}${state.participant ? memberView() : registration()}`;
  const image = main.querySelector('.hero-visual img');
  if (image) image.addEventListener('error', () => { (image.closest('.family-portrait-map') || image).outerHTML = placeholder(); }, { once: true });
}

async function copy(value, success) {
  if (!value) throw new Error('Ссылка пока недоступна. Обновите страницу.');
  try { await navigator.clipboard.writeText(value); }
  catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.className = 'clipboard-input';
    input.setAttribute('aria-hidden', 'true');
    document.body.append(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) throw new Error('Браузер не разрешил копирование. Скачайте личную ссылку файлом.');
  }
  notify(success);
}

async function sharePersonal() {
  if (!personalLink?.url) throw new Error('Ссылка пока недоступна. Создайте личное приглашение или выдайте новую ссылку.');
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title: 'Семейный Тайный Санта — 2027',
        text: `${personalLink.name ? `${personalLink.name}, это` : 'Это'} ваше личное письмо Тайному Санте. Заполните пожелания до 25 декабря и сохраните ссылку: позже здесь появится ваш секретный получатель.`,
        url: personalLink.url,
      });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  await copy(personalLink.url, 'Личная ссылка скопирована. Отправьте её только владельцу карточки.');
}

function downloadPersonal() {
  if (!personalLink) return;
  const text = `Семейный Тайный Санта — 2027\n${personalLink.name ? `Личная карточка: ${personalLink.name}\n` : ''}\n${personalLink.url}\n\nХраните ссылку у себя: по ней можно открыть вашу карточку и секретного получателя.\nВручение подарков: 1 января 2027 года. Бюджет: $50–100.\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'Тайный-Санта-2027-личная-ссылка.txt';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  notify('Файл с личной ссылкой сохранён.');
}

async function adminAction(action, id, extra = {}) {
  const data = await post('/api/admin/action', { action, ...(id ? { id } : {}), ...extra });
  if (data.personalUrl) {
    const person = state.admin.participants.find(person => person.id === id);
    personalLink = { url: data.personalUrl, name: person?.name || '' };
    if (person) rememberInvitation({ id: person.id, profileId: person.profileId, name: person.name, personalUrl: data.personalUrl });
  }
  await refresh();
  return data;
}

document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action],button[data-tab],a[data-action]');
  if (button?.matches('a[data-action]')) event.preventDefault();
  if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true' || busy) return;
  if (button.dataset.tab) {
    captureDraft();
    activeTab = button.dataset.tab;
    render();
    return;
  }
  const action = button.dataset.action;
  if (action === 'wish-prompt') {
    const textarea = document.querySelector('#member-wishes');
    const prompt = wishPrompts[button.dataset.prompt];
    if (!textarea || textarea.disabled || !prompt) return;
    if (!textarea.value.includes(prompt.text)) {
      const value = [textarea.value.trim(), prompt.text].filter(Boolean).join('\n');
      if (value.length > textarea.maxLength) { notify('Сократите пожелания перед добавлением примера.', true); return; }
      textarea.value = value; formDirty = true;
    }
    textarea.focus(); textarea.scrollIntoView({ block: 'center', behavior: 'smooth' }); return;
  }
  if (action === 'prepare-invitations') {
    if (state.access !== 'organizer' || state.game.phase === 'drawn') return;
    const missing = state.profiles.filter(profile => !profile.claimed).length;
    if (!missing || !await ask('Подготовить все приглашения?', 'Создадим ' + missing + ' пустых карточек. Действующие ссылки сохранятся. Сообщения никому не отправляются.', 'Подготовить')) return;
    await task(button, async () => {
      const data = await post('/api/admin/invitations', {});
      data.invitations.forEach(rememberInvitation);
      await refresh(); notify('Приглашения готовы. Скопируйте сообщения по одному или скачайте файл.');
    }); return;
  }
  if (action === 'copy-invite-message') {
    const person = invitationBatch.find(item => item.id === button.dataset.id);
    if (person) await task(button, () => copy(invitationMessage(person), 'Личное приглашение скопировано.'));
    return;
  }
  if (action === 'download-invitations') { downloadInvitations(); return; }
  if (action === 'toggle-motion') {
    motionPaused = !motionPaused;
    try { localStorage.setItem('santa-motion-paused', String(motionPaused)); } catch {}
    applyMotionPreference();
    return;
  }
  if (action === 'select-profile') {
    const profile = state.profiles?.find(profile => profile.id === button.dataset.profile && !profile.claimed);
    if (!profile || state.participant || !state.game.registrationOpen) return;
    if (selectedProfileId !== profile.id && formDirty && !await ask('Открыть другое письмо?', 'Несохранённые пожелания будут удалены.', 'Открыть')) return;
    selectedProfileId = profile.id;
    draft = null;
    formDirty = false;
    render();
    document.querySelector('#participation')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    document.querySelector('.avatar-panel-name')?.setAttribute('tabindex', '-1');
    document.querySelector('.avatar-panel-name')?.focus({ preventScroll: true });
    return;
  }
  if (action === 'change-profile') {
    if (formDirty && !await ask('Выбрать другого участника?', 'Несохранённые пожелания будут удалены. Для выбранного участника откроется пустое письмо.', 'Выбрать другого')) return;
    selectedProfileId = null;
    draft = null;
    formDirty = false;
    render();
    document.querySelector('#participation')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  if (action === 'open-access') { openAccess(); return; }
  if (action === 'open-organizer') { openOrganizer(); return; }
  if (action === 'close-access') { document.querySelector('#access-dialog').close(); return; }
  if (action === 'dismiss-link') {
    personalLink = null;
    captureDraft();
    render();
    return;
  }
  if (action === 'download-personal') { downloadPersonal(); return; }
  if (action === 'share-personal') { await task(button, sharePersonal); return; }
  if (action === 'copy-personal') { await task(button, () => copy(personalLink?.url, 'Личная ссылка скопирована. Сохраните её в надёжном месте.')); return; }
  if (action === 'copy-invitation') { await task(button, () => copy(state.admin.invitationUrl, 'Общее приглашение скопировано. Отправьте его в семейную группу.')); return; }
  if (action === 'refresh') { await task(button, async () => { await refresh(); notify('Всё актуально.'); }); return; }
  if (action === 'invite-profile') {
    if (state.access !== 'organizer' || state.game.phase === 'drawn') return;
    const profile = state.profiles?.find(profile => profile.id === button.dataset.profile && !profile.claimed);
    if (!profile) return;
    await task(button, async () => {
      const data = await post('/api/admin/participants', { profileId: profile.id, wishes: '', avoid: '', links: [], ready: false });
      if (data.personalUrl) personalLink = { name: profile.name, url: data.personalUrl };
      await refresh();
      const person = state.admin.participants.find(person => person.profileId === profile.id);
      if (person && data.personalUrl) rememberInvitation({ id: person.id, profileId: profile.id, name: profile.name, personalUrl: data.personalUrl });
      await refresh();
      document.querySelector('.save-link')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      notify('Личное приглашение готово. Отправьте ссылку только этому участнику.');
    });
    return;
  }
  if (action === 'reveal') {
    opening = true;
    captureDraft();
    render();
    setTimeout(() => {
      if (!opening || state.game.phase !== 'drawn') return;
      opening = false;
      revealed = true;
      captureDraft();
      render();
      document.querySelector('.recipient-card')?.focus({ preventScroll: true });
    }, motionPaused || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650);
    return;
  }
  if (action === 'logout') {
    if (!await ask('Завершить сеанс?', 'Убедитесь, что сохранили свою личную ссылку, а если вы организатор — и ссылку организатора. Они понадобятся для следующего входа.', 'Выйти')) return;
    await task(button, async () => {
      await post('/api/logout', {});
      personalLink = null; draft = null; formDirty = false; revealed = false; selectedProfileId = null;
      activeTab = 'member';
      await refresh();
      notify('Вы вышли. До встречи!');
    });
    return;
  }
  const person = state.admin?.participants.find(person => person.id === button.dataset.id);
  if (action === 'remove' && !await ask('Убрать участника?', `${person?.name || 'Участник'} больше не будет участвовать в игре. Его личная ссылка перестанет работать.`, 'Убрать участника', true)) return;
  if (action === 'rotate-personal' && !await ask('Выдать новую ссылку?', `Предыдущая личная ссылка ${person?.name || 'участника'} перестанет работать. Новую ссылку нужно будет передать владельцу карточки.`, 'Выдать ссылку')) return;
  if (action === 'draw' && !await ask('Запускаем волшебство?', `В жеребьёвке участвуют ${state.admin.participants.length} человек. Каждый получит одного получателя. После этого состав игры можно изменить только с отменой всех назначений.`, 'Провести жеребьёвку')) return;
  if (action === 'reset' && !await ask('Аннулировать все назначения?', 'Участники уже могли увидеть своих получателей. Все выданные конверты станут недействительны. Сообщите семье об отмене и после изменений проведите новую жеребьёвку.', 'Аннулировать назначения', true)) return;
  if (action === 'close-registration' && !await ask('Закончить приём карточек?', 'Новые участники не смогут самостоятельно присоединиться. До установленного срока вы сможете снова открыть приём.', 'Закрыть приём')) return;
  if (['approve', 'remove', 'rotate-personal', 'draw', 'reset', 'close-registration', 'open-registration'].includes(action)) {
    await task(button, async () => {
      await adminAction(action, button.dataset.id, action === 'reset' ? { confirm: true } : {});
      const messages = { approve: 'Участие подтверждено.', remove: 'Участник удалён.', 'rotate-personal': 'Новая личная ссылка готова. Сохраните и передайте её участнику.', draw: 'Жеребьёвка проведена. Все конверты готовы!', reset: 'Назначения аннулированы.', 'close-registration': 'Приём новых карточек закрыт.', 'open-registration': 'Приём новых карточек открыт.' };
      notify(messages[action]);
    });
  }
});

document.addEventListener('input', event => {
  if (event.target.closest('#participant-form')) formDirty = true;
});

document.addEventListener('change', async event => {
  if (event.target.matches('input[data-workshop]')) {
    const checkbox = event.target, key = checkbox.dataset.workshop;
    if (busy) { checkbox.checked = Boolean(state.workshop?.[key]); return; }
    const checked = checkbox.checked;
    await task(null, async () => {
      await request('/api/workshop', { method: 'PATCH', body: JSON.stringify({ [key]: checked }) });
      await refresh(); notify('Отметка сохранена только для вас.');
    });
    if (checkbox.isConnected) checkbox.checked = Boolean(state.workshop?.[key]);
    return;
  }
  if (event.target.id !== 'editing-toggle') return;
  const checkbox = event.target;
  if (busy) { checkbox.checked = state.game.editingOpen; return; }
  const enabled = checkbox.checked;
  checkbox.disabled = true;
  await task(null, async () => {
    await adminAction('set-editing', null, { enabled });
    notify(enabled ? 'Изменение пожеланий разрешено.' : 'Изменение пожеланий после закрытия приёма запрещено.');
  });
  if (checkbox.isConnected) { checkbox.checked = state.game.editingOpen; checkbox.disabled = false; }
});

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!['participant-form', 'access-form', 'add-person-form'].includes(form.id)) return;
  event.preventDefault();
  if (busy) return;
  const button = form.querySelector('button[type="submit"]');
  if (form.id === 'participant-form') {
    const error = document.querySelector('#participant-error');
    await task(button, async () => {
      const body = getFormData(form);
      const existing = Boolean(state.participant);
      const data = existing ? await request('/api/me', { method: 'PATCH', body: JSON.stringify(body) }) : await post('/api/participants', body);
      if (data.personalUrl) personalLink = { url: data.personalUrl, name: body.name };
      draft = null; formDirty = false; letterJustSent = true;
      await refresh();
      setTimeout(() => { letterJustSent = false; document.querySelector('.stamp-just-sent')?.classList.remove('stamp-just-sent'); }, 1400);
      document.querySelector('#participation')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      notify(existing ? 'Пожелания сохранены. Ваш Санта увидит обновления.' : 'Карточка готова! Не забудьте сохранить личную ссылку.');
    }, error);
  } else if (form.id === 'access-form') {
    const error = document.querySelector('#access-error');
    await task(button, async () => {
      let url;
      try { url = new URL(new FormData(form).get('url')); } catch { throw new Error('Вставьте полную ссылку, начиная с https:// или http://.'); }
      if (url.origin !== location.origin) throw new Error('Эта ссылка ведёт на другой сайт. Вставьте приглашение для этого сайта.');
      const params = new URLSearchParams(url.hash.slice(1));
      const type = ['invite', 'personal', 'admin'].find(type => params.has(type));
      if (!type || !params.get(type)) throw new Error('В ссылке не найден личный доступ. Скопируйте её целиком.');
      if (organizerLogin && type !== 'admin') throw new Error('Для управления нужна именно личная ссылка организатора из чата.');
      await post('/api/access', { type, token: params.get(type) });
      if (type === 'admin') activeTab = 'admin';
      initialError = ''; personalLink = null; draft = null; formDirty = false; revealed = false; selectedProfileId = null;
      form.reset();
      document.querySelector('#access-dialog').close();
      organizerLogin = false;
      await refresh();
      if (type === 'personal' && state.participant && !state.participant.ready) {
        document.querySelector('.detail-editor')?.scrollIntoView({ block: 'start', behavior: 'instant' });
      }
      notify('Добро пожаловать в семейный круг!');
    }, error);
  } else {
    await task(button, async () => {
      const name = String(new FormData(form).get('name') || '').trim();
      if (!name) throw new Error('Напишите имя участника.');
      const data = await post('/api/admin/participants', { name, wishes: '', avoid: '', links: [], ready: false });
      if (data.personalUrl) personalLink = { url: data.personalUrl, name };
      await refresh();
      document.querySelector('.save-link')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      notify('Участник добавлен. Передайте ему личную ссылку.');
    }, document.querySelector('#add-person-error'));
  }
});

async function start() {
  const params = new URLSearchParams(location.hash.slice(1));
  const type = ['invite', 'personal', 'admin'].find(type => params.has(type));
  const token = type ? params.get(type) : null;
  // Секретная часть ссылки сразу исчезает из адресной строки и истории.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search + (params.has('organizer') ? '#organizer' : ''));
  if (type && token) {
    try {
      await post('/api/access', { type, token });
      if (type === 'admin') activeTab = 'admin';
    } catch (error) { initialError = error.message; }
  }
  try {
    await refresh();
    if (params.has('organizer')) openOrganizer();
    if (type === 'personal' && state.participant && !state.participant.ready) {
      document.querySelector('.detail-editor')?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }
  catch (error) {
    main.innerHTML = `<section class="error-screen"><span class="eyebrow">Небольшая пауза</span><h1>Не удалось открыть праздник</h1><p>${escape(error instanceof TypeError ? 'Проверьте подключение к интернету и попробуйте снова.' : error.message)}</p><button class="button button-primary" id="retry-loading">Попробовать снова ${icon('refresh')}</button></section>`;
    document.querySelector('#retry-loading').addEventListener('click', start, { once: true });
  }
}

setInterval(() => {
  if (state && state.access !== 'locked' && !busy && !document.hidden) refresh({ silent: true }).catch(() => {});
}, 30_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state && state.access !== 'locked' && !busy) refresh({ silent: true }).catch(() => {});
});
window.addEventListener('hashchange', () => {
  const params = new URLSearchParams(location.hash.slice(1));
  if (['invite', 'personal', 'admin', 'organizer'].some(type => params.has(type))) location.reload();
});

start();

setInterval(() => { const timer = document.querySelector('#holiday-countdown'); if (timer && state) timer.textContent = countdownText(); }, 1000);
