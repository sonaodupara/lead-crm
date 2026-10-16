import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { actor, roles } from '../auth.js';
import { zohoEnabled } from '../config.js';
import { fail } from '../lib/errors.js';
import { audit } from '../db.js';
import { runSyncCycle } from '../zoho/sync.js';
import type { ZohoApi } from '../zoho/client.js';

export default async function zoho(app: FastifyInstance, opts: { api: ZohoApi | null }) {
  app.get('/api/zoho/status', { preHandler: roles('accountant') }, async () => {
    const state = (await pool.query('select entity,last_synced_at,last_error from zoho_sync_state order by entity')).rows;
    const outbox = (await pool.query(`select status, count(*)::int as n from zoho_outbox group by status`)).rows;
    const failures = (await pool.query(
      `select id,entity_type,entity_id,attempts,last_error,created_at from zoho_outbox where status='failed' order by id desc limit 50`)).rows;
    const docs = (await pool.query(
      `select 'invoice' as kind, sync_status, count(*)::int as n from sales_invoices where status<>'draft' group by sync_status
       union all select 'bill', sync_status, count(*)::int from purchase_bills where status<>'draft' group by sync_status`)).rows;
    return { enabled: zohoEnabled && Boolean(opts.api), state, outbox, failures, documents: docs };
  });

  app.post('/api/zoho/sync', { preHandler: roles('accountant') }, async (req) => {
    if (!opts.api) fail(409, 'Zoho is not configured on this server (see docs/ZOHO.md)');
    const r = await runSyncCycle(opts.api!);
    await audit(pool, actor(req).id, 'zoho.sync_now');
    return r;
  });

  app.post('/api/zoho/outbox/:id/retry', { preHandler: roles('accountant') }, async (req) => {
    const r = await pool.query(
      `update zoho_outbox set status='pending', attempts=0, next_attempt_at=now(), last_error=null where id=$1 and status='failed' returning entity_type, entity_id`,
      [(req.params as any).id]);
    if (!r.rowCount) fail(404, 'No failed item with that id');
    const { entity_type, entity_id } = r.rows[0];
    const table = entity_type === 'sales_invoice' ? 'sales_invoices' : entity_type === 'purchase_bill' ? 'purchase_bills' : null;
    if (table) await pool.query(`update ${table} set sync_status='pending' where id=$1`, [entity_id]);
    return { ok: true };
  });
}
