import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function appOrigin() {
  const configured = process.env.APP_URL;
  if (process.env.NODE_ENV === 'production' && !configured) {
    throw new Error('Для production задайте APP_URL с публичным HTTPS-адресом сайта.');
  }
  const value = configured || `http://localhost:${process.env.PORT || '3000'}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('APP_URL должен быть корректным origin сайта, например https://santa.example.com.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('APP_URL должен содержать только протокол, домен и необязательный порт, без пути и параметров.');
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('В production APP_URL должен использовать HTTPS.');
  }
  return url.origin;
}

async function main() {
  const origin = appOrigin();
  const filename = resolve(process.env.DATA_DIR || './data', 'access.json');
  let raw;
  try {
    raw = await readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Файл доступа ещё не создан. Сначала запустите приложение командой npm start с тем же DATA_DIR.');
    }
    throw new Error('Не удалось прочитать файл доступа. Проверьте DATA_DIR и права текущего пользователя.');
  }
  let access;
  try {
    access = JSON.parse(raw);
  } catch {
    throw new Error('Файл доступа повреждён. Восстановите его из защищённой резервной копии.');
  }
  if (!access || typeof access.adminToken !== 'string' || !access.adminToken || typeof access.inviteToken !== 'string' || !access.inviteToken) {
    throw new Error('В файле доступа отсутствуют необходимые ключи. Восстановите его из защищённой резервной копии.');
  }
  console.log('Личная ссылка организатора — сохраните её у себя:');
  console.log(`${origin}/#admin=${encodeURIComponent(access.adminToken)}`);
  console.log('\nОбщая ссылка приглашения — отправьте её семье:');
  console.log(`${origin}/#invite=${encodeURIComponent(access.inviteToken)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
