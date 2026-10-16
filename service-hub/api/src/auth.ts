import '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor, Role } from './lib/jobs.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: Role; name: string };
    user: { sub: string; role: Role; name: string };
  }
}

export const authed = async (req: FastifyRequest, reply: FastifyReply) => {
  try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'Please sign in again' }); }
};

/** preHandler list: valid JWT + one of the given roles. Owner always passes. */
export const roles = (...allowed: Role[]) => [
  authed,
  async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user.role !== 'owner' && !allowed.includes(req.user.role))
      reply.code(403).send({ error: 'Your role cannot do this' });
  },
];

export const actor = (req: FastifyRequest): Actor => ({ id: req.user.sub, role: req.user.role });

export const OFFICE: Role[] = ['supervisor', 'accountant', 'sales'];
export const ANY: Role[] = ['supervisor', 'accountant', 'sales', 'technician'];
