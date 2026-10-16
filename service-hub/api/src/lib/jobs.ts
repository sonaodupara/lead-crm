import { audit, nextDocNumber, type Queryable } from '../db.js';
import { fail } from './errors.js';
import { addMovement, defaultLocationId, onHand } from './stock.js';
import { coverageOn } from './warranty.js';
import { saveInvoice } from './documents.js';

export type Role = 'owner' | 'supervisor' | 'accountant' | 'technician' | 'sales';
export interface Actor { id: string; role: Role }

export const today = () => new Date().toISOString().slice(0, 10);

export interface CoverageSuggestion {
  coverage: 'in_warranty' | 'out_of_warranty' | 'amc';
  warranty_id: string | null;
  contract_id: string | null;
  reason: string;
}

/** Suggest who pays for a job. A supervisor may override with a reason (see overrideCoverage). */
export async function suggestCoverage(
  c: Queryable, a: { serial_id?: string | null; kind: string; on?: string; contract_id?: string | null },
): Promise<CoverageSuggestion> {
  const on = a.on ?? today();
  if (a.contract_id) return { coverage: 'amc', warranty_id: null, contract_id: a.contract_id, reason: 'AMC visit' };
  if (!a.serial_id) return { coverage: 'out_of_warranty', warranty_id: null, contract_id: null, reason: 'No unit selected' };

  const amc = (await c.query(
    `select c.id from amc_contracts c join amc_contract_units u on u.contract_id=c.id
      where u.serial_id=$1 and c.status='active' and $2 between c.start_date and c.end_date limit 1`,
    [a.serial_id, on])).rows[0];
  if (amc) return { coverage: 'amc', warranty_id: null, contract_id: amc.id, reason: 'Unit is under an active AMC' };

  const w = (await c.query(
    `select * from warranties where serial_id=$1 and status='active' order by start_date desc limit 1`,
    [a.serial_id])).rows[0];
  if (!w) return { coverage: 'out_of_warranty', warranty_id: null, contract_id: null, reason: 'No warranty on record' };
  const cov = coverageOn(w, on);
  return cov.in_warranty
    ? { coverage: 'in_warranty', warranty_id: w.id, contract_id: null, reason: `Warranty active until ${cov.ends_on}` }
    : { coverage: 'out_of_warranty', warranty_id: w.id, contract_id: null, reason: `Warranty expired ${cov.ends_on}` };
}

export interface JobIn {
  kind: 'installation' | 'repair' | 'amc_visit' | 'inspection' | 'warranty_claim';
  customer_id?: string; serial_id?: string | null; priority?: 'low' | 'normal' | 'high' | 'urgent';
  site_address?: string | null; contact_name?: string | null; contact_phone?: string | null; problem?: string | null;
  scheduled_start?: string | null; scheduled_end?: string | null; assigned_to?: string | null;
  sla_due_at?: string | null; contract_id?: string | null;
}

export async function createJob(c: Queryable, userId: string, input: JobIn) {
  let customerId = input.customer_id ?? null;
  if (input.serial_id) {
    const s = (await c.query('select customer_id from serial_units where id=$1', [input.serial_id])).rows[0];
    if (!s) fail(400, 'Unknown serial');
    customerId = customerId ?? s.customer_id;
  }
  if (!customerId) fail(400, 'customer_id is required when the unit has no customer on record');
  const sug = await suggestCoverage(c, { serial_id: input.serial_id, kind: input.kind, contract_id: input.contract_id });
  const number = await nextDocNumber(c, 'job', 'JOB');
  const status = input.assigned_to && input.scheduled_start ? 'scheduled' : 'new';
  const r = await c.query<{ id: string }>(
    `insert into service_jobs (number,kind,status,priority,customer_id,serial_id,warranty_id,contract_id,site_address,
       contact_name,contact_phone,problem,scheduled_start,scheduled_end,assigned_to,sla_due_at,coverage,coverage_suggested,created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18) returning id`,
    [number, input.kind, status, input.priority ?? 'normal', customerId, input.serial_id ?? null, sug.warranty_id, sug.contract_id,
     input.site_address ?? null, input.contact_name ?? null, input.contact_phone ?? null, input.problem ?? null,
     input.scheduled_start ?? null, input.scheduled_end ?? null, input.assigned_to ?? null, input.sla_due_at ?? null,
     sug.coverage, userId]);
  const id = r.rows[0].id;
  const tpl = (await c.query('select items from checklist_templates where kind=$1', [input.kind])).rows[0];
  let sort = 0;
  for (const label of (tpl?.items ?? []) as string[])
    await c.query('insert into job_checklist_items (job_id,label,sort) values ($1,$2,$3)', [id, label, sort++]);
  await c.query(`insert into job_events (job_id,actor,kind,payload) values ($1,$2,'created',$3)`,
    [id, userId, JSON.stringify({ coverage: sug.coverage, reason: sug.reason })]);
  await audit(c, userId, 'job.create', 'service_job', id);
  return { id, number, coverage: sug.coverage, reason: sug.reason };
}

export async function overrideCoverage(
  c: Queryable, actor: Actor, jobId: string, coverage: 'in_warranty' | 'out_of_warranty' | 'goodwill' | 'amc', reason: string,
) {
  if (!['owner', 'supervisor'].includes(actor.role)) fail(403, 'Only a supervisor or owner can change coverage');
  const job = (await c.query('select * from service_jobs where id=$1 for update', [jobId])).rows[0];
  if (!job) fail(404, 'Job not found');
  if (['invoiced', 'closed', 'cancelled'].includes(job.status)) fail(409, `Job is ${job.status}`);
  if (coverage !== job.coverage_suggested && !reason.trim()) fail(400, 'A reason is required when overriding the suggested coverage');
  await c.query(
    `update service_jobs set coverage=$2, coverage_override_reason=$3, coverage_set_by=$4, updated_at=now() where id=$1`,
    [jobId, coverage, coverage === job.coverage_suggested ? null : reason, actor.id]);
  await c.query(`insert into job_events (job_id,actor,kind,payload) values ($1,$2,'coverage',$3)`,
    [jobId, actor.id, JSON.stringify({ from: job.coverage, to: coverage, reason })]);
  await audit(c, actor.id, 'job.coverage', 'service_job', jobId, { from: job.coverage, to: coverage, reason });
}

// ───────────────────────── job operations (shared by online routes and offline sync) ─────────────────────────
export type JobOp =
  | { kind: 'checkin'; lat?: number; lng?: number }
  | { kind: 'checkout' }
  | { kind: 'note'; text: string }
  | { kind: 'checklist'; item_id: string; done: boolean }
  | { kind: 'add_part'; item_id: string; qty: number; batch_id?: string | null; serial_id?: string | null;
      location_id?: string | null; part_id?: string }
  | { kind: 'complete'; resolution: string; labour_minutes?: number; signed_by_name?: string; signature_client_id?: string };

export async function applyJobOp(c: Queryable, actor: Actor, jobId: string, op: JobOp, at?: string) {
  const job = (await c.query('select * from service_jobs where id=$1 for update', [jobId])).rows[0];
  if (!job) fail(404, 'Job not found');
  if (actor.role === 'technician' && job.assigned_to !== actor.id) fail(403, 'This job is not assigned to you');
  if (!['owner', 'supervisor', 'technician'].includes(actor.role)) fail(403, 'Not allowed');
  if (['invoiced', 'closed', 'cancelled'].includes(job.status) && op.kind !== 'note')
    fail(409, `Job is ${job.status}`);
  const when = at ?? new Date().toISOString();
  const event = (kind: string, payload: object = {}) =>
    c.query('insert into job_events (job_id,at,actor,kind,payload) values ($1,$2,$3,$4,$5)', [jobId, when, actor.id, kind, JSON.stringify(payload)]);

  switch (op.kind) {
    case 'checkin': {
      await c.query(
        `update service_jobs set status='in_progress', checked_in_at=coalesce(checked_in_at,$2), checkin_lat=$3, checkin_lng=$4, updated_at=now() where id=$1`,
        [jobId, when, op.lat ?? null, op.lng ?? null]);
      await event('checkin', { lat: op.lat, lng: op.lng });
      return {};
    }
    case 'checkout': {
      await c.query(`update service_jobs set checked_out_at=$2, updated_at=now() where id=$1`, [jobId, when]);
      await event('checkout');
      return {};
    }
    case 'note': {
      if (!op.text.trim()) fail(400, 'Note is empty');
      await event('note', { text: op.text });
      return {};
    }
    case 'checklist': {
      const r = await c.query(
        `update job_checklist_items set done=$3, done_at=case when $3 then $4::timestamptz else null end where id=$2 and job_id=$1`,
        [jobId, op.item_id, op.done, when]);
      if (!r.rowCount) fail(404, 'Checklist item not found');
      await event('checklist', { item_id: op.item_id, done: op.done });
      return {};
    }
    case 'add_part': {
      if (!(op.qty > 0)) fail(400, 'Quantity must be positive');
      const item = (await c.query('select * from items where id=$1', [op.item_id])).rows[0];
      if (!item) fail(404, 'Item not found');
      const loc = op.location_id ?? (await defaultLocationId(c));
      if (op.serial_id) {
        const s = (await c.query('select * from serial_units where id=$1 for update', [op.serial_id])).rows[0];
        if (!s || s.item_id !== op.item_id) fail(400, 'Invalid serial for this part');
        if (s.status !== 'in_stock') fail(409, `Serial ${s.serial_no} is ${s.status}`);
        if (op.qty !== 1) fail(400, 'A serial-tracked part is issued one unit at a time');
        await c.query(`update serial_units set status='sold', customer_id=$2, sold_on=$3 where id=$1`,
          [op.serial_id, job.customer_id, when.slice(0, 10)]);
      }
      const have = await onHand(c, { item_id: op.item_id, location_id: loc, batch_id: op.batch_id });
      // Never block a technician on site: record the use and flag the shortfall for the supervisor.
      const chargeable = job.coverage === 'out_of_warranty';
      await c.query(
        `insert into job_parts (id,job_id,item_id,batch_id,serial_id,qty,unit_price,chargeable,location_id,added_by)
         values (coalesce($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [op.part_id ?? null, jobId, op.item_id, op.batch_id ?? null, op.serial_id ?? null, op.qty, item.rate, chargeable, loc, actor.id]);
      await addMovement(c, { item_id: op.item_id, batch_id: op.batch_id, serial_id: op.serial_id, location_id: loc,
        qty: -op.qty, kind: 'job_issue', ref_type: 'service_job', ref_id: jobId, created_by: actor.id });
      await event('part', { item: item.name, qty: op.qty, chargeable });
      if (have < op.qty) await event('stock_shortfall', { item: item.name, had: have, used: op.qty });
      return { shortfall: have < op.qty };
    }
    case 'complete': {
      if (!op.resolution?.trim()) fail(400, 'Resolution is required');
      if (!job.checked_in_at && actor.role === 'technician') fail(409, 'Check in before completing the job');
      let sigId: string | null = null;
      if (op.signature_client_id) {
        const a = (await c.query('select id from attachments where client_id=$1', [op.signature_client_id])).rows[0];
        if (!a) fail(409, 'Signature has not been uploaded yet', { retry: true });
        sigId = a.id;
      }
      const minutes = op.labour_minutes ??
        (job.checked_in_at ? Math.max(0, Math.round((new Date(when).getTime() - new Date(job.checked_in_at).getTime()) / 60000)) : 0);
      await c.query(
        `update service_jobs set status='completed', resolution=$2, labour_minutes=$3, signed_by_name=$4,
           signed_at=case when $4::text is not null then $5::timestamptz end, signature_attachment_id=$6,
           checked_out_at=coalesce(checked_out_at,$5), updated_at=now() where id=$1`,
        [jobId, op.resolution, minutes, op.signed_by_name ?? null, when, sigId]);
      await event('completed', { minutes, signed_by: op.signed_by_name ?? null });
      if (job.kind === 'amc_visit')
        await c.query(`update amc_visits set status='done' where job_id=$1`, [jobId]);
      return {};
    }
  }
}

/** Draft invoice for a completed, chargeable job: parts + labour + travel. Stock was already issued on the job. */
export async function createJobInvoice(c: Queryable, userId: string, jobId: string) {
  const job = (await c.query('select * from service_jobs where id=$1 for update', [jobId])).rows[0];
  if (!job) fail(404, 'Job not found');
  if (job.invoice_id) fail(409, 'Job already has an invoice');
  if (!['completed', 'closed'].includes(job.status)) fail(409, 'Complete the job before invoicing');
  if (job.coverage !== 'out_of_warranty') fail(409, `No customer charge: job is ${job.coverage}`);

  const parts = (await c.query(
    `select p.*, i.tax_id, i.name from job_parts p join items i on i.id=p.item_id where p.job_id=$1 and p.chargeable`, [jobId])).rows;
  const billing = (await c.query(`select value from settings where key='job_billing'`)).rows[0]?.value ?? {};
  const lines: any[] = parts.map((p) => ({
    item_id: p.item_id, description: p.name, qty: p.qty, rate: p.unit_price, tax_id: p.tax_id,
    batch_id: p.batch_id, serial_ids: p.serial_id ? [p.serial_id] : [], skip_stock: true,
  }));
  const hours = Math.round((job.labour_minutes / 60) * 100) / 100;
  const addService = async (itemId: string | undefined, label: string, qty: number, rate: number) => {
    if (!(qty > 0 && rate > 0)) return;
    if (!itemId) fail(400, `Set the ${label} service item in Settings (job_billing) before invoicing`);
    const it = (await c.query('select name, tax_id from items where id=$1', [itemId])).rows[0];
    if (!it) fail(400, `${label} service item not found`);
    lines.push({ item_id: itemId, description: `${label} – ${job.number}`, qty, rate, tax_id: it.tax_id, skip_stock: true });
  };
  await addService(billing.labour_item_id, 'Service labour', hours, job.labour_rate_per_hr);
  await addService(billing.travel_item_id, 'Travel', 1, job.travel_charge);
  if (!lines.length) fail(409, 'Nothing to invoice: no chargeable parts, labour or travel on this job');

  const cust = (await c.query('select gst_treatment, place_of_supply from customers where id=$1', [job.customer_id])).rows[0];
  const invoiceId = await saveInvoice(c, userId, {
    customer_id: job.customer_id, invoice_date: today(), gst_treatment: cust?.gst_treatment,
    place_of_supply: cust?.place_of_supply, notes: `Service job ${job.number}`, source: 'service_job', lines,
  });
  await c.query(`update service_jobs set invoice_id=$2, status='invoiced', updated_at=now() where id=$1`, [jobId, invoiceId]);
  await c.query(`insert into job_events (job_id,actor,kind,payload) values ($1,$2,'invoiced',$3)`, [jobId, userId, JSON.stringify({ invoice_id: invoiceId })]);
  return invoiceId;
}
