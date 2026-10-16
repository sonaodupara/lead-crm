import { openDB, type DBSchema } from 'idb';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api, ApiError, NetworkError } from './api';

export interface QueuedOp { seq?: number; op_id: string; job_id: string; at: string; op: any; failed?: string }
export interface QueuedUpload { client_id: string; owner_id: string; kind: 'photo' | 'signature'; filename: string; blob: Blob; failed?: string }
interface Bootstrap { server_time: string; jobs: any[]; catalogue: any[] }

interface Schema extends DBSchema {
  ops: { key: number; value: QueuedOp };
  uploads: { key: string; value: QueuedUpload };
  cache: { key: string; value: { key: string; value: any } };
}
const db = () => openDB<Schema>('service-hub', 1, {
  upgrade(d) {
    d.createObjectStore('ops', { keyPath: 'seq', autoIncrement: true });
    d.createObjectStore('uploads', { keyPath: 'client_id' });
    d.createObjectStore('cache', { keyPath: 'key' });
  },
});

export const newId = () => crypto.randomUUID();

// ───────── in-memory mirror of the queue ─────────
// The screen reads this synchronously, so a tap shows its effect at once; IndexedDB is written right behind it.
let state: { ops: QueuedOp[]; uploads: QueuedUpload[] } = { ops: [], uploads: [] };
const listeners = new Set<() => void>();
const emit = () => {
  state = { ops: state.ops, uploads: state.uploads };
  listeners.forEach((l) => l());
  window.dispatchEvent(new Event('queue:changed'));
};
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Rebuild the mirror from IndexedDB, keeping anything still being written. */
async function reloadFromDb() {
  const d = await db();
  const [ops, uploads] = await Promise.all([d.getAll('ops'), d.getAll('uploads')]);
  const have = new Set(ops.map((o) => o.op_id));
  const haveUp = new Set(uploads.map((u) => u.client_id));
  state = {
    ops: [...ops, ...[...inflightOps.values()].filter((o) => !have.has(o.op_id))],
    uploads: [...uploads, ...[...inflightUploads.values()].filter((u) => !haveUp.has(u.client_id))],
  };
  emit();
}
const inflightOps = new Map<string, QueuedOp>();
const inflightUploads = new Map<string, QueuedUpload>();
void reloadFromDb();

export async function queueOp(job_id: string, op: any): Promise<string> {
  const rec: QueuedOp = { op_id: newId(), job_id, at: nowIso(), op };
  inflightOps.set(rec.op_id, rec);
  state.ops = [...state.ops, rec];
  emit();                                           // UI updates now
  try { rec.seq = await (await db()).add('ops', rec); }
  catch (e) { state.ops = state.ops.filter((o) => o.op_id !== rec.op_id); emit(); throw e; }
  finally { inflightOps.delete(rec.op_id); }
  void flush();
  return rec.op_id;
}
export async function queueUpload(u: Omit<QueuedUpload, 'client_id'> & { client_id?: string }): Promise<string> {
  const rec: QueuedUpload = { ...u, client_id: u.client_id ?? newId() };
  inflightUploads.set(rec.client_id, rec);
  state.uploads = [...state.uploads, rec];
  emit();
  try { await (await db()).put('uploads', rec); }
  catch (e) { state.uploads = state.uploads.filter((x) => x.client_id !== rec.client_id); emit(); throw e; }
  finally { inflightUploads.delete(rec.client_id); }
  void flush();
  return rec.client_id;
}
export async function discardFailed() {
  const d = await db();
  for (const o of await d.getAll('ops')) if (o.failed) await d.delete('ops', o.seq!);
  for (const u of await d.getAll('uploads')) if (u.failed) await d.delete('uploads', u.client_id);
  await reloadFromDb();
}

// ───────── clock: phones drift, so timestamps are corrected with the offset seen at the last server contact ─────────
let skewMs = Number(localStorage.getItem('sh_skew') || 0);
export const nowIso = () => new Date(Date.now() + skewMs).toISOString();
const learnSkew = (serverTime: string) => {
  skewMs = new Date(serverTime).getTime() - Date.now();
  try { localStorage.setItem('sh_skew', String(skewMs)); } catch { /* ignore */ }
};

// ───────── sync ─────────
let flushing: Promise<{ applied: number; failed: number; offline: boolean }> | null = null;

/** Send queued uploads, then queued operations, to the server. Safe to call at any time; concurrent calls share one run. */
export function flush() {
  if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  const d = await db();
  let applied = 0, failed = 0;
  try {
    for (const u of await d.getAll('uploads')) {
      if (u.failed) continue;
      const form = new FormData();
      form.set('owner_type', 'service_job'); form.set('owner_id', u.owner_id); form.set('kind', u.kind); form.set('client_id', u.client_id);
      form.set('file', u.blob, u.filename);
      try { await api.upload('/api/attachments', form); await d.delete('uploads', u.client_id); applied++; }
      catch (e) {
        if (e instanceof NetworkError || (e instanceof ApiError && e.status >= 500)) throw e;
        await d.put('uploads', { ...u, failed: (e as Error).message }); failed++;
      }
    }
    const ops = (await d.getAll('ops')).filter((o) => !o.failed);
    for (let i = 0; i < ops.length; i += 50) {
      const batch = ops.slice(i, i + 50);
      const { results } = await api.post<{ results: { op_id: string; status: string; error?: string; retry?: boolean }[] }>(
        '/api/sync/push', { ops: batch.map(({ op_id, job_id, at, op }) => ({ op_id, job_id, at, op })) });
      for (const r of results) {
        const q = batch.find((b) => b.op_id === r.op_id)!;
        if (r.status === 'applied' || r.status === 'duplicate') { await d.delete('ops', q.seq!); applied++; }
        else if (!r.retry) { await d.put('ops', { ...q, failed: r.error ?? 'Rejected by server' }); failed++; }
        // retryable errors stay queued for the next attempt
      }
    }
    if (applied) await refreshBootstrap().catch(() => {});
    return { applied, failed, offline: false };
  } catch (e) {
    if (e instanceof NetworkError || (e instanceof ApiError && e.status >= 500)) return { applied, failed, offline: true };
    throw e;
  } finally {
    try { localStorage.setItem('sh_last_sync', nowIso()); } catch { /* ignore */ }
    await reloadFromDb();
  }
}

// ───────── cached job data ─────────
export async function refreshBootstrap(): Promise<Bootstrap> {
  const data = await api.get<Bootstrap>('/api/sync/bootstrap');
  learnSkew(data.server_time);
  await (await db()).put('cache', { key: 'bootstrap', value: { ...data, fetched_at: nowIso() } });
  return data;
}
export async function cachedBootstrap(): Promise<(Bootstrap & { fetched_at: string }) | null> {
  return ((await (await db()).get('cache', 'bootstrap'))?.value as any) ?? null;
}

/** What the technician sees: the last server snapshot with still-queued operations laid over it. */
export function withPending(job: any, ops: QueuedOp[], catalogue: any[]) {
  const j = structuredClone(job);
  j.pending = false;
  for (const q of ops.filter((o) => o.job_id === job.id)) {
    j.pending = true;
    const o = q.op;
    if (o.kind === 'checkin') { j.status = 'in_progress'; j.checked_in_at ??= q.at; }
    else if (o.kind === 'checklist') { const c = j.checklist.find((x: any) => x.id === o.item_id); if (c) c.done = o.done; }
    else if (o.kind === 'add_part') {
      j.parts.push({ id: o.part_id ?? q.op_id, item_name: catalogue.find((c) => c.id === o.item_id)?.name ?? 'Part', qty: o.qty,
        chargeable: j.coverage === 'out_of_warranty', pending: true });
    } else if (o.kind === 'complete') { j.status = 'completed'; j.resolution = o.resolution; }
  }
  return j;
}

// ───────── hooks ─────────
export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

export function useQueue() {
  const { ops, uploads } = useSyncExternalStore(subscribe, () => state);
  const pending = ops.filter((o) => !o.failed).length + uploads.filter((u) => !u.failed).length;
  const failed = [...ops.filter((o) => o.failed), ...uploads.filter((u) => u.failed)];
  return { ops, uploads, pending, failed };
}

/** Drives automatic syncing: on app start, when the connection returns, and every 20s while anything is queued. */
export function useAutoSync(enabled: boolean) {
  const online = useOnline();
  const { pending } = useQueue();
  useEffect(() => { if (enabled && online) void flush(); }, [enabled, online]);
  useEffect(() => {
    if (!enabled || !online || !pending) return;
    const t = setInterval(() => void flush(), 20_000);
    return () => clearInterval(t);
  }, [enabled, online, pending]);
}

export function useTechData() {
  const { ops } = useQueue();
  const [data, setData] = useState<(Bootstrap & { fetched_at?: string }) | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await refreshBootstrap()); setStale(false); }
    catch {
      const c = await cachedBootstrap();
      if (c) { setData(c); setStale(true); }
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // pick up fresh server state after a flush
  useEffect(() => {
    const h = async () => { const c = await cachedBootstrap(); if (c) setData(c); };
    window.addEventListener('queue:changed', h);
    return () => window.removeEventListener('queue:changed', h);
  }, []);

  const jobs = data ? data.jobs.map((j) => withPending(j, ops, data.catalogue)) : [];
  return { jobs, catalogue: data?.catalogue ?? [], loading, stale, fetchedAt: data?.fetched_at, reload: load };
}

// ───────── device helpers ─────────
export async function getPosition(): Promise<{ lat?: number; lng?: number }> {
  if (!('geolocation' in navigator)) return {};
  return new Promise((resolve) => navigator.geolocation.getCurrentPosition(
    (p) => resolve({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6) }), () => resolve({}), { timeout: 5000, maximumAge: 60_000 }));
}

/** Shrink phone photos before they sit in the queue and travel over mobile data. */
export async function resizeImage(file: File, maxDim = 1600, quality = 0.8): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', quality));
  } catch { return file; }
}
