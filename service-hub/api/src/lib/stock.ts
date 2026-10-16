import type { Queryable } from '../db.js';

export interface Movement {
  item_id: string;
  batch_id?: string | null;
  serial_id?: string | null;
  location_id: string;
  qty: number; // positive = in, negative = out
  kind:
    | 'opening' | 'purchase' | 'sale' | 'job_issue' | 'job_return'
    | 'adjustment' | 'transfer_in' | 'transfer_out' | 'sale_return';
  ref_type?: string | null;
  ref_id?: string | null;
  note?: string | null;
  created_by?: string | null;
}

export async function addMovement(c: Queryable, m: Movement) {
  await c.query(
    `insert into stock_movements (item_id,batch_id,serial_id,location_id,qty,kind,ref_type,ref_id,note,created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [m.item_id, m.batch_id ?? null, m.serial_id ?? null, m.location_id, m.qty, m.kind,
     m.ref_type ?? null, m.ref_id ?? null, m.note ?? null, m.created_by ?? null],
  );
}

export async function onHand(
  c: Queryable,
  a: { item_id: string; location_id?: string | null; batch_id?: string | null },
): Promise<number> {
  const { rows } = await c.query<{ q: number }>(
    `select coalesce(sum(qty),0) as q from stock_movements
      where item_id=$1 and ($2::uuid is null or location_id=$2) and ($3::uuid is null or batch_id=$3)`,
    [a.item_id, a.location_id ?? null, a.batch_id ?? null],
  );
  return rows[0].q;
}

let cachedDefault: string | null = null;
export async function defaultLocationId(c: Queryable): Promise<string> {
  if (cachedDefault) return cachedDefault;
  const { rows } = await c.query<{ id: string }>(
    `select id from locations where active and kind='store' order by name limit 1`,
  );
  if (!rows[0]) throw new Error('No store location configured');
  cachedDefault = rows[0].id;
  return cachedDefault;
}
export const resetLocationCache = () => { cachedDefault = null; };
