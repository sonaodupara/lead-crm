import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, pool, tx } from '../db.js';
import { actor, ANY, roles } from '../auth.js';
import { fail } from '../lib/errors.js';
import { addMovement, defaultLocationId, onHand } from '../lib/stock.js';
import { coverageOn } from '../lib/warranty.js';
import { today } from '../lib/jobs.js';

export default async function inventory(app: FastifyInstance) {
  // Stock summary: one row per physical item with on-hand and reorder flag.
  app.get('/api/stock', { preHandler: roles(...ANY) }, async (req) => {
    const { q, low } = z.object({ q: z.string().optional(), low: z.coerce.boolean().optional() }).parse(req.query);
    const like = q ? `%${q.toLowerCase()}%` : null;
    return (await pool.query(
      `select * from (
         select i.id, i.sku, i.name, i.brand, i.category, i.unit, i.track_mode, i.reorder_level,
                coalesce(sum(m.qty),0) as on_hand,
                coalesce(sum(m.qty) filter (where m.at >= now() - interval '90 days' and m.qty < 0),0) * -1 as used_90d
           from items i left join stock_movements m on m.item_id=i.id
          where i.active and not i.is_service and ($1::text is null or lower(i.name) like $1 or lower(i.sku) like $1)
          group by i.id) s
       where ($2::boolean is not true) or s.on_hand <= s.reorder_level
       order by s.name limit 500`, [like, low ?? null])).rows;
  });

  // Breakdown of one item by location and batch.
  app.get('/api/items/:id/stock', { preHandler: roles(...ANY) }, async (req) => {
    const id = (req.params as any).id;
    const rows = (await pool.query(
      `select l.name as location, l.id as location_id, b.id as batch_id, b.batch_no, b.expiry_date, sum(m.qty) as qty
         from stock_movements m join locations l on l.id=m.location_id left join batches b on b.id=m.batch_id
        where m.item_id=$1 group by l.id, l.name, b.id, b.batch_no, b.expiry_date
       having sum(m.qty) <> 0 order by b.expiry_date nulls last, b.batch_no`, [id])).rows;
    return rows;
  });

  app.post('/api/stock/adjust', { preHandler: roles('supervisor', 'accountant') }, async (req) => {
    const b = z.object({ item_id: z.string().uuid(), qty: z.number().refine((n) => n !== 0), location_id: z.string().uuid().optional(),
      batch_id: z.string().uuid().nullable().optional(), reason: z.string().min(3) }).parse(req.body);
    return tx(async (c) => {
      const item = (await c.query('select track_mode from items where id=$1', [b.item_id])).rows[0];
      if (!item) fail(404, 'Item not found');
      if (item.track_mode === 'serial') fail(400, 'Serial-tracked stock changes through bills, invoices or serial status, not quantity adjustments');
      const loc = b.location_id ?? (await defaultLocationId(c));
      if (b.qty < 0 && (await onHand(c, { item_id: b.item_id, location_id: loc, batch_id: b.batch_id })) < -b.qty)
        fail(409, 'Adjustment would make stock negative');
      await addMovement(c, { item_id: b.item_id, batch_id: b.batch_id, location_id: loc, qty: b.qty, kind: 'adjustment',
        note: b.reason, created_by: actor(req).id });
      await audit(c, actor(req).id, 'stock.adjust', 'item', b.item_id, b);
      return { ok: true };
    });
  });

  // ── batches ──
  app.get('/api/batches', { preHandler: roles(...ANY) }, async (req) => {
    const { item_id, expiring_days } = z.object({ item_id: z.string().uuid().optional(), expiring_days: z.coerce.number().optional() }).parse(req.query);
    return (await pool.query(
      `select b.*, i.name as item_name, i.sku, v.name as vendor_name,
              coalesce((select sum(qty) from stock_movements m where m.batch_id=b.id),0) as on_hand
         from batches b join items i on i.id=b.item_id left join vendors v on v.id=b.vendor_id
        where ($1::uuid is null or b.item_id=$1)
          and ($2::int is null or (b.expiry_date is not null and b.expiry_date <= current_date + $2::int))
        order by b.expiry_date nulls last, b.created_at desc limit 500`, [item_id ?? null, expiring_days ?? null])).rows;
  });

  // Where did this batch go? (recall / quality investigation)
  app.get('/api/batches/:id/trace', { preHandler: roles('supervisor', 'accountant') }, async (req) => {
    const id = (req.params as any).id;
    const batch = (await pool.query(
      `select b.*, i.name as item_name, v.name as vendor_name, pb.number as bill_number, pb.vendor_bill_no
         from batches b join items i on i.id=b.item_id left join vendors v on v.id=b.vendor_id
         left join purchase_bills pb on pb.id=b.purchase_bill_id where b.id=$1`, [id])).rows[0];
    if (!batch) fail(404, 'Batch not found');
    const sold = (await pool.query(
      `select c.id as customer_id, c.name as customer, c.phone, si.number as invoice, si.invoice_date, abs(sum(m.qty)) as qty,
              array_remove(array_agg(distinct s.serial_no), null) as serials
         from stock_movements m join sales_invoices si on si.id=m.ref_id and m.ref_type='sales_invoice'
         join customers c on c.id=si.customer_id left join serial_units s on s.id=m.serial_id
        where m.batch_id=$1 and m.kind='sale' group by c.id, c.name, c.phone, si.number, si.invoice_date
        order by si.invoice_date`, [id])).rows;
    const jobs = (await pool.query(
      `select j.number, j.kind, j.status, j.problem from service_jobs j
         join serial_units s on s.id=j.serial_id where s.batch_id=$1 order by j.created_at desc limit 100`, [id])).rows;
    return { batch, sold, jobs };
  });

  app.patch('/api/batches/:id', { preHandler: roles('supervisor', 'accountant') }, async (req) => {
    const b = z.object({ warranty_template_id: z.string().uuid().nullable().optional(), expiry_date: z.string().nullable().optional(),
      notes: z.string().nullable().optional() }).parse(req.body);
    const r = await pool.query(
      `update batches set warranty_template_id=case when $2::boolean then $3 else warranty_template_id end,
         expiry_date=coalesce($4,expiry_date), notes=coalesce($5,notes) where id=$1 returning *`,
      [(req.params as any).id, b.warranty_template_id !== undefined, b.warranty_template_id ?? null, b.expiry_date ?? null, b.notes ?? null]);
    return r.rows[0] ?? fail(404, 'Batch not found');
  });

  // ── serials ──
  app.get('/api/serials', { preHandler: roles(...ANY) }, async (req) => {
    const { item_id, status, q } = z.object({ item_id: z.string().uuid().optional(),
      status: z.enum(['in_stock', 'sold', 'returned', 'scrapped', 'in_service']).optional(), q: z.string().optional() }).parse(req.query);
    return (await pool.query(
      `select s.id, s.serial_no, s.status, s.item_id, i.name as item_name, s.batch_id, b.batch_no, s.location_id
         from serial_units s join items i on i.id=s.item_id left join batches b on b.id=s.batch_id
        where ($1::uuid is null or s.item_id=$1) and ($2::text is null or s.status=$2)
          and ($3::text is null or lower(s.serial_no) like $3) order by s.serial_no limit 500`,
      [item_id ?? null, status ?? null, q ? `%${q.toLowerCase()}%` : null])).rows;
  });

  /** Scan or type a serial number: who owns it, is it in warranty, what service has it had. */
  app.get('/api/serials/lookup', { preHandler: roles(...ANY) }, async (req) => {
    const { q } = z.object({ q: z.string().min(2) }).parse(req.query);
    const rows = (await pool.query(
      `select s.id, s.serial_no, s.status, i.name as item_name, i.sku, c.name as customer, c.phone as customer_phone
         from serial_units s join items i on i.id=s.item_id left join customers c on c.id=s.customer_id
        where lower(s.serial_no) like $1 order by (lower(s.serial_no)=$2) desc, s.serial_no limit 20`,
      [`%${q.toLowerCase()}%`, q.toLowerCase()])).rows;
    return rows;
  });

  app.get('/api/serials/:id', { preHandler: roles(...ANY) }, async (req) => {
    const id = (req.params as any).id;
    const s = (await pool.query(
      `select s.*, i.name as item_name, i.sku, i.brand, b.batch_no, c.name as customer, c.phone as customer_phone,
              si.number as invoice_number, v.name as vendor_name
         from serial_units s join items i on i.id=s.item_id left join batches b on b.id=s.batch_id
         left join customers c on c.id=s.customer_id left join sales_invoices si on si.id=s.sale_invoice_id
         left join vendors v on v.id=s.vendor_id where s.id=$1`, [id])).rows[0];
    if (!s) fail(404, 'Serial not found');
    const warranties = (await pool.query(`select * from warranties where serial_id=$1 order by start_date desc`, [id])).rows
      .map((w) => ({ ...w, coverage: coverageOn(w, today()) }));
    const jobs = (await pool.query(
      `select j.id, j.number, j.kind, j.status, j.coverage, j.problem, j.resolution, j.created_at, j.checked_out_at,
              u.name as technician from service_jobs j left join users u on u.id=j.assigned_to
        where j.serial_id=$1 order by j.created_at desc`, [id])).rows;
    const contracts = (await pool.query(
      `select k.id, k.number, k.status, k.start_date, k.end_date from amc_contracts k
         join amc_contract_units u on u.contract_id=k.id where u.serial_id=$1 order by k.start_date desc`, [id])).rows;
    return { serial: s, warranties, jobs, contracts };
  });
}
