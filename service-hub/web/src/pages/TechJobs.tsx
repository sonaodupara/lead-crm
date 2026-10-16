import { Link } from 'react-router-dom';
import { useTechData } from '../offline';
import { Badge, Empty, fmtDateTime, PageHead } from '../ui';

export default function TechJobs() {
  const { jobs, loading, stale, reload } = useTechData();
  const open = jobs.filter((j) => j.status !== 'completed');
  const done = jobs.filter((j) => j.status === 'completed');

  const card = (j: any) => (
    <Link key={j.id} to={`/tech/job/${j.id}`} className="card job-card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{j.number}</strong>
        <span className="row">{j.pending && <Badge v="pending" label="not synced" />}{j.priority !== 'normal' && <Badge v={j.priority} />}<Badge v={j.status} /></span>
      </div>
      <div style={{ marginTop: 4 }}>{j.customer}</div>
      <div className="muted small">{j.item_name ? `${j.item_name} · ${j.serial_no}` : j.kind.replace(/_/g, ' ')}</div>
      <div className="row small" style={{ marginTop: 6 }}>
        <Badge v={j.coverage ?? 'out_of_warranty'} />
        <span className="muted">{j.scheduled_start ? fmtDateTime(j.scheduled_start) : 'Not scheduled'}</span>
      </div>
      {j.problem && <div className="small" style={{ marginTop: 6 }}>{j.problem}</div>}
    </Link>
  );

  return (
    <div className="stack">
      <PageHead title="My jobs"><button className="btn small" onClick={() => void reload()}>Refresh</button></PageHead>
      {stale && <div className="muted small">Showing jobs saved on this phone. They will refresh when you are back online.</div>}
      {loading && !jobs.length && <div className="muted">Loading…</div>}
      {!loading && !jobs.length && <Empty text="No jobs assigned to you right now." />}
      {open.map(card)}
      {done.length > 0 && <><h3 className="muted">Completed recently</h3>{done.map(card)}</>}
    </div>
  );
}
