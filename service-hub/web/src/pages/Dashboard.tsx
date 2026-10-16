import { Link } from 'react-router-dom';
import { useGet } from '../hooks';
import { PageHead } from '../ui';

export default function Dashboard() {
  const { data: d, isLoading, error } = useGet<any>('/api/dashboard');
  const tile = (to: string, n: number | undefined, label: string, tone = '') => (
    <Link to={to} className={`tile ${tone}`}><div className="n">{n ?? '–'}</div><div className="muted small">{label}</div></Link>
  );
  return (
    <div className="stack">
      <PageHead title="Dashboard" />
      {isLoading && <div className="muted">Loading…</div>}
      {error && <div className="card">Could not load the dashboard.</div>}
      {d && <>
        <h3 className="muted">Service</h3>
        <div className="tiles">
          {tile('/jobs', d.open_jobs, 'Open jobs')}
          {tile('/jobs', d.unassigned_jobs, 'Waiting to be assigned', d.unassigned_jobs ? 'warn' : '')}
          {tile('/jobs', d.sla_breached, 'Past SLA', d.sla_breached ? 'alert' : '')}
          {tile('/amc', d.amc_visits_due_14d, 'AMC visits due in 14 days')}
        </div>
        <h3 className="muted">Warranty & stock</h3>
        <div className="tiles">
          {tile('/warranties', d.warranties_expiring_30d, 'Warranties ending in 30 days', d.warranties_expiring_30d ? 'warn' : '')}
          {tile('/warranties', d.warranties_expiring_90d, 'Warranties ending in 90 days')}
          {tile('/stock', d.low_stock_items, 'Items at or below reorder level', d.low_stock_items ? 'warn' : '')}
          {tile('/stock', d.batches_expiring_60d, 'Batches expiring in 60 days', d.batches_expiring_60d ? 'warn' : '')}
        </div>
        <h3 className="muted">Accounts</h3>
        <div className="tiles">
          {tile('/invoices', d.draft_invoices, 'Draft invoices to confirm')}
          {tile('/zoho', d.zoho_sync_failures, 'Zoho sync failures', d.zoho_sync_failures ? 'alert' : '')}
        </div>
      </>}
    </div>
  );
}
