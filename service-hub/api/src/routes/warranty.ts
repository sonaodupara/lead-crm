import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, pool, tx } from '../db.js';
import { actor, ANY, roles } from '../auth.js';
import { fail } from '../lib/errors.js';
import { today } from '../lib/jobs.js';
import { computeWarranty, coverageOn, termsSummary } from '../lib/warranty.js';

const tplBody = z.object({
  code: z.string().min(1).max(40), name: z.string().min(1),
  parts_months: z.number().int().min(0).default(0), labour_months: z.number().int().min(0).default(0),
  onsite_months: z.number().int().min(0).default(0),
  start_trigger: z.enum(['invoice_date', 'delivery_date', 'installation_date', 'manufacture_date']).default('invoice_date'),
  coverage: z.array(z.string()).default([]), exclusions: z.string().nullable().optional(), conditions: z.string().nullable().optional(),
  transferable: z.boolean().default(false), registration_days: z.number().int().positive().nullable().optional(),
  extendable: z.boolean().default(false), terms_text: z.string().nullable().optional(), active: z.boolean().default(true),
});

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export default async function warranty(app: FastifyInstance) {
  app.get('/api/warranty-templates', { preHandler: roles(...ANY) }, async () =>
    (await pool.query(
      `select t.*, (select count(*) from items i where i.warranty_template_id=t.id)::int as items_using
         from warranty_templates t order by t.active desc, t.name`)).rows);

  app.post('/api/warranty-templates', { preHandler: roles('supervisor') }, async (req) => {
    const b = tplBody.parse(req.body);
    const r = await pool.query(
      `insert into warranty_templates (code,name,parts_months,labour_months,onsite_months,start_trigger,coverage,exclusions,conditions,
         transferable,registration_days,extendable,terms_text,active) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [b.code, b.name, b.parts_months, b.labour_months, b.onsite_months, b.start_trigger, JSON.stringify(b.coverage),
       b.exclusions ?? null, b.conditions ?? null, b.transferable, b.registration_days ?? null, b.extendable, b.terms_text ?? null, b.active]);
    await audit(pool, actor(req).id, 'warranty_template.create', 'warranty_template', r.rows[0].id);
    return r.rows[0];
  });

  // Editing a template never rewrites warranties already sold: each keeps its own terms_snapshot.
  app.put('/api/warranty-templates/:id', { preHandler: roles('supervisor') }, async (req) => {
    const b = tplBody.parse(req.body);
    const r = await pool.query(
      `update warranty_templates set code=$2,name=$3,parts_months=$4,labour_months=$5,onsite_months=$6,start_trigger=$7,coverage=$8,
         exclusions=$9,conditions=$10,transferable=$11,registration_days=$12,extendable=$13,terms_text=$14,active=$15,updated_at=now()
       where id=$1 returning *`,
      [(req.params as any).id, b.code, b.name, b.parts_months, b.labour_months, b.onsite_months, b.start_trigger, JSON.stringify(b.coverage),
       b.exclusions ?? null, b.conditions ?? null, b.transferable, b.registration_days ?? null, b.extendable, b.terms_text ?? null, b.active]);
    if (!r.rows[0]) fail(404, 'Template not found');
    await audit(pool, actor(req).id, 'warranty_template.update', 'warranty_template', r.rows[0].id);
    return r.rows[0];
  });

  app.get('/api/warranty-rules', { preHandler: roles('supervisor', 'accountant') }, async () =>
    (await pool.query(`select r.*, t.code, t.name as template_name from warranty_rules r join warranty_templates t on t.id=r.template_id
                        order by r.scope, r.scope_value`)).rows);
  app.post('/api/warranty-rules', { preHandler: roles('supervisor') }, async (req) => {
    const b = z.object({ template_id: z.string().uuid(), scope: z.enum(['category', 'brand', 'default']),
      scope_value: z.string().nullable().optional() }).parse(req.body);
    const r = await pool.query(
      `insert into warranty_rules (template_id,scope,scope_value) values ($1,$2,$3)
       on conflict (scope, coalesce(lower(scope_value), '')) do update set template_id=excluded.template_id returning *`,
      [b.template_id, b.scope, b.scope === 'default' ? null : b.scope_value ?? fail(400, 'scope_value is required')]);
    return r.rows[0];
  });
  app.delete('/api/warranty-rules/:id', { preHandler: roles('supervisor') }, async (req) => {
    await pool.query('delete from warranty_rules where id=$1', [(req.params as any).id]);
    return { ok: true };
  });

  // ── issued warranties ──
  app.get('/api/warranties', { preHandler: roles(...ANY) }, async (req) => {
    const { expiring_days, customer_id, q, status } = z.object({
      expiring_days: z.coerce.number().int().positive().optional(), customer_id: z.string().uuid().optional(),
      q: z.string().optional(), status: z.enum(['active', 'void', 'expired']).optional() }).parse(req.query);
    const rows = (await pool.query(
      `select w.id, w.start_date, w.parts_end, w.labour_end, w.onsite_end, w.status, w.extended_months,
              s.serial_no, s.id as serial_id, i.name as item_name, c.name as customer, c.phone, si.number as invoice_number, t.code as template
         from warranties w join serial_units s on s.id=w.serial_id join items i on i.id=s.item_id
         join customers c on c.id=w.customer_id join sales_invoices si on si.id=w.sale_invoice_id
         left join warranty_templates t on t.id=w.template_id
        where ($1::uuid is null or w.customer_id=$1)
          and ($2::text is null or lower(s.serial_no) like $2 or lower(c.name) like $2 or c.phone like $2)
        order by greatest(w.parts_end, w.labour_end, w.onsite_end) nulls last limit 500`,
      [customer_id ?? null, q ? `%${q.toLowerCase()}%` : null])).rows;
    const on = today();
    let out = rows.map((w) => ({ ...w, coverage: coverageOn(w, on) }));
    if (status === 'active') out = out.filter((w) => w.coverage.in_warranty);
    if (status === 'expired') out = out.filter((w) => !w.coverage.in_warranty && w.status === 'active');
    if (status === 'void') out = out.filter((w) => w.status === 'void');
    if (expiring_days) out = out.filter((w) => w.coverage.in_warranty && (w.coverage.days_left ?? 9999) <= expiring_days);
    return out;
  });

  app.get('/api/warranties/:id', { preHandler: roles(...ANY) }, async (req) => {
    const w = (await pool.query(
      `select w.*, s.serial_no, i.name as item_name, i.sku, c.name as customer, c.phone, si.number as invoice_number,
              si.invoice_date, t.code as template_code
         from warranties w join serial_units s on s.id=w.serial_id join items i on i.id=s.item_id
         join customers c on c.id=w.customer_id join sales_invoices si on si.id=w.sale_invoice_id
         left join warranty_templates t on t.id=w.template_id where w.id=$1`, [(req.params as any).id])).rows[0];
    if (!w) fail(404, 'Warranty not found');
    const extensions = (await pool.query('select * from warranty_extensions where warranty_id=$1 order by created_at', [w.id])).rows;
    return { ...w, extensions, coverage: coverageOn(w, today()) };
  });

  app.post('/api/warranties/:id/extend', { preHandler: roles('supervisor', 'accountant') }, async (req) => {
    const b = z.object({ months: z.number().int().positive().max(120), price: z.number().min(0).default(0) }).parse(req.body);
    return tx(async (c) => {
      const w = (await c.query('select * from warranties where id=$1 for update', [(req.params as any).id])).rows[0];
      if (!w) fail(404, 'Warranty not found');
      if (w.status !== 'active') fail(409, 'Warranty is void');
      const snap = w.terms_snapshot;
      const tpl = w.template_id ? (await c.query('select extendable from warranty_templates where id=$1', [w.template_id])).rows[0] : null;
      if (tpl && !tpl.extendable) fail(409, 'This warranty template does not allow extensions');
      const total = w.extended_months + b.months;
      const dates = computeWarranty(snap, w.start_date, total);
      await c.query(
        `update warranties set extended_months=$2, parts_end=$3, labour_end=$4, onsite_end=$5 where id=$1`,
        [w.id, total, dates.parts_end, dates.labour_end, dates.onsite_end]);
      await c.query('insert into warranty_extensions (warranty_id,months,price,created_by) values ($1,$2,$3,$4)',
        [w.id, b.months, b.price, actor(req).id]);
      await audit(c, actor(req).id, 'warranty.extend', 'warranty', w.id, b);
      return { ...dates, extended_months: total };
    });
  });

  app.post('/api/warranties/:id/void', { preHandler: roles('supervisor') }, async (req) => {
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
    const r = await pool.query(`update warranties set status='void', void_reason=$2 where id=$1 returning id`, [(req.params as any).id, reason]);
    if (!r.rowCount) fail(404, 'Warranty not found');
    await audit(pool, actor(req).id, 'warranty.void', 'warranty', (req.params as any).id, { reason });
    return { ok: true };
  });

  // Printable certificate (browser "Save as PDF"). Terms come from the snapshot taken at sale.
  app.get('/api/warranties/:id/certificate', { preHandler: roles(...ANY) }, async (req, reply) => {
    const w = (await pool.query(
      `select w.*, s.serial_no, i.name as item_name, i.sku, c.name as customer, si.number as invoice_number, si.invoice_date
         from warranties w join serial_units s on s.id=w.serial_id join items i on i.id=s.item_id
         join customers c on c.id=w.customer_id join sales_invoices si on si.id=w.sale_invoice_id where w.id=$1`,
      [(req.params as any).id])).rows[0];
    if (!w) fail(404, 'Warranty not found');
    const t = w.terms_snapshot;
    const company = (await pool.query(`select value from settings where key='company'`)).rows[0]?.value ?? {};
    const li = (label: string, v: unknown) => (v ? `<tr><th>${esc(label)}</th><td>${esc(v)}</td></tr>` : '');
    reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Warranty ${esc(w.serial_no)}</title>
<style>body{font:14px system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#111}h1{font-size:20px}
table{border-collapse:collapse;width:100%;margin:12px 0}th{text-align:left;width:34%;color:#555;font-weight:600}th,td{padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top}
.terms{white-space:pre-wrap;border:1px solid #ddd;padding:10px;border-radius:6px}@media print{button{display:none}}</style></head><body>
<h1>${esc(company.name ?? 'Warranty Certificate')}</h1><p>Warranty certificate</p>
<table>${li('Customer', w.customer)}${li('Product', `${w.item_name} (${w.sku})`)}${li('Serial number', w.serial_no)}
${li('Invoice', `${w.invoice_number} dated ${w.invoice_date}`)}${li('Warranty starts', w.start_date)}
${li('Parts cover until', w.parts_end)}${li('Labour cover until', w.labour_end)}${li('On-site cover until', w.onsite_end)}
${li('Covers', (t.coverage ?? []).join(', '))}${li('Exclusions', t.exclusions)}${li('Conditions', t.conditions)}
${li('Transferable', t.transferable ? 'Yes' : 'No')}</table>
<div class="terms">${esc(t.terms_text ?? termsSummary(t))}</div>
<p><button onclick="window.print()">Print / Save as PDF</button></p></body></html>`);
  });
}
