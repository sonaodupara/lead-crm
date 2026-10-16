import pg from 'pg';
import { config } from './config.js';

// date -> 'YYYY-MM-DD' string, numeric -> number, bigint -> number
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => parseFloat(v));
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export type Queryable = {
  query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number | null }>;
};

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

export async function tx<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Next number for a document series, e.g. INV-000001. Call inside a transaction. */
export async function nextDocNumber(c: Queryable, name: string, prefix: string, pad = 6): Promise<string> {
  const { rows } = await c.query<{ n: number }>(
    `insert into doc_counters (name, next_val) values ($1, 2)
     on conflict (name) do update set next_val = doc_counters.next_val + 1
     returning next_val - 1 as n`,
    [name],
  );
  return `${prefix}-${String(rows[0].n).padStart(pad, '0')}`;
}

export async function audit(
  c: Queryable,
  actor: string | null,
  action: string,
  entityType?: string,
  entityId?: string,
  detail?: unknown,
) {
  await c.query(
    `insert into audit_log (actor, action, entity_type, entity_id, detail) values ($1,$2,$3,$4,$5)`,
    [actor, action, entityType ?? null, entityId ?? null, detail ? JSON.stringify(detail) : null],
  );
}
