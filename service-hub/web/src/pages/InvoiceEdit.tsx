import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useGet, useInvalidate, useTaxes, docTotals } from '../hooks';
import { Badge, Card, Combo, Field, fetchers, fmtDate, money, PageHead, todayStr, useAction, type Option } from '../ui';

interface Line { item: Option | null; track: string; qty: string; rate: string; discount: string; tax_id: string; batch_id: string; serial_ids: string[]; service: boolean }
const blankLine = (): Line => ({ item: null, track: 'none', qty: '1', rate: '', discount: '', tax_id: '', batch_id: '', serial_ids: [], service: false });

export default function InvoiceEdit() {
  const { id } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const { user } = useAuth();
  const inval = useInvalidate();
  const { run, busy } = useAction();
  const taxes = useTaxes();
  const existing = useGet<any>(isNew ? null : `/api/invoices/${id}`);
  const [customer, setCustomer] = useState<Option | null>(null);
  const [h, setH] = useState({ invoice_date: todayStr(), due_date: '', notes: '', terms: '', place_of_supply: '', gst_treatment: '' });
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [loaded, setLoaded] = useState(isNew);

  useEffect(() => {
    const d = existing.data;
    if (!d || loaded) return;
    setCustomer({ id: d.customer_id, label: d.customer });
    setH({ invoice_date: d.invoice_date, due_date: d.due_date ?? '', notes: d.notes ?? '', terms: d.terms ?? '', place_of_supply: d.place_of_supply ?? '', gst_treatment: d.gst_treatment ?? '' });
    setLines(d.lines.map((l: any) => ({ item: { id: l.item_id, label: l.item_name, sub: l.sku }, track: l.track_mode, qty: String(l.qty), rate: String(l.rate), discount: l.discount_pct ? String(l.discount_pct) : '',
      tax_id: l.tax_id ?? '', batch_id: l.batch_id ?? '', serial_ids: l.serial_ids ?? [], service: false })));
    setLoaded(true);
  }, [existing.data, loaded]);

  const d = existing.data;
  const readonly = !isNew && d && d.status !== 'draft';
  const canConfirm = user && ['owner', 'accountant'].includes(user.role);
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pct = (tid: string) => taxes.data?.find((t) => t.id === tid)?.percentage ?? 0;
  const totals = docTotals(lines.map((l) => ({ qty: Number(l.qty) || 0, rate: Number(l.rate) || 0, discount_pct: Number(l.discount) || 0, tax_pct: pct(l.tax_id) })));

  const pickCustomer = (o: Option | null) => {
    setCustomer(o);
    if (o?.data) setH((x) => ({ ...x, place_of_supply: o.data.place_of_supply ?? x.place_of_supply, gst_treatment: o.data.gst_treatment ?? x.gst_treatment }));
  };
  const problems = (): string | null => {
    if (!customer) return 'Choose the customer';
    for (const [i, l] of lines.entries()) {
      if (!l.item) return `Line ${i + 1}: choose an item`;
      if (!(Number(l.qty) > 0)) return `Line ${i + 1}: enter a quantity`;
      if (l.track === 'serial' && l.serial_ids.length !== Number(l.qty)) return `Line ${i + 1}: select ${l.qty} serial number(s) — ${l.serial_ids.length} selected`;
      if (l.track === 'batch' && !l.batch_id) return `Line ${i + 1}: select a batch`;
    }
    return null;
  };
  const payload = () => ({
    customer_id: customer!.id, invoice_date: h.invoice_date, due_date: h.due_date || null, notes: h.notes || null, terms: h.terms || null,
    place_of_supply: h.place_of_supply || null, gst_treatment: h.gst_treatment || null,
    lines: lines.map((l) => ({ item_id: l.item!.id, qty: Number(l.qty), rate: Number(l.rate) || 0, discount_pct: Number(l.discount) || 0, tax_id: l.tax_id || null,
      batch_id: l.batch_id || null, serial_ids: l.serial_ids })),
  });
  const save = async (andConfirm = false) => {
    const p = problems(); if (p) return run(async () => { throw new Error(p); });
    const r = await run(() => isNew ? api.post('/api/invoices', payload()) : api.put(`/api/invoices/${id}`, payload()), 'Invoice saved');
    if (!r) return;
    if (andConfirm) {
      const c = await run(() => api.post(`/api/invoices/${r.id}/confirm`), 'Invoice confirmed — queued for Zoho as a draft');
      if (!c) { nav(`/invoices/${r.id}`); return; }
    }
    inval('/api/'); nav(`/invoices/${r.id}`);
  };

  if (!isNew && existing.isLoading) return <div className="muted">Loading…</div>;
  return (
    <div className="stack">
      <PageHead title={isNew ? 'New invoice' : `Invoice ${d?.number ?? ''}`}>
        {d && <><Badge v={d.status} />{d.status !== 'draft' && <Badge v={d.sync_status} label={`Zoho: ${d.sync_status.replace('_', ' ')}${d.zoho_status ? ' (' + d.zoho_status + ')' : ''}`} />}</>}
      </PageHead>

      <Card>
        <div className="grid">
          <Field label="Customer"><Combo value={customer} onChange={pickCustomer} fetcher={fetchers.customers} disabled={readonly} /></Field>
          <Field label="Invoice date" hint="Warranty starts on this date"><input type="date" value={h.invoice_date} disabled={readonly} onChange={(e) => setH({ ...h, invoice_date: e.target.value })} /></Field>
          <Field label="Due date"><input type="date" value={h.due_date} disabled={readonly} onChange={(e) => setH({ ...h, due_date: e.target.value })} /></Field>
        </div>
        {(h.place_of_supply || h.gst_treatment) && <div className="muted small" style={{ marginTop: 8 }}>From Zoho contact — GST treatment: {h.gst_treatment || '—'} · Place of supply: {h.place_of_supply || '—'}</div>}
      </Card>

      {lines.map((l, i) => (
        <Card key={i} title={`Line ${i + 1}`} right={!readonly && lines.length > 1 ? <button className="btn small danger" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button> : undefined}>
          <div className="grid">
            <Field label="Item"><Combo value={l.item} disabled={readonly} fetcher={fetchers.items}
              onChange={(o) => o ? setLine(i, { item: o, track: o.data.track_mode, rate: String(o.data.rate || ''), tax_id: o.data.tax_id ?? '', service: o.data.is_service, serial_ids: [], batch_id: '' }) : setLine(i, { item: null })} /></Field>
            <Field label="Quantity"><input inputMode="decimal" value={l.qty} disabled={readonly} onChange={(e) => setLine(i, { qty: e.target.value })} /></Field>
            <Field label="Rate"><input inputMode="decimal" value={l.rate} disabled={readonly} onChange={(e) => setLine(i, { rate: e.target.value })} /></Field>
            <Field label="Discount %"><input inputMode="decimal" value={l.discount} disabled={readonly} onChange={(e) => setLine(i, { discount: e.target.value })} /></Field>
            <Field label="Tax (Zoho)"><select value={l.tax_id} disabled={readonly} onChange={(e) => setLine(i, { tax_id: e.target.value })}><option value="">—</option>{taxes.data?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.percentage}%)</option>)}</select></Field>
          </div>
          {l.item && l.track === 'serial' && !readonly && <SerialPicker itemId={l.item.id} selected={l.serial_ids} want={Number(l.qty) || 0} onChange={(ids) => setLine(i, { serial_ids: ids })} />}
          {l.item && l.track === 'serial' && readonly && <div className="small" style={{ marginTop: 8 }}>Serials: {(d.lines[i]?.serial_nos ?? []).join(', ')}</div>}
          {l.item && l.track === 'batch' && !readonly && <BatchPicker itemId={l.item.id} value={l.batch_id} onChange={(v) => setLine(i, { batch_id: v })} />}
        </Card>
      ))}
      {!readonly && <div><button className="btn" onClick={() => setLines([...lines, blankLine()])}>+ Add line</button></div>}

      <Card>
        <div className="row" style={{ justifyContent: 'flex-end' }}><span className="muted">Subtotal {money(totals.subtotal)}</span><span className="muted">Tax {money(totals.tax)}</span><strong>Total {money(totals.total)}</strong></div>
        {d?.zoho_total != null && <div className="row" style={{ justifyContent: 'flex-end' }}><span className={Math.abs(d.zoho_total - d.total) > 0.5 ? 'bad' : 'muted'}>Zoho total {money(d.zoho_total)}{Math.abs(d.zoho_total - d.total) > 0.5 ? ' — differs from this app by more than rounding, check in Zoho' : ''}</span></div>}
        <p className="muted small" style={{ marginBottom: 0 }}>Totals here are a preview; Zoho calculates the final amounts using its own tax settings.</p>
      </Card>

      {readonly && d.warranties?.length > 0 && (
        <Card title="Warranties issued">
          {d.warranties.map((w: any) => <div key={w.id} className="small" style={{ padding: '4px 0' }}><strong>{w.item_name}</strong> {w.serial_no} — from {fmtDate(w.start_date)}, parts to {fmtDate(w.parts_end)}, labour to {fmtDate(w.labour_end)}</div>)}
        </Card>)}
      {d?.outbox?.last_error && (
        <Card title="Zoho"><div className="bad">{d.outbox.last_error}</div>
          <div style={{ marginTop: 8 }}><button className="btn" onClick={async () => { await run(() => api.post(`/api/invoices/${id}/resync`), 'Queued again'); inval(`/api/invoices/${id}`); }}>Retry sync</button></div></Card>)}

      {!readonly && (
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => save(false)}>Save draft</button>
          {canConfirm && <button className="btn primary" disabled={busy} onClick={() => save(true)}>Save & confirm</button>}
          {!isNew && <button className="btn danger" disabled={busy} onClick={async () => { if (confirm('Cancel this draft invoice?') && await run(() => api.post(`/api/invoices/${id}/cancel`), 'Cancelled')) nav('/invoices'); }}>Cancel</button>}
        </div>)}
      {!readonly && canConfirm && <p className="muted small">Confirming issues the stock, marks serial numbers as sold, starts each unit's warranty on the invoice date, and sends a <strong>draft</strong> invoice to Zoho for review.</p>}
    </div>
  );
}

function SerialPicker({ itemId, selected, want, onChange }: { itemId: string; selected: string[]; want: number; onChange: (ids: string[]) => void }) {
  const list = useGet<any[]>(`/api/items/${itemId}/available-serials`);
  const [q, setQ] = useState('');
  const shown = (list.data ?? []).filter((s) => s.serial_no.toLowerCase().includes(q.toLowerCase())).slice(0, 60);
  return (
    <div style={{ marginTop: 12 }}>
      <Field label={`Serial numbers — ${selected.length} of ${want} selected`}><input placeholder="Filter available serials" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
      {list.data && list.data.length === 0 && <div className="bad small">No units in stock for this item.</div>}
      <div className="row" style={{ marginTop: 8 }}>
        {shown.map((s) => {
          const on = selected.includes(s.id);
          return <button key={s.id} type="button" className={`btn small ${on ? 'primary' : ''}`} onClick={() => onChange(on ? selected.filter((x) => x !== s.id) : [...selected, s.id])}>{s.serial_no}{s.batch_no ? ` · ${s.batch_no}` : ''}</button>;
        })}
      </div>
    </div>
  );
}

function BatchPicker({ itemId, value, onChange }: { itemId: string; value: string; onChange: (v: string) => void }) {
  const list = useGet<any[]>(`/api/batches${qs({ item_id: itemId })}`);
  return (
    <div style={{ marginTop: 12 }}><Field label="Batch" hint="Earliest expiry is listed first">
      <select value={value} onChange={(e) => onChange(e.target.value)}><option value="">— choose a batch —</option>
        {list.data?.filter((b) => b.on_hand > 0).map((b) => <option key={b.id} value={b.id}>{b.batch_no} · {b.on_hand} in stock{b.expiry_date ? ` · exp ${fmtDate(b.expiry_date)}` : ''}</option>)}</select></Field></div>
  );
}
