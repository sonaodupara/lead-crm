import { useState } from 'react';
import { api, openProtected, qs } from '../api';
import { useAuth } from '../auth';
import { useGet, useInvalidate } from '../hooks';
import { Badge, Field, fmtDate, Modal, PageHead, Table, useAction } from '../ui';

export default function Warranties() {
  const [q, setQ] = useState('');
  const [view, setView] = useState<'active' | '30' | '60' | '90' | 'expired' | 'all'>('active');
  const [open, setOpen] = useState<string | null>(null);
  const list = useGet<any[]>(`/api/warranties${qs({ q, status: view === 'active' || view === '30' || view === '60' || view === '90' ? 'active' : view === 'expired' ? 'expired' : undefined,
    expiring_days: ['30', '60', '90'].includes(view) ? view : undefined })}`);
  const tabs: [typeof view, string][] = [['active', 'In warranty'], ['30', 'Ending ≤ 30 days'], ['60', '≤ 60'], ['90', '≤ 90'], ['expired', 'Expired'], ['all', 'All']];
  return (
    <div className="stack">
      <PageHead title="Warranties" />
      <div className="row">{tabs.map(([k, l]) => <button key={k} className={`btn small ${view === k ? 'primary' : ''}`} onClick={() => setView(k)}>{l}</button>)}</div>
      <input placeholder="Search serial, customer or phone" value={q} onChange={(e) => setQ(e.target.value)} />
      <Table rows={list.data} onRow={(r) => setOpen(r.id)} empty="No warranties match." cols={[
        { head: 'Unit', cell: (r) => <><strong>{r.item_name}</strong><div className="muted small">{r.serial_no}</div></> },
        { head: 'Customer', cell: (r) => <>{r.customer}<div className="muted small">{r.phone}</div></> },
        { head: 'Invoice', cell: (r) => <>{r.invoice_number}<div className="muted small">{fmtDate(r.start_date)}</div></> },
        { head: 'Status', cell: (r) => <Badge v={r.status === 'void' ? 'void' : r.coverage.in_warranty ? 'in_warranty' : 'expired'} label={r.status === 'void' ? 'void' : r.coverage.in_warranty ? `${r.coverage.days_left}d left` : 'expired'} /> },
        { head: 'Ends', cell: (r) => fmtDate(r.coverage.ends_on) },
      ]} />
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const { user } = useAuth();
  const w = useGet<any>(`/api/warranties/${id}`);
  const inval = useInvalidate();
  const { run, busy } = useAction();
  const [months, setMonths] = useState('12');
  const [price, setPrice] = useState('0');
  const [reason, setReason] = useState('');
  const d = w.data;
  const canManage = user && ['owner', 'supervisor'].includes(user.role);
  return (
    <Modal title="Warranty" onClose={onClose}>
      {!d ? 'Loading…' : (
        <div className="stack">
          <div><strong>{d.item_name}</strong> · {d.serial_no}<div className="muted small">{d.customer} · {d.phone} · {d.invoice_number}</div></div>
          <div className="row"><Badge v={d.status === 'void' ? 'void' : d.coverage.in_warranty ? 'in_warranty' : 'expired'} label={d.status === 'void' ? 'void' : d.coverage.in_warranty ? 'In warranty' : 'Expired'} />
            <span className="small">Started {fmtDate(d.start_date)} (invoice date)</span></div>
          <table><tbody>
            <tr><th>Parts</th><td>{fmtDate(d.parts_end)}</td></tr><tr><th>Labour</th><td>{fmtDate(d.labour_end)}</td></tr><tr><th>On-site</th><td>{fmtDate(d.onsite_end)}</td></tr>
            {d.extended_months > 0 && <tr><th>Extended</th><td>{d.extended_months} months</td></tr>}
          </tbody></table>
          {d.terms_snapshot?.terms_text && <div className="card small">{d.terms_snapshot.terms_text}</div>}
          {d.terms_snapshot?.exclusions && <div className="small"><strong>Exclusions:</strong> {d.terms_snapshot.exclusions}</div>}
          {d.terms_snapshot?.conditions && <div className="small"><strong>Conditions:</strong> {d.terms_snapshot.conditions}</div>}
          <div><button className="btn" onClick={() => void openProtected(`/api/warranties/${id}/certificate`)}>Open certificate</button></div>
          {canManage && d.status === 'active' && (
            <div className="card"><h3>Extended warranty</h3>
              <div className="grid"><Field label="Add months"><input inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} /></Field>
                <Field label="Price charged"><input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field></div>
              <div style={{ marginTop: 10 }}><button className="btn" disabled={busy} onClick={async () => {
                if (await run(() => api.post(`/api/warranties/${id}/extend`, { months: Number(months), price: Number(price) }), 'Warranty extended')) { inval('/api/warranties'); }
              }}>Extend</button></div>
              <p className="muted small">Bill the extension separately as a service item on an invoice.</p>
            </div>)}
          {canManage && d.status === 'active' && (
            <div className="card"><h3>Void warranty</h3>
              <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <div style={{ marginTop: 10 }}><button className="btn danger" disabled={busy || reason.length < 3} onClick={async () => {
                if (await run(() => api.post(`/api/warranties/${id}/void`, { reason }), 'Warranty voided')) { inval('/api/warranties'); onClose(); }
              }}>Void</button></div></div>)}
        </div>)}
    </Modal>
  );
}
