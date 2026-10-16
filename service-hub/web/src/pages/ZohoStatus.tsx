import { api } from '../api';
import { useGet, useInvalidate } from '../hooks';
import { Badge, Card, fmtDateTime, PageHead, Table, useAction } from '../ui';

export default function ZohoStatus() {
  const q = useGet<any>('/api/zoho/status');
  const inval = useInvalidate();
  const { run, busy } = useAction();
  const d = q.data;
  const count = (s: string) => d?.outbox.find((o: any) => o.status === s)?.n ?? 0;
  return (
    <div className="stack">
      <PageHead title="Zoho sync"><button className="btn primary" disabled={busy || !d?.enabled} onClick={async () => { await run(() => api.post('/api/zoho/sync'), 'Sync finished'); inval('/api/zoho'); }}>Sync now</button></PageHead>
      {d && !d.enabled && <Card><strong>Zoho is not connected on this server.</strong><p className="muted" style={{ marginBottom: 0 }}>Invoices and bills are saved here and stay “not synced” until the Zoho credentials are added (see docs/ZOHO.md).</p></Card>}
      {d && <>
        <div className="tiles">
          <div className="tile"><div className="n">{count('pending')}</div><div className="muted small">Waiting to send</div></div>
          <div className={`tile ${count('failed') ? 'alert' : ''}`}><div className="n">{count('failed')}</div><div className="muted small">Failed — need attention</div></div>
          <div className="tile"><div className="n">{count('done')}</div><div className="muted small">Sent to Zoho</div></div>
        </div>
        <Card title="Last pull from Zoho">
          <Table rows={d.state.map((s: any) => ({ ...s, id: s.entity }))} empty="Nothing pulled yet." cols={[
            { head: 'Data', cell: (s) => s.entity.replace('_', ' ') }, { head: 'Last synced', cell: (s) => fmtDateTime(s.last_synced_at) },
            { head: 'Status', cell: (s) => s.last_error ? <span className="bad">{s.last_error}</span> : <Badge v="synced" label="ok" /> }]} />
        </Card>
        <Card title="Failed items">
          <Table rows={d.failures} empty="No failures." cols={[
            { head: 'What', cell: (f) => f.entity_type.replace('_', ' ') }, { head: 'Error', cell: (f) => <span className="bad">{f.last_error}</span> },
            { head: 'Tries', cell: (f) => f.attempts }, { head: '', cell: (f) => <button className="btn small" onClick={async () => { await run(() => api.post(`/api/zoho/outbox/${f.id}/retry`), 'Queued again'); inval('/api/zoho'); }}>Retry</button> }]} />
          <p className="muted small" style={{ marginBottom: 0 }}>Most failures mean a customer, vendor or item is not linked to Zoho yet. Fix the record, then press Retry.</p>
        </Card>
      </>}
    </div>
  );
}
