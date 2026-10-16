import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useGet, useInvalidate } from '../hooks';
import { Badge, Card, fmtDate, money, PageHead, Table, useAction } from '../ui';

export default function AmcDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const inval = useInvalidate();
  const { run, busy } = useAction();
  const q = useGet<any>(`/api/amc/${id}`);
  const k = q.data;
  if (!k) return <div className="muted">Loading…</div>;
  const sup = user && ['owner', 'supervisor'].includes(user.role);
  const acc = user && ['owner', 'accountant'].includes(user.role);
  const refresh = () => { inval(`/api/amc`); inval('/api/jobs'); };
  return (
    <div className="stack">
      <Link to="/amc">← Contracts</Link>
      <PageHead title={`${k.number} · ${k.customer}`}><Badge v={k.status} /></PageHead>
      <Card>
        <div className="small">{fmtDate(k.start_date)} – {fmtDate(k.end_date)} · {k.visits_per_year} visit(s) a year · {k.billing_mode === 'annual' ? `Annual ${money(k.annual_amount)}` : `${money(k.per_visit_amount)} per visit`}</div>
        <div style={{ marginTop: 8 }}>{k.units.map((u: any) => <div key={u.serial_id}>{u.item_name} · <strong>{u.serial_no}</strong></div>)}</div>
        <div className="row" style={{ marginTop: 12 }}>
          {acc && k.billing_mode === 'annual' && !k.annual_invoice_id && <button className="btn primary" disabled={busy} onClick={async () => { const r = await run(() => api.post(`/api/amc/${id}/invoice`), 'Draft invoice created'); if (r) nav(`/invoices/${r.invoice_id}`); }}>Create annual invoice</button>}
          {k.annual_invoice_id && <Link className="btn" to={`/invoices/${k.annual_invoice_id}`}>View annual invoice</Link>}
          {sup && <button className="btn" disabled={busy} onClick={async () => { const r = await run(() => api.post(`/api/amc/${id}/renew`), 'Renewal created'); if (r) nav(`/amc/${r.id}`); }}>Renew for next term</button>}
          {sup && k.status === 'active' && <button className="btn danger" disabled={busy} onClick={async () => { if (confirm('Cancel this contract?')) { await run(() => api.post(`/api/amc/${id}/cancel`), 'Cancelled'); refresh(); } }}>Cancel contract</button>}
        </div>
      </Card>
      <h2>Visits</h2>
      <Table rows={k.visits} cols={[
        { head: 'Due', cell: (v) => fmtDate(v.due_date) }, { head: 'Status', cell: (v) => <Badge v={v.status === 'scheduled' ? 'scheduled' : v.status === 'done' ? 'completed' : 'cancelled'} label={v.status} /> },
        { head: 'Job', cell: (v) => v.job_id ? <Link to={`/jobs/${v.job_id}`}>{v.job_number} <span className="muted small">({v.job_status})</span></Link> : <span className="muted">Not created yet</span> },
        { head: 'Invoice', cell: (v) => v.invoice_id ? <Link to={`/invoices/${v.invoice_id}`}>{v.invoice_number}</Link> : '—' },
        { head: '', cell: (v) => (
          <span className="row">
            {sup && !v.job_id && v.status === 'scheduled' && <button className="btn small" disabled={busy} onClick={async () => { await run(() => api.post(`/api/amc/visits/${v.id}/job`), 'Job created'); refresh(); }}>Create job</button>}
            {acc && k.billing_mode === 'per_visit' && v.status === 'done' && !v.invoice_id && <button className="btn small primary" disabled={busy} onClick={async () => { const r = await run(() => api.post(`/api/amc/visits/${v.id}/invoice`), 'Draft invoice created'); if (r) nav(`/invoices/${r.invoice_id}`); }}>Bill visit</button>}
          </span>) },
      ]} />
    </div>
  );
}
