import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { audit, pool } from '../db.js';
import { actor, authed, roles } from '../auth.js';
import { fail } from '../lib/errors.js';

const roleEnum = z.enum(['owner', 'supervisor', 'accountant', 'technician', 'sales']);

export default async function core(app: FastifyInstance) {
  app.get('/api/health', async () => {
    await pool.query('select 1');
    return { ok: true };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const u = (await pool.query('select * from users where lower(email)=lower($1) and active', [email])).rows[0];
    // Compare even when the user is missing so response time does not reveal valid emails.
    const ok = await bcrypt.compare(password, u?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
    if (!u || !ok) return reply.code(401).send({ error: 'Wrong email or password' });
    const token = app.jwt.sign({ sub: u.id, role: u.role, name: u.name }, { expiresIn: '12h' });
    return { token, user: { id: u.id, name: u.name, email: u.email, role: u.role } };
  });

  app.get('/api/auth/me', { preHandler: authed }, async (req) => {
    const u = (await pool.query('select id,name,email,role,phone from users where id=$1 and active', [req.user.sub])).rows[0];
    return u ?? fail(401, 'Account disabled');
  });

  app.post('/api/auth/password', { preHandler: authed }, async (req) => {
    const b = z.object({ current: z.string(), next: z.string().min(8) }).parse(req.body);
    const u = (await pool.query('select password_hash from users where id=$1', [req.user.sub])).rows[0];
    if (!(await bcrypt.compare(b.current, u.password_hash))) fail(400, 'Current password is wrong');
    await pool.query('update users set password_hash=$2 where id=$1', [req.user.sub, await bcrypt.hash(b.next, 10)]);
    return { ok: true };
  });

  // ── user management (owner only) ──
  app.get('/api/users', { preHandler: roles('supervisor') }, async () =>
    (await pool.query('select id,name,email,phone,role,active from users order by name')).rows);

  app.post('/api/users', { preHandler: roles() }, async (req) => {
    const b = z.object({ name: z.string().min(1), email: z.string().email(), phone: z.string().optional(),
      role: roleEnum, password: z.string().min(8) }).parse(req.body);
    const r = await pool.query(
      'insert into users (name,email,phone,role,password_hash) values ($1,$2,$3,$4,$5) returning id,name,email,role',
      [b.name, b.email, b.phone ?? null, b.role, await bcrypt.hash(b.password, 10)]);
    await audit(pool, req.user.sub, 'user.create', 'user', r.rows[0].id);
    return r.rows[0];
  });

  app.patch('/api/users/:id', { preHandler: roles() }, async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ name: z.string().min(1).optional(), phone: z.string().nullable().optional(),
      role: roleEnum.optional(), active: z.boolean().optional(), password: z.string().min(8).optional() }).parse(req.body);
    if (id === req.user.sub && (b.active === false || (b.role && b.role !== 'owner')))
      fail(400, 'You cannot remove your own owner access');
    await pool.query(
      `update users set name=coalesce($2,name), phone=case when $3::boolean then $4 else phone end, role=coalesce($5,role),
         active=coalesce($6,active), password_hash=coalesce($7,password_hash) where id=$1`,
      [id, b.name ?? null, b.phone !== undefined, b.phone ?? null, b.role ?? null, b.active ?? null,
       b.password ? await bcrypt.hash(b.password, 10) : null]);
    await audit(pool, req.user.sub, 'user.update', 'user', id, { ...b, password: b.password ? '***' : undefined });
    return { ok: true };
  });

  app.get('/api/technicians', { preHandler: roles('supervisor', 'accountant') }, async () =>
    (await pool.query(`select id,name,phone from users where role='technician' and active order by name`)).rows);

  // ── settings (owner writes, office reads) ──
  app.get('/api/settings', { preHandler: roles('supervisor', 'accountant') }, async () => {
    const rows = (await pool.query('select key, value from settings')).rows;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });
  app.put('/api/settings/:key', { preHandler: roles() }, async (req) => {
    const { key } = req.params as { key: string };
    if (!['job_billing', 'company', 'sla_hours'].includes(key)) fail(400, 'Unknown setting');
    await pool.query(`insert into settings (key,value) values ($1,$2) on conflict (key) do update set value=excluded.value`,
      [key, JSON.stringify(req.body)]);
    await audit(pool, actor(req).id, 'settings.update', 'settings', key);
    return { ok: true };
  });
}
