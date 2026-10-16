import { describe, expect, it } from 'vitest';
import { changedSince } from '../src/zoho/sync.js';
import { buildBillPayload, buildInvoicePayload, customFields, MappingError, parseCustomFieldIds, pickZohoTax, totalsMismatch, warrantyFromZohoItem } from '../src/zoho/mapper.js';

const ids = { 'invoice.cf_warranty_start': 'F1', 'invoice.cf_warranty_terms': 'F2', 'invoice.cf_app_ref': 'F4' };
const base = {
  invoice: { number: 'INV-000007', invoice_date: '2026-10-16', due_date: null, place_of_supply: 'KL', gst_treatment: 'business_gst', notes: null, terms: null },
  customer: { name: 'Ravi Stores', zoho_contact_id: 'C1' },
  lines: [{ item_name: 'Pump X', zoho_item_id: 'I1', description: null, qty: 2, rate: 1000, discount_pct: 10, zoho_tax_id: 'T1', hsn_code: '8413' }],
  warranties: [{ item_name: 'Pump X', serial_no: 'SN-1', start_date: '2026-10-16', parts_end: '2027-10-15', summary: 'Parts 12m' }],
};

describe('Zoho invoice payload', () => {
  it('maps lines with Zoho tax ids, discount and HSN, and carries the app reference', () => {
    const p: any = buildInvoicePayload(base, ids);
    expect(p).toMatchObject({ customer_id: 'C1', reference_number: 'INV-000007', date: '2026-10-16', gst_treatment: 'business_gst', place_of_supply: 'KL' });
    expect(p.line_items[0]).toEqual({ item_id: 'I1', rate: 1000, quantity: 2, discount: '10%', tax_id: 'T1', hsn_or_sac: '8413' });
    expect(p.custom_fields).toEqual([
      { customfield_id: 'F4', value: 'INV-000007' }, { customfield_id: 'F1', value: '2026-10-16' }, { customfield_id: 'F2', value: 'Pump X [SN-1]: Parts 12m' }]);
  });
  it('never sets a status or send flag, so Zoho keeps it as a draft', () => {
    const p: any = buildInvoicePayload(base, ids);
    expect(Object.keys(p)).not.toContain('status');
    expect(JSON.stringify(p)).not.toMatch(/send|sent/i);
  });
  it('skips custom fields that are not configured and omits warranty fields when nothing was issued', () => {
    expect((buildInvoicePayload(base, {}) as any).custom_fields).toEqual([]);
    const none = buildInvoicePayload({ ...base, warranties: [] }, ids) as any;
    expect(none.custom_fields).toEqual([{ customfield_id: 'F4', value: 'INV-000007' }]);
  });
  it('refuses unlinked customers and items with an actionable message', () => {
    expect(() => buildInvoicePayload({ ...base, customer: { name: 'New Co', zoho_contact_id: null } }, ids)).toThrow(MappingError);
    expect(() => buildInvoicePayload({ ...base, customer: { name: 'New Co', zoho_contact_id: null } }, ids)).toThrow(/New Co.*not linked/);
    expect(() => buildInvoicePayload({ ...base, lines: [{ ...base.lines[0], zoho_item_id: null }] }, ids)).toThrow(/Pump X.*not linked/);
  });
});

describe('Zoho bill payload', () => {
  const bill = { bill: { number: 'BILL-000003', vendor_bill_no: 'V-9', bill_date: '2026-10-01', due_date: null, place_of_supply: null, gst_treatment: null, notes: null },
    vendor: { name: 'Acme', zoho_contact_id: 'V1' }, lines: [{ item_name: 'Seal', zoho_item_id: 'I2', description: null, qty: 5, rate: 60, zoho_tax_id: null }] };
  it("uses the vendor's own bill number and keeps the app number as reference", () => {
    const p: any = buildBillPayload(bill, { 'bill.cf_app_ref': 'B1' });
    expect(p).toMatchObject({ vendor_id: 'V1', bill_number: 'V-9', reference_number: 'BILL-000003' });
    expect(p.line_items).toEqual([{ item_id: 'I2', rate: 60, quantity: 5 }]);
    expect(p.custom_fields).toEqual([{ customfield_id: 'B1', value: 'BILL-000003' }]);
  });
  it('falls back to the app number when the vendor bill number is missing', () => {
    expect((buildBillPayload({ ...bill, bill: { ...bill.bill, vendor_bill_no: null } }, {}) as any).bill_number).toBe('BILL-000003');
  });
});

describe('warranty fields on Zoho items', () => {
  it('reads custom_field_hash', () => {
    expect(warrantyFromZohoItem({ custom_field_hash: { cf_warranty_template: 'STD-1Y', cf_warranty_parts_months: '12', cf_warranty_labour_months: 6, cf_warranty_terms: 'Register in 30 days' } }))
      .toEqual({ code: 'STD-1Y', parts_months: 12, labour_months: 6, onsite_months: undefined, terms: 'Register in 30 days' });
  });
  it('reads the custom_fields array by api_name or label', () => {
    expect(warrantyFromZohoItem({ custom_fields: [{ api_name: 'cf_warranty_parts_months', value: 24 }, { label: 'Warranty Onsite Months', value: '12' }] }))
      .toMatchObject({ parts_months: 24, onsite_months: 12 });
  });
  it('returns null when there is nothing warranty-related, and ignores junk numbers', () => {
    expect(warrantyFromZohoItem({ custom_field_hash: { cf_colour: 'red' } })).toBeNull();
    expect(warrantyFromZohoItem({})).toBeNull();
    expect(warrantyFromZohoItem({ custom_field_hash: { cf_warranty_parts_months: 'abc', cf_warranty_terms: 'x' } })).toMatchObject({ parts_months: undefined, terms: 'x' });
  });
  it('parses the custom-field id map defensively', () => {
    expect(parseCustomFieldIds('{"a.b":"1"}')).toEqual({ 'a.b': '1' });
    expect(parseCustomFieldIds('not json')).toEqual({});
    expect(parseCustomFieldIds('')).toEqual({});
  });
});

describe('Zoho POS specifics', () => {
  it('picks GST (intra) or IGST (inter) by place of supply, case-insensitively', () => {
    const t = { intra: 'GST18', inter: 'IGST18', fallback: 'LINE' };
    expect(pickZohoTax(t, 'KL', 'KL')).toBe('GST18');
    expect(pickZohoTax(t, 'kl', 'KL')).toBe('GST18');
    expect(pickZohoTax(t, 'TN', 'KL')).toBe('IGST18');
    expect(pickZohoTax(t, null, 'KL')).toBe('GST18');       // no place of supply on the invoice: treat as same state
    expect(pickZohoTax(t, 'TN', '')).toBe('GST18');         // our own state not configured: cannot tell, keep intra
    expect(pickZohoTax({ fallback: 'LINE' }, 'TN', 'KL')).toBe('LINE');   // item has no per-state taxes (Books-style)
    expect(pickZohoTax({ intra: 'GST18' }, 'TN', 'KL')).toBe('GST18');
    expect(pickZohoTax({}, 'TN', 'KL')).toBeNull();
  });
  it('writes POS custom fields by slot index and label, Books fields by id, and keeps 0', () => {
    const ids = { 'invoice.cf_warranty_start': { index: 1, label: 'Warranty Start' }, 'invoice.cf_app_ref': 'BOOKS-ID', 'item.cf_warranty_parts_months': { index: 2, label: 'Parts Months' } };
    expect(customFields(ids, 'invoice', { cf_warranty_start: '2026-10-16', cf_app_ref: 'INV-1', cf_unmapped: 'x' })).toEqual([
      { index: 1, label: 'Warranty Start', value: '2026-10-16', show_on_pdf: true }, { customfield_id: 'BOOKS-ID', value: 'INV-1' }]);
    expect(customFields(ids, 'item', { cf_warranty_parts_months: 0 })).toEqual([{ index: 2, label: 'Parts Months', value: '0', show_on_pdf: true }]);
  });
  it('POS bills always carry a due date (required by POS); Books bills only when given', () => {
    const bill = { bill: { number: 'B1', vendor_bill_no: null, bill_date: '2026-10-01', due_date: null, place_of_supply: null, gst_treatment: null, notes: null },
      vendor: { name: 'V', zoho_contact_id: 'V1' }, lines: [{ item_name: 'X', zoho_item_id: 'I', description: null, qty: 1, rate: 1, zoho_tax_id: null }] };
    expect((buildBillPayload(bill, {}, { pos: true }) as any).due_date).toBe('2026-10-01');
    expect((buildBillPayload({ ...bill, bill: { ...bill.bill, due_date: '2026-11-01' } }, {}, { pos: true }) as any).due_date).toBe('2026-11-01');
    expect(Object.keys(buildBillPayload(bill, {}))).not.toContain('due_date');
  });
});

describe('deciding when to re-read an item from Zoho', () => {
  it('re-reads new or changed items, skips unchanged ones, and copes with Zoho\'s +0530 offsets', () => {
    expect(changedSince(null, '2026-10-07T15:49:27+0530')).toBe(true);                       // never seen
    expect(changedSince(new Date('2026-10-08T00:00:00Z'), '2026-10-07T15:49:27+0530')).toBe(false);   // synced after the change
    expect(changedSince(new Date('2026-10-07T09:00:00Z'), '2026-10-07T15:49:27+0530')).toBe(true);    // 10:19Z change is after 09:00Z sync
    expect(changedSince(new Date('2026-10-07T10:30:00Z'), '2026-10-07T15:49:27+0530')).toBe(false);
    expect(changedSince(new Date(), undefined)).toBe(true);                                   // no timestamp: be safe
    expect(changedSince(new Date(), 'garbage')).toBe(true);
  });
});

describe('comparing Zoho totals with the app preview', () => {
  const app = { subtotal: 0.35, tax_total: 0.06, total: 0.41 };
  it('allows for Zoho rounding the final total to a whole rupee (seen live: 0.41 came back as 0)', () => {
    expect(totalsMismatch({ sub_total: 0.35, tax_total: 0.06, total: 0 }, app)).toBe(false);
    expect(totalsMismatch({ sub_total: 11800, tax_total: 2124, total: 13924 }, { subtotal: 11800, tax_total: 2124, total: 13923.6 })).toBe(false);
  });
  it('flags a real difference in subtotal, tax or a large difference in total', () => {
    expect(totalsMismatch({ sub_total: 0.40, tax_total: 0.06, total: 0 }, app)).toBe(true);
    expect(totalsMismatch({ sub_total: 0.35, tax_total: 0.12, total: 0 }, app)).toBe(true);        // tax off by 6 paise
    expect(totalsMismatch({ sub_total: 100, tax_total: 18, total: 119 }, { subtotal: 100, tax_total: 18, total: 118 })).toBe(true);
  });
  it('ignores fields Zoho did not send', () => {
    expect(totalsMismatch({}, app)).toBe(false);
  });
});
