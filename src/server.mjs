import { createApp } from './app.mjs';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть числом от 1 до 65535.');
const app = createApp({ dataDir: process.env.DATA_DIR ?? './data', appUrl: process.env.APP_URL, production: process.env.NODE_ENV === 'production' });
app.server.listen(port, host, () => {
  console.log(`Тайный Санта: ${process.env.APP_URL ?? `http://localhost:${port}`}`);
  console.log('Для получения приглашения и доступа организатора выполните npm run access.');
});
app.server.on('error', error => { console.error('Не удалось запустить сайт:', error.code ?? error.name); process.exitCode = 1; app.store.close(); });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });
