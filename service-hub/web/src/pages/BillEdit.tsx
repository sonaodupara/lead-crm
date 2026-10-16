import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, openProtected } from '../api';
import { useAuth } from '../auth';
import { useGet, useInvalidate, useTaxes, docTotals } from '../hooks';
import { Badge, Card, Combo, Empty, Field, fetchers, fmtDate, money, PageHead, todayStr, useAction, type Option } from '../ui';

interface Line { item: Option | null; track: string; qty: string; rate: string; tax_id: string; batch_no: string; mfg_date: string; expiry_date: string; serials: string }
const blankLine = (): Line => ({ item: null, track: 'none', qty: '1', rate: '', tax_id: '', batch_no: '', mfg_date: '', expiry_date: '', serials: '' });
const serialList = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

export default function BillEdit() {
  const { id } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const { user } = useAuth();
  const canSend = user && ['owner', 'accountant'].includes(user.role);
  const inval = useInvalidate();
  const { run, busy } = useAction();
  const taxes = useTaxes();
  const existing = useGet<any>(isNew ? null : `/api/bills/${id}`);
  const [vendor, setVendor] = useState<Option | null>(null);
  const [h, setH] = useState({ vendor_bill_no: '', bill_date: todayStr(), due_date: '', notes: '', place_of_supply: '', gst_treatment: '' });
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [loaded, setLoaded] = useState(isNew);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const b = existing.data;
    if (!b || loaded) return;
    setVendor({ id: b.vendor_id, label: b.vendor });
    setH({ vendor_bill_no: b.vendor_bill_no ?? '', bill_date: b.bill_date, due_date: b.due_date ?? '', notes: b.notes ?? '', place_of_supply: b.place_of_supply ?? '', gst_treatment: b.gst_treatment ?? '' });
    setLines(b.lines.map((l: any) => ({ item: { id: l.item_id, label: l.item_name, sub: l.sku }, track: l.track_mode, qty: String(l.qty), rate: String(l.rate), tax_id: l.tax_id ?? '',
      batch_no: l.batch_no ?? '', mfg_date: l.mfg_date ?? '', expiry_date: l.expiry_date ?? '', serials: (l.serial_nos ?? []).join('\n') })));
    setLoaded(true);
  }, [existing.data, loaded]);

  const b = existing.data;
  const readonly = !isNew && b && b.status !== 'draft';
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pct = (tid: string) => taxes.data?.find((t) => t.id === tid)?.percentage ?? 0;
  const totals = docTotals(lines.map((l) => ({ qty: Number(l.qty) || 0, rate: Number(l.rate) || 0, tax_pct: pct(l.tax_id) })));

  const problems = (): string | null => {
    if (!vendor) return 'Choose the vendor';
    for (const [i, l] of lines.entries()) {
      if (!l.item) return `Line ${i + 1}: choose an item`;
      if (!(Number(l.qty) > 0)) return `Line ${i + 1}: enter a quantity`;
      if (l.track === 'serial' && serialList(l.serials).length !== Number(l.qty)) return `Line ${i + 1}: ${l.qty} unit(s) need ${l.qty} serial number(s) — you entered ${serialList(l.serials).length}`;
      if (l.track !== 'none' && !l.batch_no && l.track === 'batch') return `Line ${i + 1}: enter the batch number`;
    }
    return null;
  };
  const payload = () => ({
    vendor_id: vendor!.id, vendor_bill_no: h.vendor_bill_no || null, bill_date: h.bill_date, due_date: h.due_date || null, notes: h.notes || null,
    place_of_supply: h.place_of_supply || null, gst_treatment: h.gst_treatment || null,
    lines: lines.map((l) => ({ item_id: l.item!.id, qty: Number(l.qty), rate: Number(l.rate) || 0, tax_id: l.tax_id || null, batch_no: l.batch_no || null,
      mfg_date: l.mfg_date || null, expiry_date: l.expiry_date || null, serial_nos: l.track === 'serial' ? serialList(l.serials) : [] })),
  });
  const save = async (andReceive = false) => {
    const p = problems(); if (p) return run(async () => { throw new Error(p); });
    const r = await run(() => isNew ? api.post('/api/bills', payload()) : api.put(`/api/bills/${id}`, payload()), 'Bill saved');
    if (!r) return;
    if (andReceive && (await run(() => api.post(`/api/bills/${r.id}/receive`), 'Received into stock'))) { inval('/api/'); }
    inval('/api/bills'); nav(`/bills/${r.id}`);
  };
  const upload = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      const form = new FormData(); form.set('owner_type', 'purchase_bill'); form.set('owner_id', id!); form.set('kind', 'bill_scan'); form.set('file', f);
      await run(() => api.upload('/api/attachments', form), `${f.name} attached`);
    }
    if (file.current) file.current.value = ''; inval(`/api/bills/${id}`);
  };

  if (!isNew && existing.isLoading) return <div className="muted">Loading…</div>;
  return (
    <div className="stack">
      <PageHead title={isNew ? 'Record a purchase bill' : `Bill ${b?.number ?? ''}`}>{b && <><Badge v={b.status} />{b.status !== 'draft' && b.status !== 'cancelled' && <Badge v={b.sync_status} label={`Zoho: ${b.sync_status === 'not_synced' ? 'not sent' : b.sync_status === 'pending' ? 'queued' : b.sync_status === 'synced' ? 'in Zoho' : b.sync_status}`} />}</>}</PageHead>

      <Card>
        <div className="grid">
          <Field label="Vendor"><Combo value={vendor} onChange={setVendor} fetcher={fetchers.vendors} disabled={readonly} /></Field>
          <Field label="Vendor's bill number"><input value={h.vendor_bill_no} disabled={readonly} onChange={(e) => setH({ ...h, vendor_bill_no: e.target.value })} /></Field>
          <Field label="Bill date"><input type="date" value={h.bill_date} disabled={readonly} onChange={(e) => setH({ ...h, bill_date: e.target.value })} /></Field>
          <Field label="Due date"><input type="date" value={h.due_date} disabled={readonly} onChange={(e) => setH({ ...h, due_date: e.target.value })} /></Field>
        </div>
      </Card>

      {lines.map((l, i) => (
        <Card key={i} title={`Line ${i + 1}`} right={!readonly && lines.length > 1 ? <button className="btn small danger" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button> : undefined}>
          <div className="grid">
            <Field label="Item"><Combo value={l.item} disabled={readonly} fetcher={fetchers.physicalItems}
              onChange={(o) => o ? setLine(i, { item: o, track: o.data.track_mode, rate: String(o.data.purchase_rate || ''), tax_id: o.data.tax_id ?? '' }) : setLine(i, { item: null })} /></Field>
            <Field label="Quantity"><input inputMode="decimal" value={l.qty} disabled={readonly} onChange={(e) => setLine(i, { qty: e.target.value })} /></Field>
            <Field label="Rate"><input inputMode="decimal" value={l.rate} disabled={readonly} onChange={(e) => setLine(i, { rate: e.target.value })} /></Field>
            <Field label="Tax (Zoho)"><select value={l.tax_id} disabled={readonly} onChange={(e) => setLine(i, { tax_id: e.target.value })}><option value="">—</option>{taxes.data?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.percentage}%)</option>)}</select></Field>
          </div>
          {l.track !== 'none' && (
            <div className="grid" style={{ marginTop: 12 }}>
              <Field label={l.track === 'batch' ? 'Batch number' : 'Batch number (optional)'}><input value={l.batch_no} disabled={readonly} onChange={(e) => setLine(i, { batch_no: e.target.value })} /></Field>
              <Field label="Manufactured"><input type="date" value={l.mfg_date} disabled={readonly} onChange={(e) => setLine(i, { mfg_date: e.target.value })} /></Field>
              <Field label="Expiry"><input type="date" value={l.expiry_date} disabled={readonly} onChange={(e) => setLine(i, { expiry_date: e.target.value })} /></Field>
            </div>)}
          {l.track === 'serial' && (
            <div style={{ marginTop: 12 }}><Field label="Serial numbers" hint={`One per line (or comma separated). ${serialList(l.serials).length} of ${l.qty || 0} entered.`}>
              <textarea value={l.serials} disabled={readonly} onChange={(e) => setLine(i, { serials: e.target.value })} /></Field></div>)}
        </Card>
      ))}
      {!readonly && <div><button className="btn" onClick={() => setLines([...lines, blankLine()])}>+ Add line</button></div>}

      <Card><div className="row" style={{ justifyContent: 'flex-end' }}>
        <span className="muted">Subtotal {money(totals.subtotal)}</span><span className="muted">Tax {money(totals.tax)}</span><strong>Total {money(totals.total)}</strong></div>
        <p className="muted small" style={{ marginBottom: 0 }}>Totals here are a preview; Zoho calculates the final amounts using its own tax settings.</p></Card>

      {!isNew && (
        <Card title="Scanned bill / attachments">
          {b?.attachments?.length ? b.attachments.map((a: any) => <div key={a.id}><a href="#" onClick={(e) => { e.preventDefault(); void openProtected(`/api/attachments/${a.id}/file`); }}>{a.filename}</a> <span className="muted small">{fmtDate(a.created_at)}</span></div>) : <div className="muted small">Nothing attached yet</div>}
          <input ref={file} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => upload(e.target.files)} />
          <div style={{ marginTop: 8 }}><button className="btn" onClick={() => file.current?.click()}>Attach photo / PDF</button></div>
        </Card>)}

      {b && b.status === 'received' && b.sync_status === 'not_synced' && (
        <Card title="Not in Zoho yet">
          <p style={{ marginTop: 0 }}>The stock is recorded here, but this bill has <strong>not</strong> been posted to Zoho. Zoho has no draft state for bills, so it will be created as an <strong>open</strong> bill.</p>
          {canSend
            ? <button className="btn primary" disabled={busy} onClick={async () => { if (confirm('Post this bill to Zoho as an open bill? Check the vendor, bill number and amounts first.') && await run(() => api.post(`/api/bills/${id}/send-to-zoho`), 'Queued for Zoho')) { inval('/api/'); } }}>Send to Zoho</button>
            : <div className="muted small">Waiting for an accountant to send it.</div>}
        </Card>)}

      {b?.outbox?.last_error && <Card title="Zoho"><div className="bad">{b.outbox.last_error}</div>
        <div style={{ marginTop: 8 }}><button className="btn" onClick={async () => { await run(() => api.post(`/api/bills/${id}/resync`), 'Queued again'); inval(`/api/bills/${id}`); }}>Retry sync</button></div></Card>}

      {!readonly && <p className="muted small" style={{ margin: 0 }}>Receiving a bill adds the stock here only. It is <strong>not</strong> posted to Zoho until an accountant presses <em>Send to Zoho</em> on the bill.</p>}
      {!readonly && (
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => save(false)}>Save draft</button>
          <button className="btn primary" disabled={busy} onClick={() => save(true)}>Save & receive into stock</button>
          {!isNew && <button className="btn danger" disabled={busy} onClick={async () => { if (confirm('Cancel this draft bill?') && await run(() => api.post(`/api/bills/${id}/cancel`), 'Cancelled')) nav('/bills'); }}>Cancel bill</button>}
        </div>)}
      {readonly && b.status === 'cancelled' && <Empty text="This bill was cancelled." />}
    </div>
  );
}
