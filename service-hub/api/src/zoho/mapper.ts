/**
 * Pure mapping between app records and Zoho Books payloads.
 * Taxes are never computed or hard-coded here: each line carries the Zoho tax_id synced from
 * the organisation's own tax setup, and Zoho calculates the final amounts.
 */

export type CustomFieldIds = Record<string, string>; // 'invoice.cf_warranty_start' -> Zoho customfield_id

export function parseCustomFieldIds(raw: string): CustomFieldIds {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function customFields(ids: CustomFieldIds, entity: string, values: Record<string, unknown>) {
  const out: { customfield_id: string; value: unknown }[] = [];
  for (const [name, value] of Object.entries(values)) {
    const id = ids[`${entity}.${name}`];
    if (id && value !== undefined && value !== null && value !== '') out.push({ customfield_id: id, value });
  }
  return out;
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

export function buildBillPayload(s: BillSync, ids: CustomFieldIds) {
  if (!s.vendor.zoho_contact_id) throw new MappingError(`Vendor "${s.vendor.name}" is not linked to a Zoho contact — sync contacts or link it first`);
  for (const l of s.lines) if (!l.zoho_item_id) throw new MappingError(`Item "${l.item_name}" is not linked to a Zoho item`);
  return {
    vendor_id: s.vendor.zoho_contact_id,
    bill_number: s.bill.vendor_bill_no || s.bill.number,
    reference_number: s.bill.number,
    date: s.bill.bill_date,
    ...(s.bill.due_date ? { due_date: s.bill.due_date } : {}),
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
