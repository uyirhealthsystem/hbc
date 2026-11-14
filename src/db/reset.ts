// Dev-only: drop the database (closing any open connections), recreate it, and run all migrations.
import { Client } from 'pg';
import { env } from '../config/env';
import { migrate } from './migrate';
import { pool } from './pool';

async function reset() {
  if (env.NODE_ENV === 'production') throw new Error('db:reset refuses to run with NODE_ENV=production');

  const url = new URL(env.DATABASE_URL);
  const dbName = decodeURIComponent(url.pathname.slice(1));
  if (!dbName) throw new Error('DATABASE_URL has no database name');
  const ident = `"${dbName.replace(/"/g, '""')}"`;

  // Connect to the maintenance DB, since you can't drop the DB you're connected to.
  url.pathname = '/postgres';
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    // WITH (FORCE) terminates other sessions (e.g. a running dev server) instead of waiting on them.
    await admin.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${ident}`);
    console.log(`recreated database ${dbName}`);
  } finally {
    await admin.end();
  }

  await migrate();
}

reset()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
