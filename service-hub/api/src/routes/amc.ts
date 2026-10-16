import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { actor, roles } from '../auth.js';
import { fail } from '../lib/errors.js';
import { createAnnualInvoice, createContract, createVisitInvoice, createVisitJob, generateDueVisitJobs, renewContract } from '../lib/amcService.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export default async function amc(app: FastifyInstance) {
  const OFFICE = roles('supervisor', 'accountant');

  app.get('/api/amc', { preHandler: OFFICE }, async (req) => {
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    return (await pool.query(
      `select k.id,k.number,k.status,k.billing_mode,k.start_date,k.end_date,k.visits_per_year,k.annual_amount,k.per_visit_amount,
              c.name as customer, (select count(*) from amc_contract_units u where u.contract_id=k.id)::int as units,
              (select count(*) from amc_visits v where v.contract_id=k.id and v.status='done')::int as visits_done,
              (select count(*) from amc_visits v where v.contract_id=k.id)::int as visits_total
         from amc_contracts k join customers c on c.id=k.customer_id
        where ($1::text is null or k.status=$1) order by k.end_date limit 300`, [status ?? null])).rows;
  });

  app.get('/api/amc/:id', { preHandler: OFFICE }, async (req) => {
    const id = (req.params as any).id;
    const k = (await pool.query(`select k.*, c.name as customer from amc_contracts k join customers c on c.id=k.customer_id where k.id=$1`, [id])).rows[0];
    if (!k) fail(404, 'Contract not found');
    const units = (await pool.query(
      `select s.id as serial_id, s.serial_no, i.name as item_name from amc_contract_units u join serial_units s on s.id=u.serial_id
         join items i on i.id=s.item_id where u.contract_id=$1 order by i.name`, [id])).rows;
    const visits = (await pool.query(
      `select v.*, j.number as job_number, j.status as job_status, si.number as invoice_number
         from amc_visits v left join service_jobs j on j.id=v.job_id left join sales_invoices si on si.id=v.invoice_id
        where v.contract_id=$1 order by v.due_date`, [id])).rows;
    return { ...k, units, visits };
  });

  app.post('/api/amc', { preHandler: OFFICE }, async (req) => {
    const b = z.object({
      customer_id: uuid, billing_mode: z.enum(['per_visit', 'annual']), start_date: date, end_date: date.optional(),
      visits_per_year: z.number().int().min(1).max(52), annual_amount: z.number().min(0).optional(), per_visit_amount: z.number().min(0).optional(),
      tax_id: uuid.nullable().optional(), service_item_id: uuid.nullable().optional(), serial_ids: z.array(uuid).min(1),
      terms: z.string().nullable().optional(),
    }).parse(req.body);
    return tx((c) => createContract(c, actor(req).id, b));
  });

  app.post('/api/amc/:id/renew', { preHandler: OFFICE }, async (req) => tx((c) => renewContract(c, actor(req).id, (req.params as any).id)));
  app.post('/api/amc/:id/invoice', { preHandler: roles('accountant') }, async (req) =>
    tx(async (c) => ({ invoice_id: await createAnnualInvoice(c, actor(req).id, (req.params as any).id) })));
  app.post('/api/amc/:id/cancel', { preHandler: roles('supervisor') }, async (req) => {
    await pool.query(`update amc_contracts set status='cancelled' where id=$1 and status in ('draft','active')`, [(req.params as any).id]);
    await pool.query(`update amc_visits set status='skipped' where contract_id=$1 and status='scheduled' and job_id is null`, [(req.params as any).id]);
    return { ok: true };
  });

  app.post('/api/amc/visits/:id/job', { preHandler: roles('supervisor') }, async (req) =>
    tx((c) => createVisitJob(c, actor(req).id, (req.params as any).id)));
  app.post('/api/amc/visits/:id/invoice', { preHandler: roles('accountant') }, async (req) =>
    tx(async (c) => ({ invoice_id: await createVisitInvoice(c, actor(req).id, (req.params as any).id) })));
  app.post('/api/amc/generate-due-jobs', { preHandler: roles('supervisor') }, async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(0).max(90).default(14) }).parse(req.query);
    return tx(async (c) => ({ created: await generateDueVisitJobs(c, actor(req).id, days) }));
  });
}
