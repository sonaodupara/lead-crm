import type { Queryable } from '../db.js';

export type OutboxEntity = 'sales_invoice' | 'purchase_bill' | 'warranty' | 'item_fields';

/** Queue a push to Zoho. Idempotent per (entity, id, version) so retries never double-post. */
export async function enqueueZoho(c: Queryable, entity: OutboxEntity, id: string, version = 'v1') {
  await c.query(
    `insert into zoho_outbox (entity_type, entity_id, idempotency_key)
     values ($1,$2,$3) on conflict (idempotency_key) do nothing`,
    [entity, id, `${entity}:${id}:${version}`],
  );
  const table = entity === 'sales_invoice' ? 'sales_invoices' : entity === 'purchase_bill' ? 'purchase_bills' : null;
  if (table) await c.query(`update ${table} set sync_status='pending', updated_at=now() where id=$1 and sync_status<>'synced'`, [id]);
}
