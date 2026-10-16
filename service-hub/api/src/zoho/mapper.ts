/**
 * Pure mapping between app records and Zoho Books payloads.
 * Taxes are never computed or hard-coded here: each line carries the Zoho tax_id synced from
 * the organisation's own tax setup, and Zoho calculates the final amounts.
 */

/**
 * 'invoice.cf_warranty_start' -> how Zoho identifies the field.
 *  - Books: the customfield_id string.
 *  - POS:   the field's slot and label, {"index": 1, "label": "Warranty Start"}.
 */
export type CustomFieldIds = Record<string, string | { index: number; label: string }>;

export function parseCustomFieldIds(raw: string): CustomFieldIds {
  try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

export function customFields(ids: CustomFieldIds, entity: string, values: Record<string, unknown>) {
  const out: object[] = [];
  for (const [name, value] of Object.entries(values)) {
    const ref = ids[`${entity}.${name}`];
    if (!ref || value === undefined || value === null || value === '') continue;
    out.push(typeof ref === 'string'
      ? { customfield_id: ref, value }
      : { index: ref.index, label: ref.label, value: String(value), show_on_pdf: true });
  }
  return out;
}

/**
 * Which Zoho tax record a line should carry. POS keeps a GST tax group (same state) and an IGST tax (other state)
 * per item; a sale to a different place of supply than our own uses the IGST one.
 */
export function pickZohoTax(
  t: { intra?: string | null; inter?: string | null; fallback?: string | null },
  placeOfSupply: string | null | undefined,
  home: string | null | undefined,
): string | null {
  const norm = (s?: string | null) => (s ?? '').trim().toUpperCase();
  const other = norm(placeOfSupply) && norm(home) && norm(placeOfSupply) !== norm(home);
  if (t.intra && t.inter) return other ? t.inter : t.intra;
  return t.inter && other ? t.inter : t.intra ?? t.inter ?? t.fallback ?? null;
}

export class MappingError extends Error {} // non-retryable: needs a human to fix the data

export interface InvoiceSync {
  invoice: { number: string; invoice_date: string; due_date: string | null; place_of_supply: string | null;
    gst_treatment: string | null; notes: string | null; terms: string | null };
  customer: { name: string; zoho_contact_id: string | null };
  lines: { item_name: string; zoho_item_id: string | null; description: string | null; qty: number; rate: number;
    discount_pct: number; zoho_tax_id: string | null; hsn_code: string | null }[];
  warranties: { item_name: string; serial_no: string; start_date: string; parts_end: string | null; summary: string }[];
}

export function buildInvoicePayload(s: InvoiceSync, ids: CustomFieldIds) {
  if (!s.customer.zoho_contact_id) throw new MappingError(`Customer "${s.customer.name}" is not linked to a Zoho contact — sync contacts or link it first`);
  for (const l of s.lines) if (!l.zoho_item_id) throw new MappingError(`Item "${l.item_name}" is not linked to a Zoho item`);
  const terms = s.warranties.map((w) => `${w.item_name} [${w.serial_no}]: ${w.summary}`).join('\n');
  return {
    customer_id: s.customer.zoho_contact_id,
    reference_number: s.invoice.number,
    date: s.invoice.invoice_date,
    ...(s.invoice.due_date ? { due_date: s.invoice.due_date } : {}),
    ...(s.invoice.gst_treatment ? { gst_treatment: s.invoice.gst_treatment } : {}),
    ...(s.invoice.place_of_supply ? { place_of_supply: s.invoice.place_of_supply } : {}),
    ...(s.invoice.notes ? { notes: s.invoice.notes } : {}),
    ...(s.invoice.terms ? { terms: s.invoice.terms } : {}),
    line_items: s.lines.map((l) => ({
      item_id: l.zoho_item_id, ...(l.description ? { description: l.description } : {}),
      rate: l.rate, quantity: l.qty,
      ...(l.discount_pct ? { discount: `${l.discount_pct}%` } : {}),
      ...(l.zoho_tax_id ? { tax_id: l.zoho_tax_id } : {}),
      ...(l.hsn_code ? { hsn_or_sac: l.hsn_code } : {}),
    })),
    custom_fields: customFields(ids, 'invoice', {
      cf_app_ref: s.invoice.number,
      cf_warranty_start: s.warranties.length ? s.invoice.invoice_date : undefined,
      cf_warranty_terms: terms,
      cf_serial_numbers: s.warranties.map((w) => `${w.item_name}: ${w.serial_no}`).join(', '),
    }),
    // No `status`/send flags: Zoho creates invoices as drafts for the accountant to review.
  };
}

export interface BillSync {
  bill: { number: string; vendor_bill_no: string | null; bill_date: string; due_date: string | null;
    place_of_supply: string | null; gst_treatment: string | null; notes: string | null };
  vendor: { name: string; zoho_contact_id: string | null };
  lines: { item_name: string; zoho_item_id: string | null; description: string | null; qty: number; rate: number; zoho_tax_id: string | null }[];
}

/** `pos: true` adds what Zoho POS requires on a bill (a due date). */
export function buildBillPayload(s: BillSync, ids: CustomFieldIds, opts: { pos?: boolean } = {}) {
  if (!s.vendor.zoho_contact_id) throw new MappingError(`Vendor "${s.vendor.name}" is not linked to a Zoho contact — sync contacts or link it first`);
  for (const l of s.lines) if (!l.zoho_item_id) throw new MappingError(`Item "${l.item_name}" is not linked to a Zoho item`);
  return {
    vendor_id: s.vendor.zoho_contact_id,
    bill_number: s.bill.vendor_bill_no || s.bill.number,
    reference_number: s.bill.number,
    date: s.bill.bill_date,
    ...(s.bill.due_date || opts.pos ? { due_date: s.bill.due_date ?? s.bill.bill_date } : {}),
    ...(s.bill.gst_treatment ? { gst_treatment: s.bill.gst_treatment } : {}),
    ...(s.bill.place_of_supply ? { source_of_supply: s.bill.place_of_supply } : {}),
    ...(s.bill.notes ? { notes: s.bill.notes } : {}),
    line_items: s.lines.map((l) => ({
      item_id: l.zoho_item_id, ...(l.description ? { description: l.description } : {}),
      rate: l.rate, quantity: l.qty, ...(l.zoho_tax_id ? { tax_id: l.zoho_tax_id } : {}),
    })),
    custom_fields: customFields(ids, 'bill', { cf_app_ref: s.bill.number }),
  };
}

// ───────────────────────── Zoho item custom fields -> app warranty ─────────────────────────
export interface ZohoItemWarranty {
  code?: string; parts_months?: number; labour_months?: number; onsite_months?: number; terms?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Read warranty fields from a Zoho item; handles both `custom_field_hash` and the `custom_fields` array. */
export function warrantyFromZohoItem(item: any): ZohoItemWarranty | null {
  const bag: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item?.custom_field_hash ?? {})) bag[norm(k)] = v;
  for (const f of item?.custom_fields ?? []) {
    for (const key of [f.api_name, f.label]) if (key) bag[norm(String(key))] ??= f.value;
  }
  const get = (...names: string[]) => names.map((n) => bag[norm(n)]).find((v) => v !== undefined && v !== null && v !== '');
  const num = (v: unknown) => {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const out: ZohoItemWarranty = {
    code: get('cf_warranty_template', 'warranty_template') as string | undefined,
    parts_months: num(get('cf_warranty_parts_months', 'warranty_parts_months')),
    labour_months: num(get('cf_warranty_labour_months', 'warranty_labour_months')),
    onsite_months: num(get('cf_warranty_onsite_months', 'warranty_onsite_months')),
    terms: get('cf_warranty_terms', 'warranty_terms') as string | undefined,
  };
  const has = out.code || out.parts_months !== undefined || out.labour_months !== undefined ||
    out.onsite_months !== undefined || out.terms;
  return has ? out : null;
}

/**
 * Does Zoho's version of a document disagree with the app's preview? Zoho may round the final total to a whole
 * rupee, so the total gets up to 50 paise of room; subtotal and tax must match almost exactly.
 */
export function totalsMismatch(
  zoho: { sub_total?: number; tax_total?: number; total?: number },
  app: { subtotal: number; tax_total: number; total: number },
): boolean {
  const off = (a: number | undefined, b: number, tol: number) => a != null && Math.abs(a - b) > tol;
  return off(zoho.sub_total, app.subtotal, 0.05) || off(zoho.tax_total, app.tax_total, 0.05) || off(zoho.total, app.total, 0.5);
}
