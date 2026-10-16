import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, qs } from './api';

export const money = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
export const fmtDate = (d?: string | null) => (d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (d?: string | null) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const todayStr = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

const TONES: Record<string, string> = {
  active: 'good', confirmed: 'good', synced: 'good', completed: 'good', closed: 'good', received: 'good', in_warranty: 'good', amc: 'info',
  draft: '', not_synced: '', new: 'info', scheduled: 'info', pending: 'warn', in_progress: 'info', on_hold: 'warn', out_of_warranty: 'bad',
  goodwill: 'warn', failed: 'bad', sync_failed: 'bad', cancelled: 'bad', void: 'bad', expired: 'bad', urgent: 'bad', high: 'warn', invoiced: 'info',
  in_stock: 'good', sold: 'info', in_service: 'warn', scrapped: 'bad', returned: 'warn',
};
export const Badge = ({ v, label }: { v: string; label?: string }) => <span className={`badge ${TONES[v] ?? ''}`}>{(label ?? v).replace(/_/g, ' ')}</span>;

export const Card = ({ children, title, right }: { children: ReactNode; title?: string; right?: ReactNode }) => (
  <div className="card">{(title || right) && <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}><h2 style={{ margin: 0 }}>{title}</h2>{right}</div>}{children}</div>
);
export const PageHead = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="page-head"><h1>{title}</h1><div className="row">{children}</div></div>
);
export const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="field"><span>{label}</span>{children}{hint && <span className="muted small" style={{ fontWeight: 400, marginTop: 3 }}>{hint}</span>}</label>
);
export const Empty = ({ text }: { text: string }) => <div className="card muted" style={{ textAlign: 'center' }}>{text}</div>;

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}><h2 style={{ margin: 0 }}>{title}</h2><button className="btn small" onClick={onClose}>Close</button></div>
        {children}
      </div>
    </div>
  );
}

export interface Col { head: string; cell: (r: any) => ReactNode; className?: string }
export function Table({ cols, rows, onRow, empty }: { cols: Col[]; rows: any[] | undefined; onRow?: (r: any) => void; empty?: string }) {
  if (!rows) return <div className="muted">Loading…</div>;
  if (!rows.length) return <Empty text={empty ?? 'Nothing here yet'} />;
  return (
    <div className="tablewrap"><table>
      <thead><tr>{cols.map((c) => <th key={c.head} className={c.className}>{c.head}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={(r as any).id ?? i} className={onRow ? 'click' : ''} onClick={() => onRow?.(r)}>{cols.map((c) => <td key={c.head} className={c.className}>{c.cell(r)}</td>)}</tr>)}</tbody>
    </table></div>
  );
}

// ───────── toasts ─────────
const ToastCtx = createContext<(msg: string, bad?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string; bad?: boolean }[]>([]);
  const push = (msg: string, bad?: boolean) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, msg, bad }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), bad ? 6000 : 3000);
  };
  return <ToastCtx.Provider value={push}>{children}<div className="toast-wrap" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast ${t.bad ? 'bad' : ''}`}>{t.msg}</div>)}</div></ToastCtx.Provider>;
}

/** Run an async action with toast feedback. Returns the result or undefined on failure. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try { const r = await fn(); if (ok) toast(ok); return r; }
    catch (e: any) { toast(e?.message ?? 'Something went wrong', true); return undefined; }
    finally { setBusy(false); }
  };
  return { run, busy };
}

// ───────── searchable picker ─────────
export interface Option { id: string; label: string; sub?: string; data?: any }
export function Combo({ value, onChange, fetcher, placeholder, disabled }: {
  value: Option | null; onChange: (o: Option | null) => void; fetcher: (q: string) => Promise<Option[]>; placeholder?: string; disabled?: boolean;
}) {
  const [text, setText] = useState(value?.label ?? '');
  const [opts, setOpts] = useState<Option[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setText(value?.label ?? ''), [value]);
  const search = (q: string) => {
    setText(q); setOpen(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => fetcher(q).then(setOpts).catch(() => setOpts([])), 200);
  };
  return (
    <div className="combo">
      <input value={text} disabled={disabled} placeholder={placeholder ?? 'Type to search…'} onFocus={() => { setOpen(true); if (!opts.length) search(''); }}
        onChange={(e) => { if (value) onChange(null); search(e.target.value); }} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && opts.length > 0 && !value && (
        <div className="list">{opts.map((o) => <div key={o.id} onMouseDown={() => { onChange(o); setOpen(false); }}>{o.label}{o.sub && <span className="muted small"> · {o.sub}</span>}</div>)}</div>
      )}
    </div>
  );
}

export const fetchers = {
  customers: async (q: string): Promise<Option[]> => (await api.get<any[]>(`/api/customers${qs({ q, limit: 20 })}`)).map((c) => ({ id: c.id, label: c.name, sub: c.phone, data: c })),
  vendors: async (q: string): Promise<Option[]> => (await api.get<any[]>(`/api/vendors${qs({ q, limit: 20 })}`)).map((c) => ({ id: c.id, label: c.name, sub: c.phone, data: c })),
  items: async (q: string): Promise<Option[]> => (await api.get<any[]>(`/api/items${qs({ q, limit: 20 })}`)).map((i) => ({ id: i.id, label: i.name, sub: i.sku, data: i })),
  physicalItems: async (q: string): Promise<Option[]> => (await api.get<any[]>(`/api/items${qs({ q, limit: 20 })}`)).filter((i) => !i.is_service).map((i) => ({ id: i.id, label: i.name, sub: i.sku, data: i })),
  serials: async (q: string): Promise<Option[]> => q.length < 2 ? [] : (await api.get<any[]>(`/api/serials/lookup${qs({ q })}`)).map((s) => ({ id: s.id, label: s.serial_no, sub: `${s.item_name}${s.customer ? ' · ' + s.customer : ''}`, data: s })),
};

// ───────── barcode / QR scan (uses the phone camera where the browser supports it) ─────────
export function ScanInput({ value, onChange, onSubmit, placeholder }: { value: string; onChange: (v: string) => void; onSubmit?: (v: string) => void; placeholder?: string }) {
  const [scanning, setScanning] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const supported = typeof window !== 'undefined' && 'BarcodeDetector' in window;

  useEffect(() => {
    if (!scanning) return;
    let stop = false; let stream: MediaStream | undefined;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (video.current) { video.current.srcObject = stream; await video.current.play(); }
        const det = new (window as any).BarcodeDetector();
        while (!stop) {
          const codes = video.current ? await det.detect(video.current).catch(() => []) : [];
          if (codes[0]?.rawValue) { onChange(codes[0].rawValue); onSubmit?.(codes[0].rawValue); setScanning(false); break; }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch { setScanning(false); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [scanning]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input value={value} placeholder={placeholder ?? 'Serial number'} autoCapitalize="characters" autoComplete="off"
          onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSubmit?.(value)} />
        {supported && <button type="button" className="btn" onClick={() => setScanning((s) => !s)}>{scanning ? 'Stop' : 'Scan'}</button>}
      </div>
      {scanning && <video ref={video} playsInline muted style={{ width: '100%', borderRadius: 8, background: '#000' }} />}
    </div>
  );
}

export const statusOptions = (list: string[]) => list.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>);
