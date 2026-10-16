import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, openProtected, qs } from '../api';
import { useAuth } from '../auth';
import { useGet } from '../hooks';
import { Badge, Card, Empty, Field, fmtDate, Modal, PageHead, ScanInput, useAction } from '../ui';

export default function Lookup() {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const results = useGet<any[]>(submitted.length >= 2 ? `/api/serials/lookup${qs({ q: submitted })}` : null);
  const unit = useGet<any>(picked ? `/api/serials/${picked}` : null);
  const [jobOpen, setJobOpen] = useState(false);
  const canCreateJob = user && ['owner', 'supervisor', 'accountant', 'sales'].includes(user.role);

  const search = (v: string) => { setSubmitted(v.trim()); setPicked(null); };

  return (
    <div className="stack">
      <PageHead title="Find a unit" />
      <Card>
        <ScanInput value={q} onChange={setQ} onSubmit={search} placeholder="Scan or type a serial number" />
        <div style={{ marginTop: 10 }}><button className="btn primary" onClick={() => search(q)}>Search</button></div>
      </Card>

      {results.data && !picked && (
        results.data.length === 0 ? <Empty text="No unit found with that serial number." /> :
        results.data.map((s) => (
          <button key={s.id} className="card" style={{ textAlign: 'left', width: '100%', cursor: 'pointer' }} onClick={() => setPicked(s.id)}>
            <div className="row" style={{ justifyContent: 'space-between' }}><strong>{s.serial_no}</strong><Badge v={s.status} /></div>
            <div>{s.item_name}</div><div className="muted small">{s.customer ? `${s.customer} · ${s.customer_phone ?? ''}` : 'In stock'}</div>
          </button>
        ))
      )}

      {unit.data && picked && (() => {
        const { serial: s, warranties, jobs, contracts } = unit.data;
        const w = warranties[0];
        return (
          <>
            <Card title={s.serial_no} right={<Badge v={s.status} />}>
              <div><strong>{s.item_name}</strong> <span className="muted">({s.sku})</span></div>
              <div className="muted small">Customer: {s.customer ?? '—'} {s.customer_phone && `· ${s.customer_phone}`}</div>
              <div className="muted small">Invoice: {s.invoice_number ?? '—'} · Sold on {fmtDate(s.sold_on)} · Batch {s.batch_no ?? '—'} · Supplier {s.vendor_name ?? '—'}</div>
              {canCreateJob && s.customer && <div style={{ marginTop: 10 }}><button className="btn primary" onClick={() => setJobOpen(true)}>New service job</button></div>}
            </Card>

            <Card title="Warranty">
              {!w ? <div className="muted">No warranty on record for this unit.</div> : (
                <div className="stack">
                  <div className="row"><Badge v={w.coverage.in_warranty ? 'in_warranty' : 'out_of_warranty'} label={w.coverage.in_warranty ? 'In warranty' : 'Out of warranty'} />
                    {w.coverage.in_warranty && <span className="small">{w.coverage.days_left} days left</span>}</div>
                  <div className="small">Starts {fmtDate(w.start_date)} · parts to {fmtDate(w.parts_end)} · labour to {fmtDate(w.labour_end)} · on-site to {fmtDate(w.onsite_end)}</div>
                  {w.terms_snapshot?.terms_text && <div className="small muted">{w.terms_snapshot.terms_text}</div>}
                  <div><button className="btn small" onClick={() => void openProtected(`/api/warranties/${w.id}/certificate`)}>Open certificate</button></div>
                </div>
              )}
              {contracts.length > 0 && <div className="small" style={{ marginTop: 8 }}>AMC: {contracts.map((c: any) => `${c.number} (${c.status}, to ${fmtDate(c.end_date)})`).join(' · ')}</div>}
            </Card>

            <Card title="Service history">
              {jobs.length === 0 ? <div className="muted">No service visits yet.</div> : jobs.map((j: any) => (
                <div key={j.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}><strong>{j.number}</strong><span className="row"><Badge v={j.coverage ?? 'out_of_warranty'} /><Badge v={j.status} /></span></div>
                  <div className="small">{j.kind.replace(/_/g, ' ')} · {fmtDate(j.created_at)} {j.technician && `· ${j.technician}`}</div>
                  {j.problem && <div className="small muted">{j.problem}</div>}{j.resolution && <div className="small">→ {j.resolution}</div>}
                </div>
              ))}
            </Card>
            {jobOpen && <NewJobModal serialId={s.id} onClose={() => setJobOpen(false)} />}
          </>
        );
      })()}
    </div>
  );
}

function NewJobModal({ serialId, onClose }: { serialId: string; onClose: () => void }) {
  const nav = useNavigate();
  const { run, busy } = useAction();
  const [kind, setKind] = useState('repair');
  const [problem, setProblem] = useState('');
  const [priority, setPriority] = useState('normal');
  return (
    <Modal title="New service job" onClose={onClose}>
      <div className="stack">
        <Field label="Type"><select value={kind} onChange={(e) => setKind(e.target.value)}>
          {['repair', 'warranty_claim', 'installation', 'inspection'].map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}</select></Field>
        <Field label="Priority"><select value={priority} onChange={(e) => setPriority(e.target.value)}>{['low', 'normal', 'high', 'urgent'].map((k) => <option key={k}>{k}</option>)}</select></Field>
        <Field label="Problem reported"><textarea value={problem} onChange={(e) => setProblem(e.target.value)} /></Field>
        <button className="btn primary" disabled={busy} onClick={async () => {
          const r = await run(() => api.post('/api/jobs', { kind, serial_id: serialId, problem, priority }), 'Job created');
          if (r) nav(`/jobs/${r.id}`);
        }}>Create job</button>
      </div>
    </Modal>
  );
}
