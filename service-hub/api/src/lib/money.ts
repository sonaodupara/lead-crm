/** Money helpers. All arithmetic goes through integer paise to avoid float drift. */
export const toPaise = (n: number) => Math.round((n + Number.EPSILON) * 100);
export const fromPaise = (p: number) => p / 100;
export const round2 = (n: number) => fromPaise(toPaise(n));

export interface LineInput {
  qty: number;
  rate: number;
  discount_pct?: number;
  tax_pct?: number; // percentage from the synced Zoho tax record; never hard-coded
}

/** Pre-tax amount and tax for one line. Zoho stays authoritative: the app total is a preview. */
export function computeLine(l: LineInput) {
  const gross = toPaise(l.qty * l.rate);
  const discount = Math.round(gross * ((l.discount_pct ?? 0) / 100));
  const net = gross - discount;
  const tax = Math.round(net * ((l.tax_pct ?? 0) / 100));
  return { amount: fromPaise(net), tax: fromPaise(tax) };
}

export function computeTotals(lines: LineInput[]) {
  let sub = 0;
  let tax = 0;
  for (const l of lines) {
    const r = computeLine(l);
    sub += toPaise(r.amount);
    tax += toPaise(r.tax);
  }
  return { subtotal: fromPaise(sub), tax_total: fromPaise(tax), total: fromPaise(sub + tax) };
}
