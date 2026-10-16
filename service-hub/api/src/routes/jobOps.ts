import { z } from 'zod';
import type { JobOp } from '../lib/jobs.js';

const uuid = z.string().uuid();

/** Operations a technician (or supervisor) can apply to a job — identical online and offline. */
export const jobOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('checkin'), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() }),
  z.object({ kind: z.literal('checkout') }),
  z.object({ kind: z.literal('note'), text: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal('checklist'), item_id: uuid, done: z.boolean() }),
  z.object({ kind: z.literal('add_part'), item_id: uuid, qty: z.number().positive(), batch_id: uuid.nullable().optional(),
    serial_id: uuid.nullable().optional(), location_id: uuid.nullable().optional(), part_id: uuid.optional() }),
  z.object({ kind: z.literal('complete'), resolution: z.string().min(3).max(4000), labour_minutes: z.number().int().min(0).max(24 * 60).optional(),
    signed_by_name: z.string().max(120).optional(), signature_client_id: uuid.optional() }),
]) satisfies z.ZodType<JobOp>;
