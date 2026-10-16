import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fetchBlobUrl, openProtected } from '../api';
import { useAuth } from '../auth';
import { useGet, useInvalidate } from '../hooks';
import { Badge, Card, Field, fmtDate, fmtDateTime, money, PageHead, useAction } from '../ui';

const EVENT: Record<string, string> = { created: 'Job created', checkin: 'Technician checked in', checkout: 'Checked out', note: 'Note', checklist: 'Checklist updated', part: 'Part used',
  completed: 'Job completed', coverage: 'Coverage changed', invoiced: 'Invoice created', updated: 'Details updated', cancelled: 'Cancelled', stock_shortfall: 'Stock shortfall flagged' };

function Thumb({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { let u: string; fetchBlobUrl(`/api/attachments/${id}/file`).then((x) => { u = x; setUrl(x); }).catch(() => {}); return () => { if (u) URL.revokeObjectURL(u); }; }, [id]);
  return url ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="Job attachment" /></a> : <div className="muted small">…</div>;
}

export default function JobDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const inval = useInvalidate();
  const { run, busy } = useAction();
  const q = useGet<any>(`/api/jobs/${id}`);
  const techs = useGet<any[]>('/api/technicians');
  const j = q.data;
  const [assign, setAssign] = useState({ assigned_to: '', scheduled_start: '' });
  const [cov, setCov] = useState({ coverage: '', reason: '' });
  const [bill, setBill] = useState({ labour_rate_per_hr: '', travel_charge: '' });
  useEffect(() => {
    if (!j) return;
    setAssign({ assigned_to: j.assigned_to ?? '', scheduled_start: j.scheduled_start ? new Date(j.scheduled_start).toLocaleString('sv').slice(0, 16).replace(' ', 'T') : '' });
    setCov({ coverage: j.coverage ?? '', reason: j.coverage_override_reason ?? '' });
    setBill({ labour_rate_per_hr: String(j.labour_rate_per_hr || ''), travel_charge: String(j.travel_charge || '') });
  }, [j]);
  if (!j) return <div className="muted">Loading…</div>;

  const sup = user && ['owner', 'supervisor'].includes(user.role);
  const acc = user && ['owner', 'supervisor', 'accountant'].includes(user.role);
  const locked = ['invoiced', 'closed', 'cancelled'].includes(j.status);
  const refresh = () => { inval(`/api/jobs`); inval('/api/dashboard'); };
  const patch = (body: object, ok: string) => run(() => api.patch(`/api/jobs/${id}`, body), ok).then((r) => r && refresh());
  const chargeable = j.parts.filter((p: any) => p.chargeable).reduce((s: number, p: any) => s + p.qty * p.unit_price, 0);
  const labour = (j.labour_minutes / 60) * (Number(bill.labour_rate_per_hr) || 0);

  return (
    <div className="stack">
      <Link to="/jobs">← All jobs</Link>
      <PageHead title={`${j.number} · ${j.kind.replace(/_/g, ' ')}`}><Badge v={j.status} />{j.coverage && <Badge v={j.coverage} />}{j.priority !== 'normal' && <Badge v={j.priority} />}</PageHead>

      <div className="grid two">
        <Card title="Customer & unit">
          <div><strong>{j.customer}</strong> {j.customer_phone && <a href={`tel:${j.customer_phone}`}>{j.customer_phone}</a>}</div>
          {j.site_address && <div className="small">{j.site_address}</div>}
          {j.contact_name && <div className="small muted">Contact: {j.contact_name} {j.contact_phone}</div>}
          {j.item_name && <div style={{ marginTop: 8 }}>{j.item_name} · <strong>{j.serial_no}</strong></div>}
          {j.warranty && <div className="small" style={{ marginTop: 4 }}>{j.warranty.coverage.in_warranty ? `In warranty until ${fmtDate(j.warranty.coverage.ends_on)}` : `Warranty ended ${fmtDate(j.warranty.coverage.ends_on)}`}</div>}
          {j.contract_number && <div className="small">AMC: {j.contract_number}</div>}
          {j.problem && <p><strong>Problem:</strong> {j.problem}</p>}
          {j.resolution && <p><strong>Resolution:</strong> {j.resolution}</p>}
          {j.signed_by_name && <div className="small muted">Signed by {j.signed_by_name} on {fmtDateTime(j.signed_at)}</div>}
        </Card>

        {sup && !locked && (
          <Card title="Assignment">
            <div className="stack">
              <Field label="Technician"><select value={assign.assigned_to} onChange={(e) => setAssign({ ...assign, assigned_to: e.target.value })}><option value="">Unassigned</option>{techs.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
              <Field label="Visit date & time"><input type="datetime-local" value={assign.scheduled_start} onChange={(e) => setAssign({ ...assign, scheduled_start: e.target.value })} /></Field>
              <button className="btn" disabled={busy} onClick={() => patch({ assigned_to: assign.assigned_to || null, scheduled_start: assign.scheduled_start ? new Date(assign.scheduled_start).toISOString() : null }, 'Assignment saved')}>Save assignment</button>
            </div>
          </Card>)}
      </div>

      {sup && !locked && (
        <Card title="Who pays?">
          <p className="muted small" style={{ marginTop: 0 }}>Suggested: <strong>{(j.coverage_suggested ?? '').replace(/_/g, ' ')}</strong>. You can override it — a reason is recorded.</p>
          <div className="grid">
            <Field label="Coverage"><select value={cov.coverage} onChange={(e) => setCov({ ...cov, coverage: e.target.value })}>{['in_warranty', 'out_of_warranty', 'goodwill', 'amc'].map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}</select></Field>
            <Field label="Reason (if different from suggested)"><input value={cov.reason} onChange={(e) => setCov({ ...cov, reason: e.target.value })} /></Field>
          </div>
          <div style={{ marginTop: 10 }}><button className="btn" disabled={busy || cov.coverage === j.coverage} onClick={() => run(() => api.post(`/api/jobs/${id}/coverage`, cov), 'Coverage updated').then((r) => r && refresh())}>Update coverage</button></div>
          {j.coverage_override_reason && <div className="small muted" style={{ marginTop: 6 }}>Current override reason: {j.coverage_override_reason}</div>}
        </Card>)}

      <Card title="Parts used (drawn from store)">
        {j.parts.length === 0 ? <div className="muted small">None</div> : (
          <table><tbody>{j.parts.map((p: any) => <tr key={p.id}><td>{p.item_name}{p.serial_no ? ` (${p.serial_no})` : ''}</td><td>{p.qty}</td><td>{money(p.unit_price)}</td><td>{p.chargeable ? <Badge v="out_of_warranty" label="billed" /> : <Badge v="in_warranty" label="no charge" />}</td></tr>)}</tbody></table>)}
        {j.checklist.length > 0 && <><h3 style={{ marginTop: 14 }}>Checklist</h3>{j.checklist.map((c: any) => <div key={c.id} className="small">{c.done ? '✓' : '○'} {c.label}</div>)}</>}
      </Card>

      {acc && j.coverage === 'out_of_warranty' && (
        <Card title="Customer charges">
          {!locked ? (
            <div className="grid">
              <Field label="Labour rate per hour"><input inputMode="decimal" value={bill.labour_rate_per_hr} onChange={(e) => setBill({ ...bill, labour_rate_per_hr: e.target.value })} /></Field>
              <Field label="Travel charge"><input inputMode="decimal" value={bill.travel_charge} onChange={(e) => setBill({ ...bill, travel_charge: e.target.value })} /></Field>
            </div>) : null}
          <p className="small muted">Parts {money(chargeable)} + labour {j.labour_minutes} min ≈ {money(labour)} + travel {money(Number(bill.travel_charge) || 0)} (before tax; Zoho applies tax).</p>
          <div className="row">
            {!locked && <button className="btn" disabled={busy} onClick={() => patch({ labour_rate_per_hr: Number(bill.labour_rate_per_hr) || 0, travel_charge: Number(bill.travel_charge) || 0 }, 'Charges saved')}>Save charges</button>}
            {j.status === 'completed' && !j.invoice_id && <button className="btn primary" disabled={busy} onClick={async () => { await run(() => api.post(`/api/jobs/${id}/invoice`), 'Draft invoice created'); refresh(); }}>Create draft invoice</button>}
            {j.invoice_id && <Link className="btn" to={`/invoices/${j.invoice_id}`}>View invoice {j.invoice_number}</Link>}
          </div>
        </Card>)}

      {j.attachments.length > 0 && <Card title="Photos & signature"><div className="photo-grid">{j.attachments.filter((a: any) => a.mime.startsWith('image/')).map((a: any) => <Thumb key={a.id} id={a.id} />)}</div>
        {j.attachments.filter((a: any) => !a.mime.startsWith('image/')).map((a: any) => <div key={a.id}><a href="#" onClick={(e) => { e.preventDefault(); void openProtected(`/api/attachments/${a.id}/file`); }}>{a.filename}</a></div>)}</Card>}

      {sup && (
        <div className="row">
          <label className="row"><input type="checkbox" checked={j.vendor_recovery} disabled={locked} onChange={(e) => patch({ vendor_recovery: e.target.checked }, 'Saved')} />Claim back from supplier</label>
          {['completed', 'invoiced'].includes(j.status) && <button className="btn primary" disabled={busy} onClick={async () => { await run(() => api.post(`/api/jobs/${id}/close`), 'Job closed'); refresh(); }}>Close job</button>}
          {['new', 'scheduled', 'on_hold'].includes(j.status) && <button className="btn danger" disabled={busy} onClick={async () => { const reason = prompt('Reason for cancelling?'); if (reason) { await run(() => api.post(`/api/jobs/${id}/cancel`, { reason }), 'Cancelled'); refresh(); } }}>Cancel job</button>}
        </div>)}

      <Card title="Timeline"><div className="timeline">{j.events.map((e: any, i: number) => (
        <div key={i} className="ev"><strong>{EVENT[e.kind] ?? e.kind}</strong> <span className="muted small">{fmtDateTime(e.at)} · {e.actor ?? 'system'}</span>
          {e.kind === 'note' && <div className="small">{e.payload.text}</div>}
          {e.kind === 'part' && <div className="small">{e.payload.item} × {e.payload.qty}</div>}
          {e.kind === 'coverage' && <div className="small">{String(e.payload.from).replace(/_/g, ' ')} → {String(e.payload.to).replace(/_/g, ' ')}{e.payload.reason ? ` — ${e.payload.reason}` : ''}</div>}
          {e.kind === 'stock_shortfall' && <div className="small bad">{e.payload.item}: store had {e.payload.had}, used {e.payload.used} — check the stock count</div>}
        </div>))}</div></Card>
    </div>
  );
}
