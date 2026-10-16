import { audit, pool, tx, type Queryable } from '../db.js';
import { config } from '../config.js';
import { termsSummary } from '../lib/warranty.js';
import { ZohoError, type ZohoApi } from './client.js';
import {
  buildBillPayload, buildInvoicePayload, customFields, MappingError, parseCustomFieldIds, pickZohoTax,
  warrantyFromZohoItem, type ZohoItemWarranty,
} from './mapper.js';

const MAX_ATTEMPTS = 8;
const backoffMs = (attempts: number) => Math.min(60 * 60_000, 30_000 * 2 ** attempts);
const log = (...a: unknown[]) => console.log('[zoho]', ...a);

// ───────────────────────── pull ─────────────────────────
export async function pullTaxes(api: ZohoApi, c: Queryable = pool) {
  const taxes = await api.listTaxes();
  for (const t of taxes) {
    await c.query(
      `insert into tax_rates (zoho_tax_id,name,percentage,tax_type,tax_specification,active,raw,synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,now())
       on conflict (zoho_tax_id) do update set name=excluded.name, percentage=excluded.percentage,
         tax_type=excluded.tax_type, tax_specification=excluded.tax_specification, active=excluded.active, raw=excluded.raw, synced_at=now()`,
      [t.tax_id, t.tax_name, t.tax_percentage ?? 0, t.tax_type ?? null, t.tax_specification ?? null, !t.is_inactive, JSON.stringify(t)]);
  }
  return taxes.length;
}

export async function pullContacts(api: ZohoApi, type: 'customer' | 'vendor', c: Queryable = pool, skipped: string[] = []) {
  const table = type === 'customer' ? 'customers' : 'vendors';
  let page = 1, n = 0;
  for (;;) {
    const { rows, hasMore } = await api.listContacts(type, page++);
    for (const k of rows) {
      const phone = k.mobile || k.phone || null;
      const name = k.contact_name || k.company_name;
      try {
      await c.query(
        `insert into ${table} (zoho_contact_id,name,phone,email,gstin,gst_treatment,place_of_supply,synced_at)
         values ($1,$2,$3,$4,$5,$6,$7,now())
         on conflict (zoho_contact_id) do update set name=excluded.name, phone=excluded.phone, email=excluded.email,
           gstin=excluded.gstin, gst_treatment=excluded.gst_treatment, place_of_supply=excluded.place_of_supply,
           synced_at=now(), updated_at=now()`,
        [k.contact_id, name, phone, k.email || null, k.gst_no || null, k.gst_treatment || null, k.place_of_contact || null]);
      n++;
      } catch (e: any) { skipped.push(`${type} "${name}": ${e.message}`); }
    }
    if (!hasMore) break;
  }
  return n;
}

/** Find or create the warranty template described by a Zoho item's custom fields. */
export async function templateFromZoho(c: Queryable, w: ZohoItemWarranty): Promise<string | null> {
  if (w.code) {
    const t = (await c.query('select id from warranty_templates where lower(code)=lower($1)', [w.code])).rows[0];
    if (t) return t.id;
  }
  const hasMonths = [w.parts_months, w.labour_months, w.onsite_months].some((m) => m !== undefined);
  if (!hasMonths) return null;
  const p = w.parts_months ?? 0, l = w.labour_months ?? 0, o = w.onsite_months ?? 0;
  const code = w.code || `ZOHO-P${p}-L${l}-O${o}`;
  const r = await c.query<{ id: string }>(
    `insert into warranty_templates (code,name,parts_months,labour_months,onsite_months,terms_text)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (code) do update set updated_at=now() returning id`,
    [code, w.code ? w.code : `Imported from Zoho (parts ${p}m / labour ${l}m / on-site ${o}m)`, p, l, o, w.terms ?? null]);
  return r.rows[0].id;
}

const hasCustomFields = (z: any) => Boolean(z.custom_field_hash || z.custom_fields?.length);

/** Zoho writes offsets like +0530; make that parseable, then compare with when we last synced the item. */
export function changedSince(syncedAt: Date | string | null | undefined, zohoModified: string | null | undefined): boolean {
  if (!syncedAt || !zohoModified) return true;
  const modified = new Date(zohoModified.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime();
  return Number.isNaN(modified) || modified > new Date(syncedAt).getTime();
}

export async function pullItems(api: ZohoApi, c: Queryable = pool, skipped: string[] = []) {
  const fieldsConfigured = Object.keys(parseCustomFieldIds(config.ZOHO_CUSTOM_FIELD_IDS)).some((k) => k.startsWith('item.'));
  const taxByZoho = new Map<string, string>();
  (await c.query('select id, zoho_tax_id from tax_rates where zoho_tax_id is not null')).rows.forEach((r) => taxByZoho.set(r.zoho_tax_id, r.id));
  let page = 1, n = 0;
  for (;;) {
    const { rows, hasMore } = await api.listItems(page++);
    for (const z of rows) {
      try {
      // POS items often have no SKU; fall back to the part number, then Zoho's own id so the record is still unique.
      const sku = z.sku || z.part_number || z.item_id;
      const existing = (await c.query(
        `select id, synced_at from items where zoho_item_id=$1 or (zoho_item_id is null and lower(sku)=lower($2)) limit 1`,
        [z.item_id, sku])).rows[0];
      // Zoho's item *list* leaves out custom fields. When warranty fields are configured, read the item's own record,
      // but only for items that are new or changed since we last saw them, to keep API calls low.
      let detail = z;
      if (fieldsConfigured && !hasCustomFields(z) && changedSince(existing?.synced_at, z.last_modified_time)) {
        try { detail = (await api.getItem(z.item_id)) ?? z; } catch (e: any) { skipped.push(`item "${z.name}": could not read warranty fields (${e.message})`); }
      }
      const warranty = warrantyFromZohoItem(detail);
      const tplId = warranty ? await templateFromZoho(c, warranty) : null;
      const track = z.track_serial_number ? 'serial' : z.track_batch_number ? 'batch' : 'none';
      // Zoho POS gives each item a GST (intra-state) and an IGST (inter-state) tax; Books gives one tax_id.
      const prefs: any[] = z.item_tax_preferences ?? [];
      const intra: string | null = prefs.find((p) => p.tax_specification === 'intra')?.tax_id ?? z.tax_id ?? null;
      const inter: string | null = prefs.find((p) => p.tax_specification === 'inter')?.tax_id ?? null;
      const previewTax = (intra && taxByZoho.get(intra)) || (inter && taxByZoho.get(inter)) || null;
      const vals = [z.item_id, sku, z.name, z.hsn_or_sac || null, z.unit || 'nos', z.rate ?? 0,
        z.purchase_rate ?? 0, previewTax, z.product_type === 'service', z.status !== 'inactive', intra, inter];
      if (existing) {
        await c.query(
          `update items set zoho_item_id=$2, sku=$3, name=$4, hsn_code=$5, unit=$6, rate=$7, purchase_rate=$8, tax_id=$9,
             is_service=$10, active=$11, zoho_tax_intra=$12, zoho_tax_inter=$13,
             warranty_template_id=coalesce($14, warranty_template_id), synced_at=now(), updated_at=now()
           where id=$1`, [existing.id, ...vals, tplId]);
      } else {
        await c.query(
          `insert into items (zoho_item_id,sku,name,hsn_code,unit,rate,purchase_rate,tax_id,is_service,active,zoho_tax_intra,zoho_tax_inter,
             warranty_template_id,track_mode,synced_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())`, [...vals, tplId, track]);
      }
      n++;
      } catch (e: any) {
        // One bad record (e.g. a SKU already used by another item) must not stop the rest of the pull.
        skipped.push(`item "${z.name}" (${z.sku || z.item_id}): ${e.detail ?? e.message}`);
      }
    }
    if (!hasMore) break;
  }
  return n;
}

// ───────────────────────── push ─────────────────────────
async function loadInvoiceSync(c: Queryable, id: string) {
  const inv = (await c.query('select * from sales_invoices where id=$1', [id])).rows[0];
  const cust = (await c.query('select name, zoho_contact_id from customers where id=$1', [inv.customer_id])).rows[0];
  const lines = (await c.query(
    `select i.name as item_name, i.zoho_item_id, l.description, l.qty, l.rate, l.discount_pct, i.hsn_code,
            i.zoho_tax_intra, i.zoho_tax_inter, t.zoho_tax_id as line_tax
       from sales_invoice_lines l join items i on i.id=l.item_id left join tax_rates t on t.id=l.tax_id
      where l.invoice_id=$1 order by l.line_no`, [id])).rows
    .map(({ zoho_tax_intra, zoho_tax_inter, line_tax, ...l }) => ({
      ...l, zoho_tax_id: pickZohoTax({ intra: zoho_tax_intra, inter: zoho_tax_inter, fallback: line_tax }, inv.place_of_supply, config.HOME_PLACE_OF_SUPPLY) }));
  const warranties = (await c.query(
    `select i.name as item_name, s.serial_no, w.start_date, w.parts_end, w.terms_snapshot
       from warranties w join serial_units s on s.id=w.serial_id join items i on i.id=s.item_id
      where w.sale_invoice_id=$1 order by i.name, s.serial_no`, [id])).rows
    .map((w) => ({ item_name: w.item_name, serial_no: w.serial_no, start_date: w.start_date, parts_end: w.parts_end,
      summary: termsSummary(w.terms_snapshot) }));
  return { inv, sync: { invoice: inv, customer: cust, lines, warranties } };
}

async function pushInvoice(api: ZohoApi, id: string) {
  const ids = parseCustomFieldIds(config.ZOHO_CUSTOM_FIELD_IDS);
  const { inv, sync } = await loadInvoiceSync(pool, id);
  if (inv.zoho_invoice_id) return;
  const payload = buildInvoicePayload(sync, ids);
  // Idempotency: if an earlier attempt created the draft but we lost the response, adopt it.
  const created = (await api.findInvoiceByReference(inv.number)) ?? (await api.createInvoice(payload));
  await pool.query(
    `update sales_invoices set zoho_invoice_id=$2, zoho_invoice_number=$3, zoho_status=$4, zoho_total=$5,
       sync_status='synced', updated_at=now() where id=$1`,
    [id, created.invoice_id, created.invoice_number ?? null, created.status ?? 'draft', created.total ?? null]);
  if (created.total != null && Math.abs(created.total - inv.total) > 0.05)
    await audit(pool, null, 'invoice.total_mismatch', 'sales_invoice', id, { app: inv.total, zoho: created.total });
}

async function pushBill(api: ZohoApi, id: string) {
  const ids = parseCustomFieldIds(config.ZOHO_CUSTOM_FIELD_IDS);
  const bill = (await pool.query('select * from purchase_bills where id=$1', [id])).rows[0];
  if (bill.zoho_bill_id) return;
  const vendor = (await pool.query('select name, zoho_contact_id from vendors where id=$1', [bill.vendor_id])).rows[0];
  const lines = (await pool.query(
    `select i.name as item_name, i.zoho_item_id, l.description, l.qty, l.rate,
            i.zoho_tax_intra, i.zoho_tax_inter, t.zoho_tax_id as line_tax
       from purchase_bill_lines l join items i on i.id=l.item_id left join tax_rates t on t.id=l.tax_id
      where l.bill_id=$1 order by l.line_no`, [id])).rows
    .map(({ zoho_tax_intra, zoho_tax_inter, line_tax, ...l }) => ({
      ...l, zoho_tax_id: pickZohoTax({ intra: zoho_tax_intra, inter: zoho_tax_inter, fallback: line_tax }, bill.place_of_supply, config.HOME_PLACE_OF_SUPPLY) }));
  const payload = buildBillPayload({ bill, vendor, lines }, ids, { pos: config.ZOHO_PRODUCT === 'pos' });
  const created = (await api.findBillByReference(bill.number)) ?? (await api.createBill(payload));
  await pool.query(
    `update purchase_bills set zoho_bill_id=$2, zoho_status=$3, zoho_total=$4, sync_status='synced', updated_at=now() where id=$1`,
    [id, created.bill_id, created.status ?? 'draft', created.total ?? null]);
}

async function pushItemFields(api: ZohoApi, id: string) {
  const ids = parseCustomFieldIds(config.ZOHO_CUSTOM_FIELD_IDS);
  const item = (await pool.query(
    `select i.zoho_item_id, t.* from items i join warranty_templates t on t.id=i.warranty_template_id where i.id=$1`, [id])).rows[0];
  if (!item?.zoho_item_id) return;
  const fields = customFields(ids, 'item', {
    cf_warranty_template: item.code, cf_warranty_parts_months: item.parts_months, cf_warranty_labour_months: item.labour_months,
    cf_warranty_onsite_months: item.onsite_months, cf_warranty_terms: item.terms_text,
  });
  if (fields.length) await api.updateItemCustomFields(item.zoho_item_id, fields);
}

/** Process due outbox rows. Retries with exponential backoff; gives up (and flags the document) after MAX_ATTEMPTS. */
export async function processOutbox(api: ZohoApi, limit = 20) {
  let done = 0, failed = 0;
  // Rows left 'processing' by a crashed worker become due again once their lease expires.
  await pool.query(`update zoho_outbox set status='pending' where status='processing' and next_attempt_at < now()`);
  for (let i = 0; i < limit; i++) {
    const row = await tx(async (c) => {
      const r = (await c.query(
        `select * from zoho_outbox where status='pending' and next_attempt_at <= now()
          order by id limit 1 for update skip locked`)).rows[0];
      if (r) await c.query(
        `update zoho_outbox set status='processing', attempts=attempts+1, next_attempt_at=now() + interval '10 minutes' where id=$1`, [r.id]);
      return r;
    });
    if (!row) break;
    try {
      if (row.entity_type === 'sales_invoice') await pushInvoice(api, row.entity_id);
      else if (row.entity_type === 'purchase_bill') await pushBill(api, row.entity_id);
      else if (row.entity_type === 'item_fields') await pushItemFields(api, row.entity_id);
      await pool.query(`update zoho_outbox set status='done', done_at=now(), last_error=null where id=$1`, [row.id]);
      done++;
    } catch (e: any) {
      const retryable = !(e instanceof MappingError) && (e instanceof ZohoError ? e.retryable : true);
      const exhausted = !retryable || row.attempts + 1 >= MAX_ATTEMPTS;
      await pool.query(
        `update zoho_outbox set status=$2, last_error=$3, next_attempt_at=now() + ($4 || ' milliseconds')::interval where id=$1`,
        [row.id, exhausted ? 'failed' : 'pending', String(e.message ?? e).slice(0, 1000), String(backoffMs(row.attempts))]);
      if (exhausted) {
        const table = row.entity_type === 'sales_invoice' ? 'sales_invoices' : row.entity_type === 'purchase_bill' ? 'purchase_bills' : null;
        if (table) await pool.query(`update ${table} set sync_status='failed', updated_at=now() where id=$1`, [row.entity_id]);
      }
      failed++;
      log(`outbox ${row.id} (${row.entity_type}) ${exhausted ? 'FAILED' : 'will retry'}: ${e.message}`);
    }
  }
  return { done, failed };
}

/** Pull the latest Zoho status/total for drafts and open invoices so the app reflects accountant edits in Zoho. */
export async function refreshInvoiceStatuses(api: ZohoApi, limit = 30) {
  const rows = (await pool.query(
    `select id, zoho_invoice_id from sales_invoices
      where zoho_invoice_id is not null and coalesce(zoho_status,'') not in ('paid','void')
      order by updated_at limit $1`, [limit])).rows;
  for (const r of rows) {
    try {
      const z = await api.getInvoice(r.zoho_invoice_id);
      await pool.query(`update sales_invoices set zoho_status=$2, zoho_total=$3, zoho_invoice_number=$4, updated_at=now() where id=$1`,
        [r.id, z.status, z.total, z.invoice_number]);
    } catch (e: any) { log(`refresh ${r.id}: ${e.message}`); }
  }
  return rows.length;
}

async function record(entity: string, fn: () => Promise<string | void>) {
  try {
    const warning = (await fn()) || null;   // a warning means "mostly worked": show it, but count as synced
    await pool.query(
      `insert into zoho_sync_state (entity,last_synced_at,last_error) values ($1,now(),$2)
       on conflict (entity) do update set last_synced_at=now(), last_error=$2`, [entity, warning ? warning.slice(0, 500) : null]);
  } catch (e: any) {
    await pool.query(
      `insert into zoho_sync_state (entity,last_error) values ($1,$2)
       on conflict (entity) do update set last_error=$2`, [entity, String(e.message).slice(0, 500)]);
    log(`${entity} failed: ${e.message}`);
  }
}

/** One full cycle. Push first so an app-side edit is not overwritten by an older Zoho value on pull. */
export async function runSyncCycle(api: ZohoApi) {
  const pushed = await processOutbox(api);
  await record('taxes', async () => { await pullTaxes(api); });
  const skippedWarning = (what: string, skipped: string[]) =>
    skipped.length ? `${skipped.length} ${what} skipped — ${skipped.slice(0, 3).join('; ')}${skipped.length > 3 ? '…' : ''}` : undefined;
  await record('customers', async () => { const s: string[] = []; await pullContacts(api, 'customer', pool, s); return skippedWarning('customer(s)', s); });
  await record('vendors', async () => { const s: string[] = []; await pullContacts(api, 'vendor', pool, s); return skippedWarning('vendor(s)', s); });
  await record('items', async () => { const s: string[] = []; await pullItems(api, pool, s); return skippedWarning('item(s)', s); });
  await record('invoice_status', async () => { await refreshInvoiceStatuses(api); });
  return pushed;
}
