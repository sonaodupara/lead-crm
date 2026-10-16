import { describe, expect, it } from 'vitest';
import { addMonths, computeWarranty, coverageOn, endDate, resolveTemplateId, termsSummary } from '../src/lib/warranty.js';
import { computeLine, computeTotals, round2 } from '../src/lib/money.js';
import { scheduleVisits } from '../src/lib/amc.js';

describe('warranty dates', () => {
  it('clamps month ends', () => {
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2025-11-30', 3)).toBe('2026-02-28');
    expect(addMonths('2025-03-15', 12)).toBe('2026-03-15');
  });
  it('end date is inclusive (N months from 15 Jan ends 14 Jan)', () => {
    expect(endDate('2025-01-15', 12)).toBe('2026-01-14');
    expect(endDate('2025-01-31', 1)).toBe('2025-02-27');
    expect(endDate('2025-01-15', 0)).toBeNull();
  });
  it('computes each component and applies extension only to covered components', () => {
    const t = { parts_months: 12, labour_months: 6, onsite_months: 0 };
    expect(computeWarranty(t, '2025-06-01')).toEqual({ parts_end: '2026-05-31', labour_end: '2025-11-30', onsite_end: null });
    expect(computeWarranty(t, '2025-06-01', 12)).toEqual({ parts_end: '2027-05-31', labour_end: '2026-11-30', onsite_end: null });
  });
  it('coverage status reflects per-component expiry and void', () => {
    const w = { parts_end: '2026-05-31', labour_end: '2025-11-30', onsite_end: null };
    const s = coverageOn(w, '2026-01-10');
    expect(s.in_warranty).toBe(true);
    expect(s.active).toEqual(['parts']);
    expect(s.expired).toEqual(['labour']);
    expect(s.days_left).toBe(141);
    expect(coverageOn(w, '2026-06-01').in_warranty).toBe(false);
    expect(coverageOn({ ...w, status: 'void' }, '2026-01-10').in_warranty).toBe(false);
    // last day is still covered
    expect(coverageOn(w, '2026-05-31').in_warranty).toBe(true);
  });
  it('resolves template: batch > item > category > brand > default', () => {
    const rules = [
      { scope: 'default' as const, scope_value: null, template_id: 'D' },
      { scope: 'brand' as const, scope_value: 'Acme', template_id: 'B' },
      { scope: 'category' as const, scope_value: 'Pumps', template_id: 'C' },
    ];
    const base = { category: 'pumps', brand: 'ACME', rules };
    expect(resolveTemplateId({ ...base, batchTemplateId: 'X', itemTemplateId: 'I' })).toBe('X');
    expect(resolveTemplateId({ ...base, itemTemplateId: 'I' })).toBe('I');
    expect(resolveTemplateId(base)).toBe('C');
    expect(resolveTemplateId({ ...base, category: 'Other' })).toBe('B');
    expect(resolveTemplateId({ ...base, category: 'Other', brand: 'Zed' })).toBe('D');
    expect(resolveTemplateId({ rules: [] })).toBeNull();
  });
  it('terms summary', () => {
    expect(termsSummary({ parts_months: 12, labour_months: 6, onsite_months: 0, terms_text: 'Register in 30 days.' }))
      .toBe('Parts 12m, Labour 6m. Register in 30 days.');
    expect(termsSummary({ parts_months: 0, labour_months: 0, onsite_months: 0 })).toBe('No warranty');
  });
});

describe('money', () => {
  it('avoids float drift', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(computeLine({ qty: 3, rate: 19.99, tax_pct: 18 })).toEqual({ amount: 59.97, tax: 10.79 });
  });
  it('applies discount before tax and sums per line', () => {
    const t = computeTotals([
      { qty: 2, rate: 1000, discount_pct: 10, tax_pct: 18 },
      { qty: 1, rate: 500, tax_pct: 0 },
    ]);
    expect(t).toEqual({ subtotal: 2300, tax_total: 324, total: 2624 });
  });
});

describe('AMC visit schedule', () => {
  it('2 visits in a year are ~6 months apart and inside the term', () => {
    const v = scheduleVisits('2025-01-01', '2025-12-31', 2);
    expect(v).toHaveLength(2);
    expect(v[0] > '2025-01-01' && v[1] < '2025-12-31').toBe(true);
    expect(v[0]).toBe('2025-04-02');
    expect(v[1]).toBe('2025-10-01');
  });
  it('quarterly gives 4, short contract still gets one', () => {
    expect(scheduleVisits('2025-01-01', '2025-12-31', 4)).toHaveLength(4);
    expect(scheduleVisits('2025-01-01', '2025-01-31', 1).length).toBe(1);
  });
});
