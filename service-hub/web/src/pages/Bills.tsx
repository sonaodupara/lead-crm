import { useNavigate, useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import { qs } from '../api';
import { useGet } from '../hooks';
import { Badge, fmtDate, money, PageHead, Table } from '../ui';

const ZOHO_LABEL: Record<string, string> = { not_synced: 'not sent', pending: 'queued', synced: 'in Zoho', failed: 'failed' };

export default function Bills() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const unsent = params.get('unsent') === '1';
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const list = useGet<any[]>(`/api/bills${qs({ q, status, unsent: unsent || undefined })}`);
  return (
    <div className="stack">
      <PageHead title="Purchase bills"><button className="btn primary" onClick={() => nav('/bills/new')}>Record a bill</button></PageHead>
      <div className="row"><div className="grow"><input placeholder="Search vendor, bill number" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="draft">Draft</option><option value="received">Received</option><option value="cancelled">Cancelled</option></select>
        <label className="row"><input type="checkbox" checked={unsent} onChange={(e) => setParams(e.target.checked ? { unsent: '1' } : {})} /> Waiting to send to Zoho</label></div>
      <Table rows={list.data} onRow={(r) => nav(`/bills/${r.id}`)} empty={unsent ? 'No bills are waiting to be sent to Zoho.' : 'No bills yet.'} cols={[
        { head: 'Bill', cell: (r) => <><strong>{r.number}</strong><div className="muted small">{r.vendor_bill_no ?? ''}</div></> },
        { head: 'Vendor', cell: (r) => r.vendor }, { head: 'Date', cell: (r) => fmtDate(r.bill_date) },
        { head: 'Total', className: 'right', cell: (r) => money(r.total) },
        { head: 'Status', cell: (r) => <Badge v={r.status} /> },
        { head: 'Zoho', cell: (r) => r.status === 'draft' || r.status === 'cancelled' ? '—' : <Badge v={r.sync_status} label={ZOHO_LABEL[r.sync_status] ?? r.sync_status} /> },
      ]} />
    </div>
  );
}
