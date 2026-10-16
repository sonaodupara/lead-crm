import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { qs } from '../api';
import { useGet } from '../hooks';
import { Badge, fmtDate, money, PageHead, Table } from '../ui';

export default function Invoices() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const list = useGet<any[]>(`/api/invoices${qs({ q, status })}`);
  return (
    <div className="stack">
      <PageHead title="Sales invoices"><button className="btn primary" onClick={() => nav('/invoices/new')}>New invoice</button></PageHead>
      <div className="row"><div className="grow"><input placeholder="Search customer or number" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="draft">Draft</option><option value="confirmed">Confirmed</option><option value="cancelled">Cancelled</option></select></div>
      <Table rows={list.data} onRow={(r) => nav(`/invoices/${r.id}`)} empty="No invoices yet." cols={[
        { head: 'Invoice', cell: (r) => <><strong>{r.number}</strong><div className="muted small">{r.zoho_invoice_number ? `Zoho ${r.zoho_invoice_number}` : r.source !== 'manual' ? r.source.replace('_', ' ') : ''}</div></> },
        { head: 'Customer', cell: (r) => r.customer }, { head: 'Date', cell: (r) => fmtDate(r.invoice_date) },
        { head: 'Total', className: 'right', cell: (r) => money(r.total) }, { head: 'Status', cell: (r) => <Badge v={r.status} /> },
        { head: 'In Zoho', cell: (r) => r.status === 'draft' ? '—' : <><Badge v={r.sync_status} />{r.zoho_status && <span className="muted small"> {r.zoho_status}</span>}</> },
      ]} />
    </div>
  );
}
