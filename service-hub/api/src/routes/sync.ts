import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { actor, roles } from '../auth.js';
import { HttpError } from '../lib/errors.js';
import { applyJobOp, today } from '../lib/jobs.js';
import { coverageOn } from '../lib/warranty.js';
import { jobOpSchema } from './jobOps.js';

const pushBody = z.object({
  ops: z.array(z.object({ op_id: z.string().uuid(), job_id: z.string().uuid(), at: z.string().datetime({ offset: true }), op: jobOpSchema })).max(200),
});

export default async function sync(app: FastifyInstance) {
  /** Everything a phone needs to work with no signal: my open jobs, their detail, the parts catalogue. */
  app.get('/api/sync/bootstrap', { preHandler: roles('technician', 'supervisor') }, async (req) => {
    const me = actor(req);
    const jobs = (await pool.query(
      `select j.id,j.number,j.kind,j.status,j.priority,j.coverage,j.problem,j.site_address,j.contact_name,j.contact_phone,
              j.scheduled_start,j.sla_due_at,j.checked_in_at,j.resolution,j.labour_minutes,
              c.name as customer, c.phone as customer_phone, s.id as serial_id, s.serial_no, i.name as item_name, i.brand
         from service_jobs j join customers c on c.id=j.customer_id left join serial_units s on s.id=j.serial_id left join items i on i.id=s.item_id
        where j.assigned_to=$1 and (j.status in ('new','scheduled','in_progress','on_hold')
              or (j.status='completed' and j.updated_at > now() - interval '2 days'))
        order by j.scheduled_start nulls last limit 100`, [me.id])).rows;
    const ids = jobs.map((j) => j.id);
    const [checklist, parts, warranties] = await Promise.all([
      pool.query('select id,job_id,label,done from job_checklist_items where job_id = any($1::uuid[]) order by sort', [ids]),
      pool.query(`select p.id,p.job_id,p.qty,p.chargeable,i.name as item_name from job_parts p join items i on i.id=p.item_id where p.job_id = any($1::uuid[])`, [ids]),
      pool.query(`select distinct on (serial_id) * from warranties where status='active' and serial_id = any($1::uuid[]) order by serial_id, start_date desc`,
        [jobs.map((j) => j.serial_id).filter(Boolean)]),
    ]);
    const wBySerial = new Map(warranties.rows.map((w) => [w.serial_id, { ...w, coverage: coverageOn(w, today()) }]));
    const catalogue = (await pool.query(
      `select id,sku,name,brand,rate,unit,track_mode from items where active and not is_service order by name limit 2000`)).rows;
    return {
      server_time: new Date().toISOString(),
      jobs: jobs.map((j) => ({
        ...j, checklist: checklist.rows.filter((x) => x.job_id === j.id), parts: parts.rows.filter((x) => x.job_id === j.id),
        warranty: j.serial_id ? wBySerial.get(j.serial_id) ?? null : null })),
      catalogue,
    };
  });

  /**
   * Replay queued offline operations in order. Each op is applied in its own transaction and recorded in
   * client_ops, so a retry after a dropped connection never duplicates a part, a check-in or a completion.
   */
  app.post('/api/sync/push', { preHandler: roles('technician', 'supervisor') }, async (req) => {
    const { ops } = pushBody.parse(req.body);
    const me = actor(req);
    const results: { op_id: string; status: 'applied' | 'duplicate' | 'error'; error?: string; retry?: boolean }[] = [];
    for (const o of ops) {
      try {
        const status = await tx(async (c) => {
          const ins = await c.query(
            `insert into client_ops (op_id,user_id,kind) values ($1,$2,$3) on conflict (op_id) do nothing returning op_id`,
            [o.op_id, me.id, o.op.kind]);
          if (!ins.rowCount) return 'duplicate' as const;
          const result = await applyJobOp(c, me, o.job_id, o.op, o.at);
          await c.query('update client_ops set result=$2 where op_id=$1', [o.op_id, JSON.stringify(result ?? {})]);
          return 'applied' as const;
        });
        results.push({ op_id: o.op_id, status });
      } catch (e: any) {
        const http = e instanceof HttpError;
        results.push({ op_id: o.op_id, status: 'error', error: http ? e.message : 'Server error',
          retry: !http || e.status >= 500 || Boolean((e.details as any)?.retry) });
        if (!http) req.log.error(e);
      }
    }
    return { results };
  });
}
