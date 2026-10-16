import { audit, nextDocNumber, type Queryable } from '../db.js';
import { fail } from './errors.js';
import { scheduleVisits, defaultContractEnd } from './amc.js';
import { addDays } from './warranty.js';
import { saveInvoice } from './documents.js';
import { createJob, today } from './jobs.js';

export interface ContractIn {
  customer_id: string; billing_mode: 'per_visit' | 'annual'; start_date: string; end_date?: string;
  visits_per_year: number; annual_amount?: number; per_visit_amount?: number; tax_id?: string | null;
  service_item_id?: string | null; serial_ids: string[]; terms?: string | null; renewal_of?: string | null;
}

export async function createContract(c: Queryable, userId: string, input: ContractIn) {
  const end = input.end_date ?? defaultContractEnd(input.start_date);
  if (end < input.start_date) fail(400, 'End date is before start date');
  if (input.billing_mode === 'annual' && !(input.annual_amount && input.annual_amount > 0)) fail(400, 'annual_amount is required for annual billing');
  if (input.billing_mode === 'per_visit' && !(input.per_visit_amount && input.per_visit_amount > 0)) fail(400, 'per_visit_amount is required for per-visit billing');
  if (!input.serial_ids.length) fail(400, 'Select at least one covered unit');
  const number = await nextDocNumber(c, 'amc', 'AMC');
  const r = await c.query<{ id: string }>(
    `insert into amc_contracts (number,customer_id,billing_mode,start_date,end_date,visits_per_year,annual_amount,per_visit_amount,
       tax_id,service_item_id,renewal_of,terms,status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active') returning id`,
    [number, input.customer_id, input.billing_mode, input.start_date, end, input.visits_per_year, input.annual_amount ?? 0,
     input.per_visit_amount ?? 0, input.tax_id ?? null, input.service_item_id ?? null, input.renewal_of ?? null, input.terms ?? null]);
  const id = r.rows[0].id;
  for (const sid of input.serial_ids)
    await c.query('insert into amc_contract_units (contract_id,serial_id) values ($1,$2)', [id, sid]);
  for (const due of scheduleVisits(input.start_date, end, input.visits_per_year))
    await c.query('insert into amc_visits (contract_id,due_date) values ($1,$2)', [id, due]);
  await audit(c, userId, 'amc.create', 'amc_contract', id);
  return { id, number };
}

export async function renewContract(c: Queryable, userId: string, contractId: string) {
  const old = (await c.query('select * from amc_contracts where id=$1 for update', [contractId])).rows[0];
  if (!old) fail(404, 'Contract not found');
  const units = (await c.query('select serial_id from amc_contract_units where contract_id=$1', [contractId])).rows;
  const created = await createContract(c, userId, {
    customer_id: old.customer_id, billing_mode: old.billing_mode, start_date: addDays(old.end_date, 1),
    visits_per_year: old.visits_per_year, annual_amount: old.annual_amount, per_visit_amount: old.per_visit_amount,
    tax_id: old.tax_id, service_item_id: old.service_item_id, serial_ids: units.map((u) => u.serial_id),
    terms: old.terms, renewal_of: old.id });
  await c.query(`update amc_contracts set status='expired' where id=$1 and end_date < current_date`, [contractId]);
  return created;
}

async function serviceInvoice(c: Queryable, userId: string, contract: any, amount: number, note: string) {
  if (!contract.service_item_id) fail(400, 'Set a service item on the contract before invoicing');
  const cust = (await c.query('select gst_treatment, place_of_supply from customers where id=$1', [contract.customer_id])).rows[0];
  return saveInvoice(c, userId, {
    customer_id: contract.customer_id, invoice_date: today(), gst_treatment: cust?.gst_treatment,
    place_of_supply: cust?.place_of_supply, notes: note, source: 'amc',
    lines: [{ item_id: contract.service_item_id, description: note, qty: 1, rate: amount, tax_id: contract.tax_id, skip_stock: true }],
  });
}

/** Annual billing: one draft invoice for the whole contract term. */
export async function createAnnualInvoice(c: Queryable, userId: string, contractId: string) {
  const k = (await c.query('select * from amc_contracts where id=$1 for update', [contractId])).rows[0];
  if (!k) fail(404, 'Contract not found');
  if (k.billing_mode !== 'annual') fail(409, 'Contract is billed per visit');
  if (k.annual_invoice_id) fail(409, 'Annual invoice already created');
  const id = await serviceInvoice(c, userId, k, k.annual_amount, `AMC ${k.number} (${k.start_date} to ${k.end_date})`);
  await c.query('update amc_contracts set annual_invoice_id=$2 where id=$1', [contractId, id]);
  return id;
}

/** Per-visit billing: draft invoice for one completed visit. */
export async function createVisitInvoice(c: Queryable, userId: string, visitId: string) {
  const v = (await c.query('select * from amc_visits where id=$1 for update', [visitId])).rows[0];
  if (!v) fail(404, 'Visit not found');
  if (v.status !== 'done') fail(409, 'Visit is not completed');
  if (v.invoice_id) fail(409, 'Visit already invoiced');
  const k = (await c.query('select * from amc_contracts where id=$1', [v.contract_id])).rows[0];
  if (k.billing_mode !== 'per_visit') fail(409, 'Contract is billed annually');
  const id = await serviceInvoice(c, userId, k, k.per_visit_amount, `AMC ${k.number} visit ${v.due_date}`);
  await c.query('update amc_visits set invoice_id=$2 where id=$1', [visitId, id]);
  return id;
}

export async function createVisitJob(c: Queryable, userId: string, visitId: string) {
  const v = (await c.query('select * from amc_visits where id=$1 for update', [visitId])).rows[0];
  if (!v) fail(404, 'Visit not found');
  if (v.job_id) fail(409, 'Job already created for this visit');
  const k = (await c.query('select * from amc_contracts where id=$1', [v.contract_id])).rows[0];
  const units = (await c.query(
    `select u.serial_id, s.serial_no, i.name from amc_contract_units u join serial_units s on s.id=u.serial_id
       join items i on i.id=s.item_id where u.contract_id=$1`, [v.contract_id])).rows;
  const job = await createJob(c, userId, {
    kind: 'amc_visit', customer_id: k.customer_id, serial_id: units[0]?.serial_id, contract_id: k.id,
    problem: `AMC ${k.number} visit due ${v.due_date}. Units: ${units.map((u) => `${u.name} (${u.serial_no})`).join(', ')}`,
    scheduled_start: `${v.due_date}T09:00:00+05:30`,
  });
  await c.query('update amc_visits set job_id=$2 where id=$1', [visitId, job.id]);
  return job;
}

/** Daily tick: create jobs for visits due soon, and expire finished contracts. */
export async function generateDueVisitJobs(c: Queryable, userId: string, daysAhead = 14) {
  const due = (await c.query(
    `select v.id from amc_visits v join amc_contracts k on k.id=v.contract_id
      where v.status='scheduled' and v.job_id is null and k.status='active' and v.due_date <= current_date + $1::int`,
    [daysAhead])).rows;
  for (const d of due) await createVisitJob(c, userId, d.id);
  await c.query(`update amc_contracts set status='expired' where status='active' and end_date < current_date`);
  return due.length;
}
