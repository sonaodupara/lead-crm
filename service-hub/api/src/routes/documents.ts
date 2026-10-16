import type { FastifyInstance } from 'fastify';
import '@fastify/multipart';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, pool, tx } from '../db.js';
import { actor, ANY, authed, roles } from '../auth.js';
import { config } from '../config.js';
import { fail } from '../lib/errors.js';
import { confirmInvoice, receiveBill, saveBill, saveInvoice } from '../lib/documents.js';
import { enqueueZoho } from '../lib/outbox.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const uuid = z.string().uuid();

const billBody = z.object({
  vendor_id: uuid, vendor_bill_no: z.string().nullable().optional(), bill_date: date, due_date: date.nullable().optional(),
  place_of_supply: z.string().nullable().optional(), gst_treatment: z.string().nullable().optional(), notes: z.string().nullable().optional(),
  lines: z.array(z.object({
    item_id: uuid, description: z.string().nullable().optional(), qty: z.number().positive(), rate: z.number().min(0),
    tax_id: uuid.nullable().optional(), batch_no: z.string().nullable().optional(), mfg_date: date.nullable().optional(),
    expiry_date: date.nullable().optional(), serial_nos: z.array(z.string()).optional(), location_id: uuid.nullable().optional(),
  })).min(1),
});

const invBody = z.object({
  customer_id: uuid, invoice_date: date, due_date: date.nullable().optional(), place_of_supply: z.string().nullable().optional(),
  gst_treatment: z.string().nullable().optional(), notes: z.string().nullable().optional(), terms: z.string().nullable().optional(),
  lines: z.array(z.object({
    item_id: uuid, description: z.string().nullable().optional(), qty: z.number().positive(), rate: z.number().min(0),
    discount_pct: z.number().min(0).max(100).optional(), tax_id: uuid.nullable().optional(), batch_id: uuid.nullable().optional(),
    serial_ids: z.array(uuid).optional(), location_id: uuid.nullable().optional(),
  })).min(1),
});

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);

export default async function documents(app: FastifyInstance) {
  // ───────── purchase bills ─────────
  app.get('/api/bills', { preHandler: roles('accountant', 'supervisor') }, async (req) => {
    const { status, q } = z.object({ status: z.string().optional(), q: z.string().optional() }).parse(req.query);
    return (await pool.query(
      `select b.id,b.number,b.vendor_bill_no,b.bill_date,b.status,b.sync_status,b.total,b.zoho_status,v.name as vendor
         from purchase_bills b join vendors v on v.id=b.vendor_id
        where ($1::text is null or b.status=$1) and ($2::text is null or lower(v.name) like $2 or lower(b.vendor_bill_no) like $2 or lower(b.number) like $2)
        order by b.created_at desc limit 300`, [status ?? null, q ? `%${q.toLowerCase()}%` : null])).rows;
  });

  app.get('/api/bills/:id', { preHandler: roles('accountant', 'supervisor') }, async (req) => {
    const id = (req.params as any).id;
    const b = (await pool.query(`select b.*, v.name as vendor from purchase_bills b join vendors v on v.id=b.vendor_id where b.id=$1`, [id])).rows[0];
    if (!b) fail(404, 'Bill not found');
    const lines = (await pool.query(
      `select l.*, i.name as item_name, i.sku, i.track_mode from purchase_bill_lines l join items i on i.id=l.item_id where bill_id=$1 order by line_no`, [id])).rows;
    const files = (await pool.query(`select id,filename,mime,kind,created_at from attachments where owner_type='purchase_bill' and owner_id=$1`, [id])).rows;
    const outbox = (await pool.query(`select status,attempts,last_error from zoho_outbox where entity_type='purchase_bill' and entity_id=$1 order by id desc limit 1`, [id])).rows[0] ?? null;
    return { ...b, lines, attachments: files, outbox };
  });

  app.post('/api/bills', { preHandler: roles('accountant') }, async (req) =>
    tx(async (c) => ({ id: await saveBill(c, actor(req).id, billBody.parse(req.body)) })));
  app.put('/api/bills/:id', { preHandler: roles('accountant') }, async (req) =>
    tx(async (c) => ({ id: await saveBill(c, actor(req).id, billBody.parse(req.body), (req.params as any).id) })));
  app.post('/api/bills/:id/receive', { preHandler: roles('accountant', 'supervisor') }, async (req) =>
    tx(async (c) => { await receiveBill(c, actor(req).id, (req.params as any).id); return { ok: true }; }));
  app.post('/api/bills/:id/cancel', { preHandler: roles('accountant') }, async (req) => {
    const r = await pool.query(`update purchase_bills set status='cancelled', updated_at=now() where id=$1 and status='draft' returning id`, [(req.params as any).id]);
    if (!r.rowCount) fail(409, 'Only draft bills can be cancelled');
    return { ok: true };
  });

  // ───────── sales invoices ─────────
  app.get('/api/invoices', { preHandler: roles('accountant', 'supervisor', 'sales') }, async (req) => {
    const { status, q, customer_id } = z.object({ status: z.string().optional(), q: z.string().optional(), customer_id: uuid.optional() }).parse(req.query);
    return (await pool.query(
      `select s.id,s.number,s.invoice_date,s.status,s.sync_status,s.total,s.zoho_status,s.zoho_invoice_number,s.source,c.name as customer
         from sales_invoices s join customers c on c.id=s.customer_id
        where ($1::text is null or s.status=$1) and ($3::uuid is null or s.customer_id=$3)
          and ($2::text is null or lower(c.name) like $2 or lower(s.number) like $2)
        order by s.created_at desc limit 300`,
      [status ?? null, q ? `%${q.toLowerCase()}%` : null, customer_id ?? null])).rows;
  });

  app.get('/api/invoices/:id', { preHandler: roles('accountant', 'supervisor', 'sales') }, async (req) => {
    const id = (req.params as any).id;
    const inv = (await pool.query(`select s.*, c.name as customer from sales_invoices s join customers c on c.id=s.customer_id where s.id=$1`, [id])).rows[0];
    if (!inv) fail(404, 'Invoice not found');
    const lines = (await pool.query(
      `select l.*, i.name as item_name, i.sku, i.track_mode,
              coalesce((select array_agg(s.serial_no order by s.serial_no) from serial_units s where s.id = any(l.serial_ids)), '{}') as serial_nos
         from sales_invoice_lines l join items i on i.id=l.item_id where invoice_id=$1 order by line_no`, [id])).rows;
    const warranties = (await pool.query(
      `select w.id,w.start_date,w.parts_end,w.labour_end,w.onsite_end,s.serial_no,i.name as item_name
         from warranties w join serial_units s on s.id=w.serial_id join items i on i.id=s.item_id where w.sale_invoice_id=$1`, [id])).rows;
    const outbox = (await pool.query(`select status,attempts,last_error from zoho_outbox where entity_type='sales_invoice' and entity_id=$1 order by id desc limit 1`, [id])).rows[0] ?? null;
    return { ...inv, lines, warranties, outbox };
  });

  app.post('/api/invoices', { preHandler: roles('accountant', 'sales') }, async (req) =>
    tx(async (c) => ({ id: await saveInvoice(c, actor(req).id, invBody.parse(req.body)) })));
  app.put('/api/invoices/:id', { preHandler: roles('accountant', 'sales') }, async (req) =>
    tx(async (c) => ({ id: await saveInvoice(c, actor(req).id, invBody.parse(req.body), (req.params as any).id) })));
  app.post('/api/invoices/:id/confirm', { preHandler: roles('accountant') }, async (req) =>
    tx((c) => confirmInvoice(c, actor(req).id, (req.params as any).id)));
  app.post('/api/invoices/:id/cancel', { preHandler: roles('accountant') }, async (req) => {
    const r = await pool.query(`update sales_invoices set status='cancelled', updated_at=now() where id=$1 and status='draft' returning id`, [(req.params as any).id]);
    if (!r.rowCount) fail(409, 'Only draft invoices can be cancelled. Cancel confirmed invoices in Zoho and raise a credit note.');
    return { ok: true };
  });

  // Serials still available for an item (for the invoice line picker).
  app.get('/api/items/:id/available-serials', { preHandler: roles('accountant', 'sales', 'supervisor') }, async (req) =>
    (await pool.query(
      `select s.id, s.serial_no, b.batch_no from serial_units s left join batches b on b.id=s.batch_id
        where s.item_id=$1 and s.status='in_stock' order by s.serial_no limit 500`, [(req.params as any).id])).rows);

  // Retry a failed Zoho push from the UI.
  app.post('/api/:kind(invoices|bills)/:id/resync', { preHandler: roles('accountant') }, async (req) => {
    const { kind, id } = req.params as { kind: string; id: string };
    const entity = kind === 'invoices' ? 'sales_invoice' : 'purchase_bill';
    const table = kind === 'invoices' ? 'sales_invoices' : 'purchase_bills';
    const doc = (await pool.query(`select status, sync_status from ${table} where id=$1`, [id])).rows[0];
    if (!doc) fail(404, 'Not found');
    if (doc.status === 'draft' || doc.status === 'cancelled') fail(409, 'Confirm the document before syncing');
    if (doc.sync_status === 'synced') fail(409, 'Already synced');
    await pool.query(`update zoho_outbox set status='pending', attempts=0, next_attempt_at=now() where entity_type=$1 and entity_id=$2 and status='failed'`, [entity, id]);
    await enqueueZoho(pool, entity as any, id);
    await audit(pool, actor(req).id, 'zoho.resync', entity, id);
    return { ok: true };
  });

  // ───────── attachments (bill scans, job photos, signatures) ─────────
  app.post('/api/attachments', { preHandler: roles(...ANY) }, async (req) => {
    const file = await req.file({ limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 } });
    if (!file) fail(400, 'No file uploaded');
    const f = file!;
    const field = (n: string) => (f.fields[n] as any)?.value as string | undefined;
    const meta = z.object({
      owner_type: z.enum(['purchase_bill', 'sales_invoice', 'service_job', 'warranty', 'amc_contract']),
      owner_id: uuid, kind: z.enum(['document', 'photo', 'signature', 'bill_scan']).default('document'), client_id: uuid.optional(),
    }).parse({ owner_type: field('owner_type'), owner_id: field('owner_id'), kind: field('kind') || 'document', client_id: field('client_id') || undefined });
    if (!ALLOWED_MIME.has(f.mimetype)) fail(415, `File type ${f.mimetype} is not allowed`);
    const a = actor(req);
    if (a.role === 'technician' && meta.owner_type !== 'service_job') fail(403, 'Technicians can only attach files to jobs');
    if (a.role === 'technician') {
      const j = (await pool.query('select assigned_to from service_jobs where id=$1', [meta.owner_id])).rows[0];
      if (!j || j.assigned_to !== a.id) fail(403, 'This job is not assigned to you');
    }
    if (meta.client_id) {
      const dupe = (await pool.query('select id from attachments where client_id=$1', [meta.client_id])).rows[0];
      if (dupe) { f.file.resume(); return { id: dupe.id, duplicate: true }; }
    }
    const buf = await f.toBuffer();
    if (f.file.truncated) fail(413, `File is larger than ${config.MAX_UPLOAD_MB} MB`);
    const dir = resolve(config.UPLOAD_DIR, meta.owner_type);
    mkdirSync(dir, { recursive: true });
    const stored = `${randomUUID()}${extname(f.filename).toLowerCase().replace(/[^.a-z0-9]/g, '')}`;
    await writeFile(join(dir, stored), buf);
    const r = await pool.query(
      `insert into attachments (owner_type,owner_id,kind,filename,mime,size_bytes,storage_path,client_id,uploaded_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [meta.owner_type, meta.owner_id, meta.kind, f.filename.slice(0, 200), f.mimetype, buf.length, join(meta.owner_type, stored), meta.client_id ?? null, a.id]);
    return { id: r.rows[0].id };
  });

  app.get('/api/attachments', { preHandler: roles(...ANY) }, async (req) => {
    const { owner_type, owner_id } = z.object({ owner_type: z.string(), owner_id: uuid }).parse(req.query);
    const me = actor(req);
    if (me.role === 'technician') {
      const j = owner_type === 'service_job' ? (await pool.query('select assigned_to from service_jobs where id=$1', [owner_id])).rows[0] : null;
      if (!j || j.assigned_to !== me.id) fail(403, 'Not allowed');
    } else if (me.role === 'sales' && owner_type === 'purchase_bill') fail(403, 'Not allowed');
    return (await pool.query(`select id,filename,mime,kind,size_bytes,created_at from attachments where owner_type=$1 and owner_id=$2 order by created_at`, [owner_type, owner_id])).rows;
  });

  app.get('/api/attachments/:id/file', { preHandler: authed }, async (req, reply) => {
    const a = (await pool.query('select * from attachments where id=$1', [(req.params as any).id])).rows[0];
    if (!a) fail(404, 'File not found');
    const me = actor(req);
    if (me.role === 'technician') {
      const j = a.owner_type === 'service_job'
        ? (await pool.query('select assigned_to from service_jobs where id=$1', [a.owner_id])).rows[0] : null;
      if (!j || j.assigned_to !== me.id) fail(403, 'Not allowed');
    } else if (me.role === 'sales' && a.owner_type === 'purchase_bill') fail(403, 'Not allowed');
    const full = resolve(config.UPLOAD_DIR, a.storage_path);
    if (!full.startsWith(resolve(config.UPLOAD_DIR)) || !existsSync(full)) fail(404, 'File missing on disk');
    reply.header('Content-Type', a.mime).header('Content-Disposition', `inline; filename="${a.filename.replace(/"/g, '')}"`)
      .header('X-Content-Type-Options', 'nosniff');
    return reply.send(createReadStream(full));
  });
}
