import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, pool } from '../db.js';
import { actor, ANY, authed, OFFICE, roles } from '../auth.js';
import { fail } from '../lib/errors.js';
import { enqueueZoho } from '../lib/outbox.js';
import { zohoEnabled } from '../config.js';

const addr = z.object({ line1: z.string().optional(), line2: z.string().optional(), city: z.string().optional(),
  state: z.string().optional(), pincode: z.string().optional() }).partial().nullable().optional();

const party = z.object({
  name: z.string().min(1), phone: z.string().nullable().optional(), email: z.string().email().nullable().optional().or(z.literal('')),
  gstin: z.string().nullable().optional(), gst_treatment: z.string().nullable().optional(),
  place_of_supply: z.string().nullable().optional(), billing_address: addr, shipping_address: addr,
});

export default async function masters(app: FastifyInstance) {
  for (const [path, table] of [['customers', 'customers'], ['vendors', 'vendors']] as const) {
    app.get(`/api/${path}`, { preHandler: roles(...ANY) }, async (req) => {
      const { q, limit } = z.object({ q: z.string().optional(), limit: z.coerce.number().max(500).default(100) }).parse(req.query);
      const like = q ? `%${q.toLowerCase()}%` : null;
      return (await pool.query(
        `select id,name,phone,email,gstin,gst_treatment,place_of_supply,zoho_contact_id is not null as linked
           from ${table} where ($1::text is null or lower(name) like $1 or phone like $1) order by name limit $2`,
        [like, limit])).rows;
    });
    app.get(`/api/${path}/:id`, { preHandler: roles(...ANY) }, async (req) => {
      const r = (await pool.query(`select * from ${table} where id=$1`, [(req.params as any).id])).rows[0];
      return r ?? fail(404, 'Not found');
    });
    app.post(`/api/${path}`, { preHandler: roles(...OFFICE) }, async (req) => {
      const b = party.parse(req.body);
      const r = await pool.query(
        `insert into ${table} (name,phone,email,gstin,gst_treatment,place_of_supply,billing_address)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [b.name, b.phone ?? null, b.email || null, b.gstin ?? null, b.gst_treatment ?? null, b.place_of_supply ?? null,
         b.billing_address ? JSON.stringify(b.billing_address) : null]);
      return r.rows[0];
    });
    app.patch(`/api/${path}/:id`, { preHandler: roles(...OFFICE) }, async (req) => {
      const b = party.partial().parse(req.body);
      const r = await pool.query(
        `update ${table} set name=coalesce($2,name), phone=coalesce($3,phone), email=coalesce($4,email),
           gstin=coalesce($5,gstin), gst_treatment=coalesce($6,gst_treatment), place_of_supply=coalesce($7,place_of_supply),
           updated_at=now() where id=$1 returning *`,
        [(req.params as any).id, b.name ?? null, b.phone ?? null, b.email || null, b.gstin ?? null, b.gst_treatment ?? null,
         b.place_of_supply ?? null]);
      return r.rows[0] ?? fail(404, 'Not found');
    });
  }

  app.get('/api/taxes', { preHandler: roles(...OFFICE) }, async () =>
    (await pool.query('select id,name,percentage,tax_type from tax_rates where active order by name')).rows);

  app.get('/api/locations', { preHandler: authed }, async () =>
    (await pool.query('select id,name,kind from locations where active order by name')).rows);
  app.post('/api/locations', { preHandler: roles('supervisor') }, async (req) => {
    const b = z.object({ name: z.string().min(1), kind: z.enum(['store', 'van', 'site']).default('store') }).parse(req.body);
    return (await pool.query('insert into locations (name,kind) values ($1,$2) returning *', [b.name, b.kind])).rows[0];
  });

  // ── items ──
  app.get('/api/items', { preHandler: roles(...ANY) }, async (req) => {
    const { q, limit, track } = z.object({ q: z.string().optional(), limit: z.coerce.number().max(1000).default(200),
      track: z.enum(['none', 'batch', 'serial']).optional() }).parse(req.query);
    const like = q ? `%${q.toLowerCase()}%` : null;
    return (await pool.query(
      `select i.id,i.sku,i.name,i.brand,i.category,i.unit,i.track_mode,i.rate,i.purchase_rate,i.tax_id,i.is_service,i.active,
              i.warranty_template_id, w.code as warranty_code, i.zoho_item_id is not null as linked
         from items i left join warranty_templates w on w.id=i.warranty_template_id
        where i.active and ($1::text is null or lower(i.name) like $1 or lower(i.sku) like $1)
          and ($3::text is null or i.track_mode=$3) order by i.name limit $2`, [like, limit, track ?? null])).rows;
  });

  const itemBody = z.object({
    sku: z.string().min(1), name: z.string().min(1), brand: z.string().nullable().optional(), category: z.string().nullable().optional(),
    hsn_code: z.string().nullable().optional(), unit: z.string().default('nos'), track_mode: z.enum(['none', 'batch', 'serial']).default('none'),
    rate: z.number().min(0).default(0), purchase_rate: z.number().min(0).default(0), tax_id: z.string().uuid().nullable().optional(),
    reorder_level: z.number().min(0).default(0), warranty_template_id: z.string().uuid().nullable().optional(),
    is_service: z.boolean().default(false),
  });

  app.post('/api/items', { preHandler: roles('supervisor', 'accountant') }, async (req) => {
    const b = itemBody.parse(req.body);
    const r = await pool.query(
      `insert into items (sku,name,brand,category,hsn_code,unit,track_mode,rate,purchase_rate,tax_id,reorder_level,warranty_template_id,is_service)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [b.sku, b.name, b.brand ?? null, b.category ?? null, b.hsn_code ?? null, b.unit, b.track_mode, b.rate, b.purchase_rate,
       b.tax_id ?? null, b.reorder_level, b.warranty_template_id ?? null, b.is_service]);
    await audit(pool, actor(req).id, 'item.create', 'item', r.rows[0].id);
    return r.rows[0];
  });

  app.get('/api/items/:id', { preHandler: roles(...ANY) }, async (req) => {
    const r = (await pool.query(
      `select i.*, w.code as warranty_code, w.name as warranty_name from items i
         left join warranty_templates w on w.id=i.warranty_template_id where i.id=$1`, [(req.params as any).id])).rows[0];
    return r ?? fail(404, 'Item not found');
  });

  app.patch('/api/items/:id', { preHandler: roles('supervisor', 'accountant') }, async (req) => {
    const id = (req.params as any).id;
    const b = itemBody.partial().parse(req.body);
    const before = (await pool.query('select warranty_template_id, track_mode from items where id=$1', [id])).rows[0];
    if (!before) fail(404, 'Item not found');
    if (b.track_mode && b.track_mode !== before.track_mode) {
      const used = await pool.query('select 1 from stock_movements where item_id=$1 limit 1', [id]);
      if (used.rowCount) fail(409, 'Tracking mode cannot change once the item has stock movements');
    }
    const r = await pool.query(
      `update items set name=coalesce($2,name), brand=coalesce($3,brand), category=coalesce($4,category),
         hsn_code=coalesce($5,hsn_code), unit=coalesce($6,unit), track_mode=coalesce($7,track_mode), rate=coalesce($8,rate),
         purchase_rate=coalesce($9,purchase_rate), tax_id=coalesce($10,tax_id), reorder_level=coalesce($11,reorder_level),
         warranty_template_id=case when $12::boolean then $13 else warranty_template_id end, updated_at=now()
       where id=$1 returning *`,
      [id, b.name ?? null, b.brand ?? null, b.category ?? null, b.hsn_code ?? null, b.unit ?? null, b.track_mode ?? null,
       b.rate ?? null, b.purchase_rate ?? null, b.tax_id ?? null, b.reorder_level ?? null,
       b.warranty_template_id !== undefined, b.warranty_template_id ?? null]);
    // Warranty terms edited in the app are written back to the Zoho item's custom fields.
    if (zohoEnabled && b.warranty_template_id !== undefined && b.warranty_template_id !== before.warranty_template_id)
      await enqueueZoho(pool, 'item_fields', id, String(Date.now()));
    return r.rows[0];
  });
}
