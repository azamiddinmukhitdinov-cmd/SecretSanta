import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateAppUrl } from '../src/app.mjs';

const action = process.argv[2];
if (!['start', 'access'].includes(action)) {
  console.error('Укажите start или access.');
  process.exit(1);
}

try {
  // Both launchers use the same local data and public URL after hosting is set up.
  const dataDir = fileURLToPath(new URL('../data/', import.meta.url));
  let hosting;
  try {
    hosting = JSON.parse(await readFile(new URL('../data/hosting.json', import.meta.url), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  process.env.DATA_DIR ??= dataDir;
  if (hosting !== undefined) {
    if (!hosting || typeof hosting !== 'object' || Array.isArray(hosting) || typeof hosting.appUrl !== 'string' || !hosting.appUrl) {
      throw new Error('Проверьте appUrl в data/hosting.json.');
    }
    const port = hosting.port ?? 3000;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Проверьте port в data/hosting.json.');
    process.env.APP_URL = validateAppUrl(hosting.appUrl, true);
    process.env.PORT = String(port);
    process.env.HOST = '127.0.0.1';
    process.env.NODE_ENV = 'production';
  }
  await import(action === 'start' ? '../src/server.mjs' : './access.mjs');
} catch (error) {
  console.error(`Не удалось выполнить запуск: ${error.message}`);
  process.exitCode = 1;
}
