import { audit, nextDocNumber, type Queryable } from '../db.js';
import { fail } from './errors.js';
import { computeLine, computeTotals } from './money.js';
import { addMovement, defaultLocationId, onHand } from './stock.js';
import { enqueueZoho } from './outbox.js';
import {
  computeWarranty, resolveTemplateId, snapshotTerms, type WarrantyTemplateLike, type TemplateRule,
} from './warranty.js';

// ───────────────────────── shared ─────────────────────────
async function taxPctMap(c: Queryable, ids: (string | null | undefined)[]) {
  const uniq = [...new Set(ids.filter(Boolean))] as string[];
  const map = new Map<string, number>();
  if (!uniq.length) return map;
  const { rows } = await c.query<{ id: string; percentage: number }>(
    'select id, percentage from tax_rates where id = any($1::uuid[])', [uniq]);
  rows.forEach((r) => map.set(r.id, r.percentage));
  return map;
}

// ───────────────────────── purchase bills ─────────────────────────
export interface BillLineIn {
  item_id: string; description?: string | null; qty: number; rate: number; tax_id?: string | null;
  batch_no?: string | null; mfg_date?: string | null; expiry_date?: string | null;
  serial_nos?: string[]; location_id?: string | null;
}
export interface BillIn {
  vendor_id: string; vendor_bill_no?: string | null; bill_date: string; due_date?: string | null;
  place_of_supply?: string | null; gst_treatment?: string | null; notes?: string | null; lines: BillLineIn[];
}

export async function saveBill(c: Queryable, userId: string, input: BillIn, billId?: string) {
  const taxes = await taxPctMap(c, input.lines.map((l) => l.tax_id));
  const totals = computeTotals(input.lines.map((l) => ({ qty: l.qty, rate: l.rate, tax_pct: l.tax_id ? taxes.get(l.tax_id) : 0 })));
  let id = billId;
  if (id) {
    const cur = (await c.query('select status from purchase_bills where id=$1 for update', [id])).rows[0];
    if (!cur) fail(404, 'Bill not found');
    if (cur.status !== 'draft') fail(409, 'Only draft bills can be edited');
    await c.query(
      `update purchase_bills set vendor_id=$2, vendor_bill_no=$3, bill_date=$4, due_date=$5, place_of_supply=$6,
         gst_treatment=$7, notes=$8, subtotal=$9, tax_total=$10, total=$11, updated_at=now() where id=$1`,
      [id, input.vendor_id, input.vendor_bill_no ?? null, input.bill_date, input.due_date ?? null,
       input.place_of_supply ?? null, input.gst_treatment ?? null, input.notes ?? null,
       totals.subtotal, totals.tax_total, totals.total]);
    await c.query('delete from purchase_bill_lines where bill_id=$1', [id]);
  } else {
    const number = await nextDocNumber(c, 'bill', 'BILL');
    const r = await c.query<{ id: string }>(
      `insert into purchase_bills (number, vendor_id, vendor_bill_no, bill_date, due_date, place_of_supply, gst_treatment,
         notes, subtotal, tax_total, total, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [number, input.vendor_id, input.vendor_bill_no ?? null, input.bill_date, input.due_date ?? null,
       input.place_of_supply ?? null, input.gst_treatment ?? null, input.notes ?? null,
       totals.subtotal, totals.tax_total, totals.total, userId]);
    id = r.rows[0].id;
  }
  let n = 0;
  for (const l of input.lines) {
    const calc = computeLine({ qty: l.qty, rate: l.rate, tax_pct: l.tax_id ? taxes.get(l.tax_id) : 0 });
    await c.query(
      `insert into purchase_bill_lines (bill_id,line_no,item_id,description,qty,rate,tax_id,amount,batch_no,mfg_date,expiry_date,serial_nos,location_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, ++n, l.item_id, l.description ?? null, l.qty, l.rate, l.tax_id ?? null, calc.amount,
       l.batch_no ?? null, l.mfg_date ?? null, l.expiry_date ?? null, l.serial_nos ?? [], l.location_id ?? null]);
  }
  return id!;
}

/** Receive a bill into stock: creates batches, serial units and ledger entries; queues the Zoho draft. */
export async function receiveBill(c: Queryable, userId: string, billId: string) {
  const bill = (await c.query('select * from purchase_bills where id=$1 for update', [billId])).rows[0];
  if (!bill) fail(404, 'Bill not found');
  if (bill.status !== 'draft') fail(409, `Bill is already ${bill.status}`);
  const lines = (await c.query(
    `select l.*, i.track_mode, i.name as item_name, i.is_service from purchase_bill_lines l
       join items i on i.id=l.item_id where l.bill_id=$1 order by line_no`, [billId])).rows;
  if (!lines.length) fail(400, 'Bill has no lines');
  const store = await defaultLocationId(c);

  for (const l of lines) {
    if (l.is_service) continue;
    const loc = l.location_id ?? store;
    if (l.track_mode === 'serial') {
      if (!Number.isInteger(l.qty)) fail(400, `${l.item_name}: serial-tracked quantity must be a whole number`);
      const serials: string[] = (l.serial_nos as string[]).map((s) => s.trim()).filter(Boolean);
      if (serials.length !== l.qty) fail(400, `${l.item_name}: ${l.qty} unit(s) need ${l.qty} serial number(s), got ${serials.length}`);
      if (new Set(serials.map((s) => s.toLowerCase())).size !== serials.length) fail(400, `${l.item_name}: duplicate serial numbers on the bill`);
    }
    if (l.track_mode === 'batch' && !l.batch_no) fail(400, `${l.item_name}: batch number required`);

    let batchId: string | null = null;
    if (l.batch_no && l.track_mode !== 'none') {
      const b = await c.query<{ id: string }>(
        `insert into batches (item_id,batch_no,mfg_date,expiry_date,vendor_id,purchase_bill_id,cost)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (item_id,batch_no) do update set expiry_date=coalesce(excluded.expiry_date,batches.expiry_date),
           mfg_date=coalesce(excluded.mfg_date,batches.mfg_date) returning id`,
        [l.item_id, l.batch_no, l.mfg_date, l.expiry_date, bill.vendor_id, billId, l.rate]);
      batchId = b.rows[0].id;
    }
    if (l.track_mode === 'serial') {
      for (const sn of l.serial_nos as string[]) {
        const serial = sn.trim();
        const dupe = await c.query('select 1 from serial_units where item_id=$1 and serial_no=$2', [l.item_id, serial]);
        if (dupe.rowCount) fail(409, `${l.item_name}: serial ${serial} already exists`);
        const s = await c.query<{ id: string }>(
          `insert into serial_units (item_id,serial_no,batch_id,vendor_id,location_id) values ($1,$2,$3,$4,$5) returning id`,
          [l.item_id, serial, batchId, bill.vendor_id, loc]);
        await addMovement(c, { item_id: l.item_id, batch_id: batchId, serial_id: s.rows[0].id, location_id: loc, qty: 1,
          kind: 'purchase', ref_type: 'purchase_bill', ref_id: billId, created_by: userId });
      }
    } else {
      await addMovement(c, { item_id: l.item_id, batch_id: batchId, location_id: loc, qty: l.qty,
        kind: 'purchase', ref_type: 'purchase_bill', ref_id: billId, created_by: userId });
    }
  }
  // Receiving adds stock here only. Zoho has no draft state for bills, so the bill is posted to Zoho later,
  // when an accountant explicitly sends it (POST /api/bills/:id/send-to-zoho).
  await c.query(`update purchase_bills set status='received', updated_at=now() where id=$1`, [billId]);
  await audit(c, userId, 'bill.receive', 'purchase_bill', billId);
}

// ───────────────────────── sales invoices ─────────────────────────
export interface InvLineIn {
  item_id: string; description?: string | null; qty: number; rate: number; discount_pct?: number;
  tax_id?: string | null; batch_id?: string | null; serial_ids?: string[]; location_id?: string | null;
  skip_stock?: boolean;
}
export interface InvIn {
  customer_id: string; invoice_date: string; due_date?: string | null; place_of_supply?: string | null;
  gst_treatment?: string | null; notes?: string | null; terms?: string | null;
  source?: 'manual' | 'service_job' | 'amc'; lines: InvLineIn[];
}

export async function saveInvoice(c: Queryable, userId: string, input: InvIn, invoiceId?: string) {
  const taxes = await taxPctMap(c, input.lines.map((l) => l.tax_id));
  const totals = computeTotals(input.lines.map((l) => ({
    qty: l.qty, rate: l.rate, discount_pct: l.discount_pct, tax_pct: l.tax_id ? taxes.get(l.tax_id) : 0 })));
  let id = invoiceId;
  if (id) {
    const cur = (await c.query('select status from sales_invoices where id=$1 for update', [id])).rows[0];
    if (!cur) fail(404, 'Invoice not found');
    if (cur.status !== 'draft') fail(409, 'Only draft invoices can be edited');
    await c.query(
      `update sales_invoices set customer_id=$2, invoice_date=$3, due_date=$4, place_of_supply=$5, gst_treatment=$6,
         notes=$7, terms=$8, subtotal=$9, tax_total=$10, total=$11, updated_at=now() where id=$1`,
      [id, input.customer_id, input.invoice_date, input.due_date ?? null, input.place_of_supply ?? null,
       input.gst_treatment ?? null, input.notes ?? null, input.terms ?? null, totals.subtotal, totals.tax_total, totals.total]);
    await c.query('delete from sales_invoice_lines where invoice_id=$1', [id]);
  } else {
    const number = await nextDocNumber(c, 'invoice', 'INV');
    const r = await c.query<{ id: string }>(
      `insert into sales_invoices (number,customer_id,invoice_date,due_date,place_of_supply,gst_treatment,notes,terms,source,
         subtotal,tax_total,total,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [number, input.customer_id, input.invoice_date, input.due_date ?? null, input.place_of_supply ?? null,
       input.gst_treatment ?? null, input.notes ?? null, input.terms ?? null, input.source ?? 'manual',
       totals.subtotal, totals.tax_total, totals.total, userId]);
    id = r.rows[0].id;
  }
  let n = 0;
  for (const l of input.lines) {
    const calc = computeLine({ qty: l.qty, rate: l.rate, discount_pct: l.discount_pct, tax_pct: l.tax_id ? taxes.get(l.tax_id) : 0 });
    await c.query(
      `insert into sales_invoice_lines (invoice_id,line_no,item_id,description,qty,rate,discount_pct,tax_id,amount,batch_id,serial_ids,location_id,skip_stock)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, ++n, l.item_id, l.description ?? null, l.qty, l.rate, l.discount_pct ?? 0, l.tax_id ?? null, calc.amount,
       l.batch_id ?? null, l.serial_ids ?? [], l.location_id ?? null, l.skip_stock ?? false]);
  }
  return id!;
}

/**
 * Confirm an invoice: issue stock, mark serials sold and create warranties starting on the invoice date.
 * Everything happens in the caller's transaction; any shortage aborts the whole confirmation.
 */
export async function confirmInvoice(c: Queryable, userId: string, invoiceId: string) {
  const inv = (await c.query('select * from sales_invoices where id=$1 for update', [invoiceId])).rows[0];
  if (!inv) fail(404, 'Invoice not found');
  if (inv.status !== 'draft') fail(409, `Invoice is already ${inv.status}`);
  const lines = (await c.query(
    `select l.*, i.track_mode, i.name as item_name, i.is_service, i.category, i.brand,
            i.warranty_template_id as item_template, b.warranty_template_id as batch_template
       from sales_invoice_lines l join items i on i.id=l.item_id left join batches b on b.id=l.batch_id
      where l.invoice_id=$1 order by l.line_no`, [invoiceId])).rows;
  if (!lines.length) fail(400, 'Invoice has no lines');

  const store = await defaultLocationId(c);
  const rules = (await c.query<TemplateRule>('select scope, scope_value, template_id from warranty_rules')).rows;
  const templates = new Map<string, WarrantyTemplateLike & { id: string }>();
  (await c.query('select * from warranty_templates where active')).rows.forEach((t) => templates.set(t.id, t));

  const warrantiesCreated: string[] = [];
  for (const l of lines) {
    if (l.is_service) continue;
    const loc = l.location_id ?? store;

    if (l.track_mode === 'serial') {
      const ids: string[] = l.serial_ids;
      if (!Number.isInteger(l.qty) || ids.length !== l.qty)
        fail(400, `${l.item_name}: select exactly ${l.qty} serial number(s)`);
      for (const sid of ids) {
        const s = (await c.query('select * from serial_units where id=$1 for update', [sid])).rows[0];
        if (!s || s.item_id !== l.item_id) fail(400, `${l.item_name}: invalid serial selected`);
        if (!l.skip_stock && s.status !== 'in_stock')
          fail(409, `${l.item_name}: serial ${s.serial_no} is ${s.status}, not available`);
        await c.query(
          `update serial_units set status='sold', customer_id=$2, sale_invoice_id=$3, sold_on=$4 where id=$1`,
          [sid, inv.customer_id, invoiceId, inv.invoice_date]);
        if (!l.skip_stock)
          await addMovement(c, { item_id: l.item_id, batch_id: s.batch_id, serial_id: sid, location_id: s.location_id ?? loc,
            qty: -1, kind: 'sale', ref_type: 'sales_invoice', ref_id: invoiceId, created_by: userId });

        const tid = resolveTemplateId({
          batchTemplateId: l.batch_template ?? (s.batch_id ? (await c.query('select warranty_template_id t from batches where id=$1', [s.batch_id])).rows[0]?.t : null),
          itemTemplateId: l.item_template, category: l.category, brand: l.brand, rules });
        const t = tid ? templates.get(tid) : undefined;
        if (t) {
          // Warranty starts on the invoice date (business rule).
          const dates = computeWarranty(t, inv.invoice_date);
          const w = await c.query<{ id: string }>(
            `insert into warranties (serial_id,sale_invoice_id,customer_id,template_id,terms_snapshot,start_date,parts_end,labour_end,onsite_end)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
            [sid, invoiceId, inv.customer_id, t.id, JSON.stringify(snapshotTerms(t)), inv.invoice_date,
             dates.parts_end, dates.labour_end, dates.onsite_end]);
          warrantiesCreated.push(w.rows[0].id);
        }
      }
    } else if (!l.skip_stock) {
      if (l.track_mode === 'batch' && !l.batch_id) fail(400, `${l.item_name}: select a batch`);
      const have = await onHand(c, { item_id: l.item_id, location_id: loc, batch_id: l.batch_id });
      if (have < l.qty) fail(409, `${l.item_name}: only ${have} in stock, ${l.qty} requested`);
      await addMovement(c, { item_id: l.item_id, batch_id: l.batch_id, location_id: loc, qty: -l.qty,
        kind: 'sale', ref_type: 'sales_invoice', ref_id: invoiceId, created_by: userId });
    }
  }
  await c.query(`update sales_invoices set status='confirmed', updated_at=now() where id=$1`, [invoiceId]);
  await enqueueZoho(c, 'sales_invoice', invoiceId);
  await audit(c, userId, 'invoice.confirm', 'sales_invoice', invoiceId, { warranties: warrantiesCreated.length });
  return { warranties: warrantiesCreated };
}
