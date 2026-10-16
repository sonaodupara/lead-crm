import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { seedBase } from '../src/seed.js';
import { buildApp } from '../src/server.js';
import type { ZohoApi } from '../src/zoho/client.js';
import { processOutbox, pullContacts, pullItems, pullTaxes } from '../src/zoho/sync.js';
import { addMonths, endDate } from '../src/lib/warranty.js';
import { today } from '../src/lib/jobs.js';
import { randomUUID } from 'node:crypto';

const run = Boolean(process.env.TEST_DATABASE_URL);

class FakeZoho implements ZohoApi {
  invoices: any[] = []; bills: any[] = [];
  async listTaxes() { return []; }
  async listContacts() { return { rows: [], hasMore: false }; }
  async listItems() { return { rows: [], hasMore: false }; }
  async getItem() { return {}; }
  async getItems(ids: string[]) { return Promise.all(ids.map((id) => this.getItem(id))); }
  async updateItemCustomFields() {}
  async findInvoiceByReference(ref: string) { return this.invoices.find((i) => i.reference_number === ref) ?? null; }
  async createInvoice(p: any) { const o = { ...p, invoice_id: `ZI${this.invoices.length + 1}`, invoice_number: `INV-Z${this.invoices.length + 1}`, status: 'draft', total: 0 }; this.invoices.push(o); return o; }
  async getInvoice(id: string) { return this.invoices.find((i) => i.invoice_id === id); }
  async findBillByReference(ref: string) { return this.bills.find((b) => b.reference_number === ref) ?? null; }
  async createBill(p: any) { const o = { ...p, bill_id: `ZB${this.bills.length + 1}`, status: 'draft', total: 0 }; this.bills.push(o); return o; }
  async getBill(id: string) { return this.bills.find((b) => b.bill_id === id); }
}

describe.skipIf(!run)('Service Hub end-to-end', () => {
  let app: FastifyInstance;
  const zoho = new FakeZoho();
  const tok: Record<string, string> = {};
  const ids: Record<string, any> = {};

  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const res = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: body as any });
    let json: any; try { json = res.json(); } catch { json = res.body; }
    return { status: res.statusCode, json };
  };
  const ok = async (method: string, url: string, token: string, body?: unknown) => {
    const r = await call(method, url, token, body);
    if (r.status >= 300) throw new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const stockOf = async (name: string) => (await ok('GET', `/api/stock?q=${encodeURIComponent(name)}`, tok.owner))[0].on_hand as number;

  beforeAll(async () => {
    await migrate(() => {});
    await seedBase('owner@test.in', 'owner-pass-123');
    app = await buildApp({ zoho, logger: false });
    tok.owner = (await ok('POST', '/api/auth/login', undefined, { email: 'owner@test.in', password: 'owner-pass-123' })).token;
    for (const role of ['accountant', 'supervisor', 'technician', 'sales'] as const) {
      await ok('POST', '/api/users', tok.owner, { name: role, email: `${role}@test.in`, role, password: 'password-123' });
      tok[role] = (await ok('POST', '/api/auth/login', undefined, { email: `${role}@test.in`, password: 'password-123' })).token;
    }
    await ok('POST', '/api/users', tok.owner, { name: 'tech2', email: 'tech2@test.in', role: 'technician', password: 'password-123' });
    tok.tech2 = (await ok('POST', '/api/auth/login', undefined, { email: 'tech2@test.in', password: 'password-123' })).token;
    ids.tech = (await ok('GET', '/api/auth/me', tok.technician)).id;

    // Masters. The 18% here is test data only; the app takes rates from the synced Zoho tax setup.
    ids.tax = (await pool.query(`insert into tax_rates (zoho_tax_id,name,percentage) values ('ZT1','Test tax',18) returning id`)).rows[0].id;
    ids.vendor = (await ok('POST', '/api/vendors', tok.accountant, { name: 'Acme Supplies' })).id;
    ids.cust = (await ok('POST', '/api/customers', tok.accountant, { name: 'Ravi Stores', phone: '9000000001' })).id;
    ids.cust2 = (await ok('POST', '/api/customers', tok.accountant, { name: 'Unlinked Co' })).id;
    await pool.query(`update vendors set zoho_contact_id='ZV1' where id=$1`, [ids.vendor]);
    await pool.query(`update customers set zoho_contact_id='ZC1' where id=$1`, [ids.cust]);
    ids.tpl = (await ok('POST', '/api/warranty-templates', tok.supervisor, { code: 'T12', name: '12m parts / 6m labour', parts_months: 12, labour_months: 6, terms_text: 'Register within 30 days', extendable: true })).id;
    const mk = async (b: object) => { const i = await ok('POST', '/api/items', tok.accountant, b); await pool.query(`update items set zoho_item_id=$2 where id=$1`, [i.id, `Z-${i.sku}`]); return i.id as string; };
    ids.pump = await mk({ sku: 'PUMP-X', name: 'Pump X', brand: 'Acme', track_mode: 'serial', rate: 10000, purchase_rate: 7000, tax_id: ids.tax, warranty_template_id: ids.tpl });
    ids.seal = await mk({ sku: 'SEAL', name: 'Seal kit', track_mode: 'none', rate: 100, purchase_rate: 60, tax_id: ids.tax });
    ids.labour = await mk({ sku: 'LAB', name: 'Service labour', is_service: true, tax_id: ids.tax });
    ids.travel = await mk({ sku: 'TRV', name: 'Travel', is_service: true, tax_id: ids.tax });
    ids.amcItem = await mk({ sku: 'AMC', name: 'AMC service', is_service: true, tax_id: ids.tax });
    await ok('PUT', '/api/settings/job_billing', tok.owner, { labour_item_id: ids.labour, travel_item_id: ids.travel });
  });
  afterAll(async () => { await app?.close(); await pool.end(); });

  it('rejects unauthenticated and wrong-role access', async () => {
    expect((await call('GET', '/api/items')).status).toBe(401);
    expect((await call('GET', '/api/bills', tok.technician)).status).toBe(403);
    expect((await call('GET', '/api/bills', tok.sales)).status).toBe(403);
    expect((await call('POST', '/api/users', tok.supervisor, {})).status).toBe(403);
    expect((await call('POST', '/api/auth/login', undefined, { email: 'owner@test.in', password: 'wrong' })).status).toBe(401);
  });

  it('receives a purchase bill into stock with batch + serials, and validates serial counts', async () => {
    const line = { item_id: ids.pump, qty: 2, rate: 7000, tax_id: ids.tax, batch_no: 'B1', expiry_date: '2030-01-01' };
    const bill = await ok('POST', '/api/bills', tok.accountant, { vendor_id: ids.vendor, vendor_bill_no: 'V-100', bill_date: today(),
      lines: [{ ...line, serial_nos: ['SN-1'] }, { item_id: ids.seal, qty: 10, rate: 60, tax_id: ids.tax }] });
    const bad = await call('POST', `/api/bills/${bill.id}/receive`, tok.accountant);
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/2 unit\(s\) need 2 serial/);
    expect(await stockOf('Pump X')).toBe(0); // nothing posted by the failed receive

    await ok('PUT', `/api/bills/${bill.id}`, tok.accountant, { vendor_id: ids.vendor, vendor_bill_no: 'V-100', bill_date: today(),
      lines: [{ ...line, serial_nos: ['SN-1', 'SN-2'] }, { item_id: ids.seal, qty: 10, rate: 60, tax_id: ids.tax }] });
    await ok('POST', `/api/bills/${bill.id}/receive`, tok.accountant);
    ids.bill = bill.id;
    expect(await stockOf('Pump X')).toBe(2);
    expect(await stockOf('Seal kit')).toBe(10);
    const dupe = await call('POST', '/api/bills', tok.accountant, { vendor_id: ids.vendor, vendor_bill_no: 'v-100', bill_date: today(), lines: [{ item_id: ids.seal, qty: 1, rate: 1 }] });
    expect(dupe.status).toBe(409); // same vendor bill number twice
    const again = await call('POST', `/api/bills/${bill.id}/receive`, tok.accountant);
    expect(again.status).toBe(409);
    ids.batch = (await ok('GET', `/api/batches?item_id=${ids.pump}`, tok.supervisor))[0].id;
    ids.sn1 = (await ok('GET', '/api/serials?q=SN-1', tok.supervisor))[0].id;
    ids.sn2 = (await ok('GET', '/api/serials?q=SN-2', tok.supervisor))[0].id;
  });

  it('confirming an invoice issues stock, sells the serial and starts the warranty on the invoice date', async () => {
    const inv = await ok('POST', '/api/invoices', tok.accountant, { customer_id: ids.cust, invoice_date: today(),
      lines: [{ item_id: ids.pump, qty: 1, rate: 10000, tax_id: ids.tax, serial_ids: [ids.sn1] }] });
    const draft = await ok('GET', `/api/invoices/${inv.id}`, tok.accountant);
    expect(draft.total).toBe(11800); // 10000 + 18% from the synced tax record
    expect((await call('POST', `/api/invoices/${inv.id}/confirm`, tok.sales)).status).toBe(403);
    const conf = await ok('POST', `/api/invoices/${inv.id}/confirm`, tok.accountant);
    expect(conf.warranties).toHaveLength(1);
    ids.inv1 = inv.id;

    const full = await ok('GET', `/api/invoices/${inv.id}`, tok.accountant);
    expect(full.status).toBe('confirmed');
    expect(full.sync_status).toBe('pending');
    const w = full.warranties[0];
    expect(w.start_date).toBe(today());
    expect(w.parts_end).toBe(endDate(today(), 12));
    expect(w.labour_end).toBe(endDate(today(), 6));
    expect(w.onsite_end).toBeNull();
    expect(await stockOf('Pump X')).toBe(1);

    const again = await ok('POST', '/api/invoices', tok.accountant, { customer_id: ids.cust, invoice_date: today(),
      lines: [{ item_id: ids.pump, qty: 1, rate: 10000, serial_ids: [ids.sn1] }] });
    const r = await call('POST', `/api/invoices/${again.id}/confirm`, tok.accountant);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/SN-1 is sold/);
    await ok('POST', `/api/invoices/${again.id}/cancel`, tok.accountant);
    expect(await stockOf('Pump X')).toBe(1);
  });

  it('cannot oversell non-serial stock; failed confirm leaves no partial changes', async () => {
    const inv = await ok('POST', '/api/invoices', tok.accountant, { customer_id: ids.cust, invoice_date: today(),
      lines: [{ item_id: ids.seal, qty: 4, rate: 100 }, { item_id: ids.seal, qty: 99, rate: 100 }] });
    const r = await call('POST', `/api/invoices/${inv.id}/confirm`, tok.accountant);
    expect(r.status).toBe(409);
    expect(await stockOf('Seal kit')).toBe(10);
    expect((await ok('GET', `/api/invoices/${inv.id}`, tok.accountant)).status).toBe('draft');
    await ok('POST', `/api/invoices/${inv.id}/cancel`, tok.accountant);
  });

  it('pushes invoice and bill to Zoho as drafts, exactly once, with warranty custom fields', async () => {
    const res = await processOutbox(zoho);
    expect(res.failed).toBe(0);
    expect(zoho.invoices).toHaveLength(1);
    const p = zoho.invoices[0];
    expect(p.reference_number).toMatch(/^INV-\d+$/);
    expect(p.customer_id).toBe('ZC1');
    expect(p.status).toBe('draft');
    expect(p.line_items[0]).toMatchObject({ item_id: 'Z-PUMP-X', quantity: 1, rate: 10000, tax_id: 'ZT1' });
    const cf = Object.fromEntries(p.custom_fields.map((f: any) => [f.customfield_id, f.value]));
    expect(cf.cf1).toBe(today());
    expect(cf.cf2).toMatch(/Pump X \[SN-1\]: Parts 12m, Labour 6m\. Register within 30 days/);
    expect(cf.cf3).toBe('Pump X: SN-1');
    expect(zoho.bills).toHaveLength(1);
    expect(zoho.bills[0]).toMatchObject({ vendor_id: 'ZV1', bill_number: 'V-100' });

    await processOutbox(zoho); // second pass must not create duplicates
    expect(zoho.invoices).toHaveLength(1);
    expect(zoho.bills).toHaveLength(1);
    const inv = await ok('GET', `/api/invoices/${ids.inv1}`, tok.accountant);
    expect(inv.sync_status).toBe('synced');
    expect(inv.zoho_invoice_id).toBe('ZI1');
  });

  it('flags documents whose customer is not linked to Zoho instead of retrying forever', async () => {
    const inv = await ok('POST', '/api/invoices', tok.accountant, { customer_id: ids.cust2, invoice_date: today(),
      lines: [{ item_id: ids.seal, qty: 1, rate: 100 }] });
    await ok('POST', `/api/invoices/${inv.id}/confirm`, tok.accountant);
    const res = await processOutbox(zoho);
    expect(res.failed).toBe(1);
    const d = await ok('GET', `/api/invoices/${inv.id}`, tok.accountant);
    expect(d.sync_status).toBe('failed');
    expect(d.outbox.last_error).toMatch(/not linked to a Zoho contact/);
    const status = await ok('GET', '/api/zoho/status', tok.accountant);
    expect(status.failures).toHaveLength(1);
    // fix the data, retry, and it goes through
    await pool.query(`update customers set zoho_contact_id='ZC2' where id=$1`, [ids.cust2]);
    await ok('POST', `/api/invoices/${inv.id}/resync`, tok.accountant);
    expect((await processOutbox(zoho)).failed).toBe(0);
    expect((await ok('GET', `/api/invoices/${inv.id}`, tok.accountant)).sync_status).toBe('synced');
    expect(await stockOf('Seal kit')).toBe(9);
  });

  it('serial lookup shows owner, warranty status and history', async () => {
    const found = await ok('GET', '/api/serials/lookup?q=sn-1', tok.technician);
    expect(found[0]).toMatchObject({ serial_no: 'SN-1', customer: 'Ravi Stores' });
    const d = await ok('GET', `/api/serials/${ids.sn1}`, tok.technician);
    expect(d.warranties[0].coverage.in_warranty).toBe(true);
    expect(d.warranties[0].coverage.active).toEqual(['parts', 'labour']);
  });

  it('warranty job: coverage suggested, offline ops are idempotent, parts drawn from store', async () => {
    const job = await ok('POST', '/api/jobs', tok.supervisor, { kind: 'warranty_claim', serial_id: ids.sn1, problem: 'Leaking',
      priority: 'high', assigned_to: ids.tech, scheduled_start: new Date(Date.now() + 3600_000).toISOString() });
    expect(job.coverage).toBe('in_warranty');
    ids.job1 = job.id;
    expect((await ok('GET', `/api/jobs/${job.id}`, tok.supervisor)).status).toBe('scheduled');

    expect((await call('GET', `/api/jobs/${job.id}`, tok.tech2)).status).toBe(403);
    expect((await ok('GET', '/api/jobs', tok.tech2)).length).toBe(0);

    const boot = await ok('GET', '/api/sync/bootstrap', tok.technician);
    expect(boot.jobs.map((j: any) => j.id)).toContain(job.id);
    expect(boot.jobs[0].warranty.coverage.in_warranty).toBe(true);
    const checklistId = boot.jobs[0].checklist[0].id;

    const partId = randomUUID(), ops = [
      { op_id: randomUUID(), job_id: job.id, at: new Date().toISOString(), op: { kind: 'checkin', lat: 11.25, lng: 75.78 } },
      { op_id: randomUUID(), job_id: job.id, at: new Date().toISOString(), op: { kind: 'checklist', item_id: checklistId, done: true } },
      { op_id: randomUUID(), job_id: job.id, at: new Date().toISOString(), op: { kind: 'add_part', item_id: ids.seal, qty: 1, part_id: partId } },
      { op_id: randomUUID(), job_id: job.id, at: new Date().toISOString(), op: { kind: 'note', text: 'Replaced seal' } },
    ];
    const first = await ok('POST', '/api/sync/push', tok.technician, { ops });
    expect(first.results.map((r: any) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
    const replay = await ok('POST', '/api/sync/push', tok.technician, { ops });
    expect(replay.results.map((r: any) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
    expect(await stockOf('Seal kit')).toBe(8); // drawn once, not twice

    // another technician's queued ops for this job are refused, not applied
    const other = await ok('POST', '/api/sync/push', tok.tech2, { ops: [{ op_id: randomUUID(), job_id: job.id, at: new Date().toISOString(), op: { kind: 'note', text: 'x' } }] });
    expect(other.results[0]).toMatchObject({ status: 'error', retry: false });

    const d = await ok('GET', `/api/jobs/${job.id}`, tok.technician);
    expect(d.status).toBe('in_progress');
    expect(d.parts).toHaveLength(1);
    expect(d.parts[0].chargeable).toBe(false); // in warranty -> no customer charge
  });

  it('signature upload is idempotent and completion links it', async () => {
    const sigId = randomUUID();
    const boundary = '----t' + randomUUID();
    const field = (n: string, v: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const body = Buffer.concat([
      Buffer.from(field('owner_type', 'service_job') + field('owner_id', ids.job1) + field('kind', 'signature') + field('client_id', sigId)),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sig.png"\r\nContent-Type: image/png\r\n\r\n`), png,
      Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const send = () => app.inject({ method: 'POST', url: '/api/attachments', payload: body,
      headers: { authorization: `Bearer ${tok.technician}`, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    const a = (await send()).json(), b = (await send()).json();
    expect(a.id).toBeTruthy();
    expect(b).toMatchObject({ id: a.id, duplicate: true });

    // completing before the upload has arrived is a retryable error
    const early = await ok('POST', '/api/sync/push', tok.technician, { ops: [{ op_id: randomUUID(), job_id: ids.job1, at: new Date().toISOString(),
      op: { kind: 'complete', resolution: 'Seal replaced', signature_client_id: randomUUID() } }] });
    expect(early.results[0]).toMatchObject({ status: 'error', retry: true });

    const done = await ok('POST', '/api/sync/push', tok.technician, { ops: [{ op_id: randomUUID(), job_id: ids.job1, at: new Date().toISOString(),
      op: { kind: 'complete', resolution: 'Seal replaced', signed_by_name: 'Ravi', signature_client_id: sigId } }] });
    expect(done.results[0].status).toBe('applied');
    const d = await ok('GET', `/api/jobs/${ids.job1}`, tok.supervisor);
    expect(d.status).toBe('completed');
    expect(d.signature_attachment_id).toBe(a.id);
    expect((await call('GET', `/api/attachments/${a.id}/file`, tok.tech2)).status).toBe(403);
    expect((await call('GET', `/api/attachments/${a.id}/file`, tok.technician)).status).toBe(200);

    expect((await call('POST', `/api/jobs/${ids.job1}/invoice`, tok.accountant)).status).toBe(409); // warranty job: nothing to charge
    await ok('POST', `/api/jobs/${ids.job1}/close`, tok.supervisor);
  });

  it('out-of-warranty job is billed: parts + labour + travel, stock not issued twice', async () => {
    const old = addMonths(today(), -24);
    const inv = await ok('POST', '/api/invoices', tok.accountant, { customer_id: ids.cust, invoice_date: old,
      lines: [{ item_id: ids.pump, qty: 1, rate: 9000, serial_ids: [ids.sn2] }] });
    await ok('POST', `/api/invoices/${inv.id}/confirm`, tok.accountant);

    const job = await ok('POST', '/api/jobs', tok.supervisor, { kind: 'repair', serial_id: ids.sn2, problem: 'No flow', assigned_to: ids.tech });
    expect(job.coverage).toBe('out_of_warranty');
    // an override needs a reason
    expect((await call('POST', `/api/jobs/${job.id}/coverage`, tok.supervisor, { coverage: 'goodwill', reason: '' })).status).toBe(400);
    expect((await call('POST', `/api/jobs/${job.id}/coverage`, tok.technician, { coverage: 'goodwill', reason: 'x' })).status).toBe(403);

    await ok('PATCH', `/api/jobs/${job.id}`, tok.supervisor, { labour_rate_per_hr: 500, travel_charge: 200 });
    await ok('POST', '/api/sync/push', tok.technician, { ops: [
      { op_id: randomUUID(), job_id: job.id, at: new Date().toISOString(), op: { kind: 'checkin' } },
      { op_id: randomUUID(), job_id: job.id, at: new Date().toISOString(), op: { kind: 'add_part', item_id: ids.seal, qty: 2 } },
      { op_id: randomUUID(), job_id: job.id, at: new Date().toISOString(), op: { kind: 'complete', resolution: 'Replaced seals', labour_minutes: 90 } },
    ] });
    expect(await stockOf('Seal kit')).toBe(6);
    expect((await call('POST', `/api/jobs/${job.id}/close`, tok.supervisor)).status).toBe(409); // chargeable: invoice first

    const { invoice_id } = await ok('POST', `/api/jobs/${job.id}/invoice`, tok.accountant);
    const di = await ok('GET', `/api/invoices/${invoice_id}`, tok.accountant);
    expect(di.status).toBe('draft');
    expect(di.lines.map((l: any) => [l.item_name, l.qty, l.rate])).toEqual([['Seal kit', 2, 100], ['Service labour', 1.5, 500], ['Travel', 1, 200]]);
    expect(di.subtotal).toBe(200 + 750 + 200);
    await ok('POST', `/api/invoices/${invoice_id}/confirm`, tok.accountant);
    expect(await stockOf('Seal kit')).toBe(6); // job already issued the parts
    expect((await ok('GET', `/api/jobs/${job.id}`, tok.supervisor)).status).toBe('invoiced');
  });

  it('batch trace finds the customer; warranty extension recomputes dates', async () => {
    const t = await ok('GET', `/api/batches/${ids.batch}/trace`, tok.supervisor);
    // one row per invoice that took units from this batch
    expect(t.sold).toHaveLength(2);
    expect(new Set(t.sold.map((s: any) => s.customer))).toEqual(new Set(['Ravi Stores']));
    expect(t.sold.flatMap((s: any) => s.serials).sort()).toEqual(['SN-1', 'SN-2']);
    const w = (await ok('GET', '/api/warranties?q=SN-1', tok.supervisor))[0];
    const ext = await ok('POST', `/api/warranties/${w.id}/extend`, tok.supervisor, { months: 12, price: 500 });
    expect(ext.parts_end).toBe(endDate(today(), 24));
    expect(ext.labour_end).toBe(endDate(today(), 18));
    expect(ext.onsite_end).toBeNull();
    const cert = await app.inject({ method: 'GET', url: `/api/warranties/${w.id}/certificate`, headers: { authorization: `Bearer ${tok.supervisor}` } });
    expect(cert.body).toContain('SN-1');
    expect(cert.body).toContain('Register within 30 days');
  });

  it('AMC per-visit: schedule, generate due jobs, complete a visit, bill it', async () => {
    // Contract began 4 months ago, so its first visit (~3 months in) is already due and the second is ~5 months away.
    const k = await ok('POST', '/api/amc', tok.supervisor, { customer_id: ids.cust, billing_mode: 'per_visit', start_date: addMonths(today(), -4),
      visits_per_year: 2, per_visit_amount: 1000, tax_id: ids.tax, service_item_id: ids.amcItem, serial_ids: [ids.sn1, ids.sn2] });
    const c = await ok('GET', `/api/amc/${k.id}`, tok.supervisor);
    expect(c.visits).toHaveLength(2);
    expect(c.units).toHaveLength(2);
    expect((await call('POST', '/api/amc', tok.supervisor, { customer_id: ids.cust, billing_mode: 'annual', start_date: today(), visits_per_year: 2, serial_ids: [ids.sn1] })).status).toBe(400);

    const gen = await ok('POST', '/api/amc/generate-due-jobs?days=14', tok.supervisor);
    expect(gen.created).toBe(1);
    expect((await ok('POST', '/api/amc/generate-due-jobs?days=14', tok.supervisor)).created).toBe(0); // idempotent
    const c2 = await ok('GET', `/api/amc/${k.id}`, tok.supervisor);
    const visit = c2.visits[0];
    expect(c2.visits[1].job_id).toBeNull(); // the later visit is not due yet
    const jobId = visit.job_id;
    await ok('PATCH', `/api/jobs/${jobId}`, tok.supervisor, { assigned_to: ids.tech });
    const j = await ok('GET', `/api/jobs/${jobId}`, tok.supervisor);
    expect(j.coverage).toBe('amc');
    await ok('POST', '/api/sync/push', tok.technician, { ops: [
      { op_id: randomUUID(), job_id: jobId, at: new Date().toISOString(), op: { kind: 'checkin' } },
      { op_id: randomUUID(), job_id: jobId, at: new Date().toISOString(), op: { kind: 'complete', resolution: 'Serviced both units' } },
    ] });
    const { invoice_id } = await ok('POST', `/api/amc/visits/${visit.id}/invoice`, tok.accountant);
    const di = await ok('GET', `/api/invoices/${invoice_id}`, tok.accountant);
    expect(di.source).toBe('amc');
    expect(di.total).toBe(1180);
    expect((await call('POST', `/api/amc/visits/${visit.id}/invoice`, tok.accountant)).status).toBe(409); // not twice
    expect((await call('POST', `/api/amc/visits/${c2.visits[1].id}/invoice`, tok.accountant)).status).toBe(409); // not completed
  });

  it('pulls taxes, contacts and items from Zoho, turning warranty custom fields into terms; re-pull is idempotent', async () => {
    const detailCalls: string[] = [];
    const api = Object.assign(new FakeZoho(), {
      // Zoho's item list leaves out custom fields; the item's own record has them
      getItems: async (ids: string[]) => { detailCalls.push(...ids); return ids.map((id) => ({ item_id: id, ...(id === 'ZI-DETAIL' ? { custom_field_hash: { cf_warranty_template: 'T12', cf_warranty_terms: 'From item record' } } : {}) })); },
      listTaxes: async () => [{ tax_id: 'ZT9', tax_name: 'Zoho tax A', tax_percentage: 12, tax_type: 'tax' }, { tax_id: 'ZT8', tax_name: 'Old tax', tax_percentage: 5, is_inactive: true },
        { tax_id: 'ZG18', tax_name: 'GST18', tax_percentage: 18, tax_type: 'tax_group', tax_specification: 'intra' },
        { tax_id: 'ZI18', tax_name: 'IGST18', tax_percentage: 18, tax_type: 'tax', tax_specification: 'inter', tax_specific_type: 'igst' }],
      listContacts: async (type: string) => ({ rows: [{ contact_id: `${type}-1`, contact_name: `Zoho ${type}`, mobile: '9111111111', gst_treatment: 'business_gst', place_of_contact: 'KL' }], hasMore: false }),
      listItems: async () => ({ hasMore: false, rows: [
        { item_id: 'ZI-A', sku: 'ZA', name: 'Zoho Item A', rate: 500, tax_id: 'ZT9', hsn_or_sac: '8501', product_type: 'goods', track_serial_number: true,
          custom_field_hash: { cf_warranty_parts_months: '18', cf_warranty_labour_months: '6', cf_warranty_terms: 'From Zoho' } },
        { item_id: 'ZI-B', sku: 'ZB', name: 'Zoho Service', rate: 300, product_type: 'service', custom_field_hash: { cf_warranty_template: 'T12' } },
        { item_id: 'ZI-SEAL', sku: 'SEAL', name: 'Seal kit (conflicting SKU)', rate: 110, status: 'active' },   // SKU already belongs to another linked item
        { item_id: 'ZI-ADOPT', sku: 'adopt-me', name: 'Adopted from Zoho', rate: 75 },                          // matches an unlinked app item by SKU (case-insensitive)
        { item_id: 'ZI-DETAIL', sku: 'DET', name: 'Warranty only on detail', rate: 10, last_modified_time: '2020-01-01T10:00:00+0530' },
        // shaped like a Zoho POS item: empty SKU, no top-level tax_id, separate GST/IGST preferences, inactive status
        { item_id: 'ZI-POS', sku: '', part_number: 'PN-77', name: 'POS style item', rate: 2880, tax_id: '', status: 'inactive', product_type: 'goods', hsn_or_sac: '90283010',
          track_inventory: true, track_serial_number: false, track_batch_number: false,
          item_tax_preferences: [{ tax_specification: 'inter', tax_id: 'ZI18', tax_percentage: 18 }, { tax_specification: 'intra', tax_id: 'ZG18', tax_percentage: 18 }] },
      ] }),
    });
    expect(await pullTaxes(api)).toBe(4);
    expect(await pullContacts(api, 'customer')).toBe(1);
    expect(await pullContacts(api, 'vendor')).toBe(1);
    await pool.query(`insert into items (sku,name,track_mode,rate) values ('ADOPT-ME','Local item','batch',1)`);
    const skipped: string[] = [];
    expect(await pullItems(api, pool, skipped)).toBe(5);   // one bad record does not stop the others
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatch(/Seal kit \(conflicting SKU\).*SEAL/);
    expect(await pullItems(api, pool, [])).toBe(5);        // re-pull changes nothing
    expect(detailCalls.filter((id) => id === 'ZI-DETAIL')).toHaveLength(1);   // read once; unchanged on the second pull

    const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
    expect((await q(`select percentage, active from tax_rates where zoho_tax_id='ZT9'`))[0]).toEqual({ percentage: 12, active: true });
    expect((await q(`select active from tax_rates where zoho_tax_id='ZT8'`))[0].active).toBe(false);
    expect((await q(`select count(*)::int n from customers where zoho_contact_id='customer-1'`))[0].n).toBe(1);
    const a = (await q(`select i.track_mode, i.hsn_code, i.rate, t.parts_months, t.labour_months, t.terms_text, tx.percentage from items i
                          join warranty_templates t on t.id=i.warranty_template_id join tax_rates tx on tx.id=i.tax_id where i.zoho_item_id='ZI-A'`))[0];
    expect(a).toMatchObject({ track_mode: 'serial', hsn_code: '8501', rate: 500, parts_months: 18, labour_months: 6, terms_text: 'From Zoho', percentage: 12 });
    expect((await q(`select count(*)::int n from warranty_templates where code like 'ZOHO-%'`))[0].n).toBe(1); // not duplicated on re-pull
    const b = (await q(`select t.code, i.is_service from items i join warranty_templates t on t.id=i.warranty_template_id where i.zoho_item_id='ZI-B'`))[0];
    expect(b).toEqual({ code: 'T12', is_service: true }); // matched the existing template by code
    const det = (await q(`select t.code from items i join warranty_templates t on t.id=i.warranty_template_id where i.zoho_item_id='ZI-DETAIL'`))[0];
    expect(det).toEqual({ code: 'T12' });   // warranty came from the item's detail record, not the list
    const pos = (await q(`select i.sku, i.active, i.zoho_tax_intra, i.zoho_tax_inter, tx.name as preview_tax, tx.percentage from items i left join tax_rates tx on tx.id=i.tax_id where i.zoho_item_id='ZI-POS'`))[0];
    expect(pos).toEqual({ sku: 'PN-77', active: false, zoho_tax_intra: 'ZG18', zoho_tax_inter: 'ZI18', preview_tax: 'GST18', percentage: 18 });
    expect((await q(`select tax_specification from tax_rates where zoho_tax_id='ZI18'`))[0].tax_specification).toBe('inter');
    // an unlinked app item with the same SKU is adopted (not duplicated) and keeps its local tracking mode
    const adopted = await q(`select zoho_item_id, rate, track_mode from items where lower(sku)='adopt-me'`);
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ zoho_item_id: 'ZI-ADOPT', rate: 75, track_mode: 'batch' });
    // the conflicting record left the existing linked item untouched
    expect((await q(`select zoho_item_id, rate from items where sku='SEAL'`))[0]).toEqual({ zoho_item_id: 'Z-SEAL', rate: 100 });
  });

  it('pushes the IGST tax for other-state customers and the GST tax for same-state ones (Zoho POS items carry both)', async () => {
    await pool.query(`update items set zoho_tax_intra='G18', zoho_tax_inter='I18' where sku='SEAL'`);
    const other = (await ok('POST', '/api/customers', tok.accountant, { name: 'Chennai Traders', place_of_supply: 'TN' })).id;
    const same = (await ok('POST', '/api/customers', tok.accountant, { name: 'Kochi Traders', place_of_supply: 'KL' })).id;
    await pool.query(`update customers set zoho_contact_id = 'ZC-' || id::text where id = any($1::uuid[])`, [[other, same]]);
    const push = async (customer_id: string, place_of_supply: string) => {
      const inv = await ok('POST', '/api/invoices', tok.accountant, { customer_id, invoice_date: today(), place_of_supply, lines: [{ item_id: ids.seal, qty: 1, rate: 100 }] });
      await ok('POST', `/api/invoices/${inv.id}/confirm`, tok.accountant);
      const number = (await ok('GET', `/api/invoices/${inv.id}`, tok.accountant)).number;
      expect((await processOutbox(zoho)).failed).toBe(0);
      const sent = zoho.invoices.find((i) => i.reference_number === number);   // older pending invoices are pushed first
      return sent.line_items[0].tax_id;
    };
    expect(await push(other, 'TN')).toBe('I18');
    expect(await push(same, 'KL')).toBe('G18');
  });

  it('dashboard and reports respond', async () => {
    const d = await ok('GET', '/api/dashboard', tok.supervisor);
    expect(d.zoho_sync_failures).toBe(0);
    expect(typeof d.open_jobs).toBe('number');
    await ok('GET', '/api/reports/warranty-cost', tok.supervisor);
    await ok('GET', '/api/reports/batch-failures', tok.supervisor);
  });
});
