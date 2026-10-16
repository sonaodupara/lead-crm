import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { qs } from '../api';
import { useGet } from '../hooks';
import { Badge, fmtDate, money, PageHead, Table } from '../ui';

export default function Bills() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const list = useGet<any[]>(`/api/bills${qs({ q, status })}`);
  return (
    <div className="stack">
      <PageHead title="Purchase bills"><button className="btn primary" onClick={() => nav('/bills/new')}>Record a bill</button></PageHead>
      <div className="row"><div className="grow"><input placeholder="Search vendor, bill number" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="draft">Draft</option><option value="received">Received</option><option value="cancelled">Cancelled</option></select></div>
      <Table rows={list.data} onRow={(r) => nav(`/bills/${r.id}`)} empty="No bills yet." cols={[
        { head: 'Bill', cell: (r) => <><strong>{r.number}</strong><div className="muted small">{r.vendor_bill_no ?? ''}</div></> },
        { head: 'Vendor', cell: (r) => r.vendor }, { head: 'Date', cell: (r) => fmtDate(r.bill_date) },
        { head: 'Total', className: 'right', cell: (r) => money(r.total) },
        { head: 'Status', cell: (r) => <Badge v={r.status} /> },
        { head: 'Zoho', cell: (r) => r.status === 'draft' ? '—' : <Badge v={r.sync_status} /> },
      ]} />
    </div>
  );
}
