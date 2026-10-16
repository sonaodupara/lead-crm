import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fstatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import type { ZohoApi } from './zoho/client.js';
import core from './routes/core.js';
import masters from './routes/masters.js';
import inventory from './routes/inventory.js';
import warranty from './routes/warranty.js';
import documents from './routes/documents.js';
import jobs from './routes/jobs.js';
import amc from './routes/amc.js';
import sync from './routes/sync.js';
import zoho from './routes/zoho.js';
import reports from './routes/reports.js';

export async function buildApp(opts: { zoho: ZohoApi | null; logger?: boolean }) {
  const app = Fastify({ logger: opts.logger ?? config.NODE_ENV !== 'test', trustProxy: true, bodyLimit: 2 * 1024 * 1024 });

  await app.register(cors, { origin: config.CORS_ORIGIN.split(',').map((s) => s.trim()) });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(jwt, { secret: config.JWT_SECRET });
  await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'SAMEORIGIN')
      .header('Referrer-Policy', 'same-origin');
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.code(400).send({ error: `${first.path.join('.') || 'body'}: ${first.message}`, issues: err.issues });
    }
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, details: err.details });
    switch (err?.code) {
      case '23505': return reply.code(409).send({ error: 'That record already exists', detail: err.detail });
      case '23503': return reply.code(409).send({ error: 'A linked record is missing or still in use', detail: err.detail });
      case '23514': case '22P02': case '22007': case '22008':
        return reply.code(400).send({ error: 'Invalid value in request', detail: err.message });
    }
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong on the server' });
  });

  for (const r of [core, masters, inventory, warranty, documents, jobs, amc, sync, reports]) await app.register(r);
  await app.register(zoho, { api: opts.zoho });

  const dist = resolve(config.WEB_DIST);
  if (existsSync(dist)) {
    await app.register(fstatic, { root: dist, wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  }
  return app;
}
