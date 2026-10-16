/** Pure warranty logic. Dates are 'YYYY-MM-DD' strings (UTC, no timezone drift). */

export interface WarrantyTemplateLike {
  id?: string;
  code?: string;
  name?: string;
  parts_months: number;
  labour_months: number;
  onsite_months: number;
  start_trigger?: string;
  coverage?: string[];
  exclusions?: string | null;
  conditions?: string | null;
  transferable?: boolean;
  registration_days?: number | null;
  extendable?: boolean;
  terms_text?: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`Invalid date: ${s}`);
  return new Date(Date.UTC(y, m - 1, d));
}
export const fmtDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Add calendar months, clamping to the last day of the target month (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const d = parseDate(date);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return fmtDate(target);
}

export function addDays(date: string, days: number): string {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fmtDate(d);
}

/** Warranty of N months from 15 Jan runs through 14 Jan (inclusive end date). */
export function endDate(start: string, months: number): string | null {
  if (months <= 0) return null;
  return addDays(addMonths(start, months), -1);
}

export interface WarrantyDates {
  parts_end: string | null;
  labour_end: string | null;
  onsite_end: string | null;
}

export function computeWarranty(t: WarrantyTemplateLike, start: string, extendedMonths = 0): WarrantyDates {
  const ext = (m: number) => (m > 0 ? m + extendedMonths : 0);
  return {
    parts_end: endDate(start, ext(t.parts_months)),
    labour_end: endDate(start, ext(t.labour_months)),
    onsite_end: endDate(start, ext(t.onsite_months)),
  };
}

export type CoverageComponent = 'parts' | 'labour' | 'onsite';
export interface CoverageStatus {
  in_warranty: boolean;
  active: CoverageComponent[];
  expired: CoverageComponent[];
  ends_on: string | null; // latest end across components
  days_left: number | null;
}

export function coverageOn(w: WarrantyDates & { status?: string }, on: string): CoverageStatus {
  const comps: [CoverageComponent, string | null][] = [
    ['parts', w.parts_end],
    ['labour', w.labour_end],
    ['onsite', w.onsite_end],
  ];
  const void_ = w.status === 'void';
  const active = comps.filter(([, e]) => !void_ && e && e >= on).map(([c]) => c);
  const expired = comps.filter(([, e]) => e && (void_ || e < on)).map(([c]) => c);
  const ends = comps.map(([, e]) => e).filter(Boolean) as string[];
  const latest = ends.length ? ends.sort().at(-1)! : null;
  const days = latest ? Math.round((parseDate(latest).getTime() - parseDate(on).getTime()) / 86_400_000) : null;
  return { in_warranty: active.length > 0, active, expired, ends_on: latest, days_left: days };
}

export interface TemplateRule {
  scope: 'category' | 'brand' | 'default';
  scope_value: string | null;
  template_id: string;
}

/**
 * Which template applies to a unit being sold.
 * Order: batch override > item template > category rule > brand rule > default rule.
 * (A per-serial override is applied by the caller after this returns.)
 */
export function resolveTemplateId(args: {
  batchTemplateId?: string | null;
  itemTemplateId?: string | null;
  category?: string | null;
  brand?: string | null;
  rules: TemplateRule[];
}): string | null {
  if (args.batchTemplateId) return args.batchTemplateId;
  if (args.itemTemplateId) return args.itemTemplateId;
  const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  const cat = args.rules.find((r) => r.scope === 'category' && eq(r.scope_value, args.category));
  if (cat) return cat.template_id;
  const brand = args.rules.find((r) => r.scope === 'brand' && eq(r.scope_value, args.brand));
  if (brand) return brand.template_id;
  return args.rules.find((r) => r.scope === 'default')?.template_id ?? null;
}

/** Frozen copy stored with each warranty so later template edits never rewrite sold warranties. */
export function snapshotTerms(t: WarrantyTemplateLike) {
  return {
    code: t.code ?? null,
    name: t.name ?? null,
    parts_months: t.parts_months,
    labour_months: t.labour_months,
    onsite_months: t.onsite_months,
    start_trigger: t.start_trigger ?? 'invoice_date',
    coverage: t.coverage ?? [],
    exclusions: t.exclusions ?? null,
    conditions: t.conditions ?? null,
    transferable: t.transferable ?? false,
    registration_days: t.registration_days ?? null,
    terms_text: t.terms_text ?? null,
  };
}

/** One-line summary written to Zoho custom fields and printed on the invoice. */
export function termsSummary(t: WarrantyTemplateLike): string {
  const parts: string[] = [];
  if (t.parts_months) parts.push(`Parts ${t.parts_months}m`);
  if (t.labour_months) parts.push(`Labour ${t.labour_months}m`);
  if (t.onsite_months) parts.push(`On-site ${t.onsite_months}m`);
  const head = parts.length ? parts.join(', ') : 'No warranty';
  return t.terms_text ? `${head}. ${t.terms_text}` : head;
}
