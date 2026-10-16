import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, pool, tx } from '../db.js';
import { actor, ANY, roles } from '../auth.js';
import { fail } from '../lib/errors.js';
import { applyJobOp, createJob, createJobInvoice, overrideCoverage, today } from '../lib/jobs.js';
import { coverageOn } from '../lib/warranty.js';
import { jobOpSchema } from './jobOps.js';

const uuid = z.string().uuid();
const ts = z.string().datetime({ offset: true });

const jobBody = z.object({
  kind: z.enum(['installation', 'repair', 'amc_visit', 'inspection', 'warranty_claim']),
  customer_id: uuid.optional(), serial_id: uuid.nullable().optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  site_address: z.string().nullable().optional(), contact_name: z.string().nullable().optional(), contact_phone: z.string().nullable().optional(),
  problem: z.string().nullable().optional(), scheduled_start: ts.nullable().optional(), scheduled_end: ts.nullable().optional(),
  assigned_to: uuid.nullable().optional(), sla_due_at: ts.nullable().optional(),
});

export default async function jobs(app: FastifyInstance) {
  app.get('/api/jobs', { preHandler: roles(...ANY) }, async (req) => {
    const q = z.object({ status: z.string().optional(), assigned_to: uuid.optional(), q: z.string().optional(),
      open: z.coerce.boolean().optional(), limit: z.coerce.number().max(500).default(200) }).parse(req.query);
    const me = actor(req);
    const mine = me.role === 'technician' ? me.id : q.assigned_to ?? null; // technicians only ever see their own
    return (await pool.query(
      `select j.id,j.number,j.kind,j.status,j.priority,j.coverage,j.problem,j.scheduled_start,j.sla_due_at,j.assigned_to,
              c.name as customer, c.phone as customer_phone, u.name as technician, s.serial_no, i.name as item_name,
              (j.sla_due_at is not null and j.sla_due_at < now() and j.status in ('new','scheduled','in_progress','on_hold')) as sla_breached
         from service_jobs j join customers c on c.id=j.customer_id left join users u on u.id=j.assigned_to
         left join serial_units s on s.id=j.serial_id left join items i on i.id=s.item_id
        where ($1::text is null or j.status=$1) and ($2::uuid is null or j.assigned_to=$2)
          and ($3::boolean is not true or j.status in ('new','scheduled','in_progress','on_hold'))
          and ($4::text is null or lower(c.name) like $4 or lower(j.number) like $4 or lower(s.serial_no) like $4)
        order by case j.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, j.scheduled_start nulls last, j.created_at desc
        limit $5`,
      [q.status ?? null, mine, q.open ?? null, q.q ? `%${q.q.toLowerCase()}%` : null, q.limit])).rows;
  });

  app.get('/api/jobs/:id', { preHandler: roles(...ANY) }, async (req) => {
    const id = (req.params as any).id;
    const me = actor(req);
    const j = (await pool.query(
      `select j.*, c.name as customer, c.phone as customer_phone, u.name as technician, s.serial_no, i.name as item_name, i.sku,
              si.number as invoice_number, k.number as contract_number
         from service_jobs j join customers c on c.id=j.customer_id left join users u on u.id=j.assigned_to
         left join serial_units s on s.id=j.serial_id left join items i on i.id=s.item_id
         left join sales_invoices si on si.id=j.invoice_id left join amc_contracts k on k.id=j.contract_id where j.id=$1`, [id])).rows[0];
    if (!j) fail(404, 'Job not found');
    if (me.role === 'technician' && j.assigned_to !== me.id) fail(403, 'This job is not assigned to you');
    const warranty = j.serial_id
      ? (await pool.query(`select * from warranties where serial_id=$1 and status='active' order by start_date desc limit 1`, [j.serial_id])).rows[0] : null;
    const [parts, checklist, events, files] = await Promise.all([
      pool.query(`select p.*, i.name as item_name, i.sku, s.serial_no from job_parts p join items i on i.id=p.item_id left join serial_units s on s.id=p.serial_id where job_id=$1 order by p.created_at`, [id]),
      pool.query('select id,label,done,done_at from job_checklist_items where job_id=$1 order by sort', [id]),
      pool.query(`select e.at,e.kind,e.payload,u.name as actor from job_events e left join users u on u.id=e.actor where job_id=$1 order by e.at, e.id`, [id]),
      pool.query(`select id,filename,mime,kind from attachments where owner_type='service_job' and owner_id=$1 order by created_at`, [id]),
    ]);
    return { ...j, warranty: warranty ? { ...warranty, coverage: coverageOn(warranty, today()) } : null,
      parts: parts.rows, checklist: checklist.rows, events: events.rows, attachments: files.rows };
  });

  app.post('/api/jobs', { preHandler: roles('supervisor', 'accountant', 'sales') }, async (req) =>
    tx((c) => createJob(c, actor(req).id, jobBody.parse(req.body))));

  app.patch('/api/jobs/:id', { preHandler: roles('supervisor') }, async (req) => {
    const b = z.object({
      assigned_to: uuid.nullable().optional(), scheduled_start: ts.nullable().optional(), scheduled_end: ts.nullable().optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), site_address: z.string().nullable().optional(),
      contact_name: z.string().nullable().optional(), contact_phone: z.string().nullable().optional(), problem: z.string().nullable().optional(),
      sla_due_at: ts.nullable().optional(), labour_rate_per_hr: z.number().min(0).optional(), travel_charge: z.number().min(0).optional(),
      vendor_recovery: z.boolean().optional(),
    }).parse(req.body);
    const id = (req.params as any).id;
    const has = (k: keyof typeof b) => b[k] !== undefined;
    const r = await pool.query(
      `update service_jobs set
         assigned_to=case when $2::boolean then $3 else assigned_to end,
         scheduled_start=case when $4::boolean then $5 else scheduled_start end,
         scheduled_end=case when $6::boolean then $7 else scheduled_end end,
         priority=coalesce($8,priority), site_address=case when $9::boolean then $10 else site_address end,
         contact_name=case when $11::boolean then $12 else contact_name end, contact_phone=case when $13::boolean then $14 else contact_phone end,
         problem=case when $15::boolean then $16 else problem end, sla_due_at=case when $17::boolean then $18 else sla_due_at end,
         labour_rate_per_hr=coalesce($19,labour_rate_per_hr), travel_charge=coalesce($20,travel_charge),
         vendor_recovery=coalesce($21,vendor_recovery), updated_at=now()
       where id=$1 and status not in ('invoiced','closed','cancelled') returning id, status, assigned_to, scheduled_start`,
      [id, has('assigned_to'), b.assigned_to ?? null, has('scheduled_start'), b.scheduled_start ?? null, has('scheduled_end'), b.scheduled_end ?? null,
       b.priority ?? null, has('site_address'), b.site_address ?? null, has('contact_name'), b.contact_name ?? null,
       has('contact_phone'), b.contact_phone ?? null, has('problem'), b.problem ?? null, has('sla_due_at'), b.sla_due_at ?? null,
       b.labour_rate_per_hr ?? null, b.travel_charge ?? null, b.vendor_recovery ?? null]);
    const j = r.rows[0];
    if (!j) fail(409, 'Job not found or already invoiced/closed');
    if (j.status === 'new' && j.assigned_to && j.scheduled_start)
      await pool.query(`update service_jobs set status='scheduled' where id=$1`, [id]);
    await pool.query(`insert into job_events (job_id,actor,kind,payload) values ($1,$2,'updated',$3)`, [id, actor(req).id, JSON.stringify(b)]);
    return { ok: true };
  });

  app.post('/api/jobs/:id/coverage', { preHandler: roles('supervisor') }, async (req) => {
    const b = z.object({ coverage: z.enum(['in_warranty', 'out_of_warranty', 'goodwill', 'amc']), reason: z.string().default('') }).parse(req.body);
    return tx(async (c) => { await overrideCoverage(c, actor(req), (req.params as any).id, b.coverage, b.reason); return { ok: true }; });
  });

  // Online counterpart of the offline queue: same validation, same code path.
  app.post('/api/jobs/:id/ops', { preHandler: roles(...ANY) }, async (req) => {
    const op = jobOpSchema.parse(req.body);
    return tx((c) => applyJobOp(c, actor(req), (req.params as any).id, op));
  });

  app.post('/api/jobs/:id/invoice', { preHandler: roles('supervisor', 'accountant') }, async (req) =>
    tx(async (c) => ({ invoice_id: await createJobInvoice(c, actor(req).id, (req.params as any).id) })));

  app.post('/api/jobs/:id/close', { preHandler: roles('supervisor') }, async (req) => {
    const id = (req.params as any).id;
    const j = (await pool.query('select status, coverage from service_jobs where id=$1', [id])).rows[0];
    if (!j) fail(404, 'Job not found');
    if (!['completed', 'invoiced'].includes(j.status)) fail(409, 'Only completed jobs can be closed');
    if (j.status === 'completed' && j.coverage === 'out_of_warranty')
      fail(409, 'This is a chargeable job: create the invoice before closing');
    await pool.query(`update service_jobs set status='closed', updated_at=now() where id=$1`, [id]);
    await audit(pool, actor(req).id, 'job.close', 'service_job', id);
    return { ok: true };
  });

  app.post('/api/jobs/:id/cancel', { preHandler: roles('supervisor') }, async (req) => {
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
    const id = (req.params as any).id;
    const r = await pool.query(`update service_jobs set status='cancelled', updated_at=now() where id=$1 and status in ('new','scheduled','on_hold') returning id`, [id]);
    if (!r.rowCount) fail(409, 'Only jobs that have not started can be cancelled');
    await pool.query(`insert into job_events (job_id,actor,kind,payload) values ($1,$2,'cancelled',$3)`, [id, actor(req).id, JSON.stringify({ reason })]);
    return { ok: true };
  });
}
