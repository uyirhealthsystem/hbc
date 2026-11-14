import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { env } from '../config/env';

// Return NUMERIC as JS number (prices fit comfortably in a double).
types.setTypeParser(types.builtins.NUMERIC, (v) => parseFloat(v));

export const pool = new Pool({ connectionString: env.DATABASE_URL });

export type Queryable = Pick<Pool | PoolClient, 'query'>;

export async function query<T extends QueryResultRow>(text: string, params: unknown[] = [], db: Queryable = pool) {
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
