import nodemailer from 'nodemailer';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './store.mjs';

const hosts = { gmail: 'smtp.gmail.com', yandex: 'smtp.yandex.ru', mailru: 'smtp.mail.ru' };

export async function createMail(store, { appUrl, clock = () => new Date(), transportFactory = nodemailer.createTransport } = {}) {
  const path = join(store.dataDir, 'mail.json');
  let config = null, transport = null, running = null, configurationError = false;
  const makeTransport = value => transportFactory({ host: hosts[value.provider], port: 465, secure: true, auth: { user: value.from, pass: value.password }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, disableFileAccess: true, disableUrlAccess: true });
  try {
    config = JSON.parse(await readFile(path, 'utf8'));
    if (!Object.hasOwn(hosts, config.provider) || !config.from || !config.password) throw new Error('Invalid mail configuration');
    transport = makeTransport(config);
  } catch (error) {
    config = null; transport = null;
    configurationError = error.code !== 'ENOENT';
  }
  const status = () => ({ configured: Boolean(transport), configurationError, provider: config?.provider || 'gmail', from: config?.from || '' });
  const save = async input => {
    const provider = input.provider, from = typeof input.from === 'string' ? input.from.trim().toLowerCase() : '';
    if (!Object.hasOwn(hosts, provider) || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from) || from.length > 254) throw new AppError(400, 'Выберите почтовый сервис и укажите адрес отправителя.');
    let password = input.password || (config?.provider === provider && config?.from === from ? config.password : '');
    if (provider === 'gmail' && typeof password === 'string') password = password.replace(/\s/g, '');
    if (typeof password !== 'string' || password.length < 8 || password.length > 200 || /[\r\n]/.test(password)) throw new AppError(400, 'Введите пароль приложения от почтового сервиса.');
    const next = { provider, from, password }, candidate = makeTransport(next);
    try { await candidate.verify(); }
    catch { candidate.close(); throw new AppError(400, 'Не удалось подключить почту. Проверьте адрес и пароль приложения; для Gmail нужна двухэтапная аутентификация.'); }
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(temporary, path);
    transport?.close(); config = next; transport = candidate; configurationError = false;
    store.queueVerifications(clock());
    return status();
  };
  const deliver = async () => {
    if (!transport || !appUrl) return;
    for (const job of store.pendingMail(clock())) {
      if (!store.pendingMail(clock()).some(current => current.id === job.id)) continue;
      const url = job.kind === 'verify' ? `${appUrl}/#verify-email=${job.verification_token}` : appUrl;
      const subject = job.kind === 'verify' ? 'Подтвердите почту для семейного Тайного Санты' : job.kind === 'gift' ? 'Ваш Тайный Санта выбрал подарок 🎁' : 'Ваш получатель определился с пожеланиями ✨';
      const message = job.kind === 'verify' ? 'Вы указали эту почту в семейном Тайном Санте. Подтвердите адрес по ссылке ниже в течение 24 часов. Если это были не вы, просто проигнорируйте письмо.' : job.kind === 'gift' ? 'Ваш Тайный Санта подтвердил, что определился с подарком для вас! Имя и подарок останутся сюрпризом до встречи.' : 'Ваш получатель заполнил или изменил пожелания. Откройте сайт по своей сохранённой личной ссылке и посмотрите актуальное письмо.';
      try {
        await transport.sendMail({ from: { name: 'Семейный Тайный Санта', address: config.from }, to: job.email, subject, text: `${message}\n\n${url}\n\nУведомления можно отключить в своей личной карточке на сайте.`, messageId: `<${job.id}@secret-santa.local>`, disableFileAccess: true, disableUrlAccess: true });
        store.finishMail(job.id, clock(), true);
      } catch { store.finishMail(job.id, clock(), false); }
    }
  };
  return { status, save, flush() { if (!running) running = deliver().finally(() => { running = null; }); return running; }, async close() { if (running) await running; transport?.close(); } };
}
