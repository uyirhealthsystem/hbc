import { env } from './config/env';
import { createApp } from './app';
import { pool } from './db/pool';

const server = createApp().listen(env.PORT, () => {
  console.log(`Home Based Care API listening on http://localhost:${env.PORT}`);
});

function shutdown() {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
