import { useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getPosition, newId, queueOp, queueUpload, resizeImage, useQueue, useTechData } from '../offline';
import { SignaturePad, type SignatureHandle } from '../SignaturePad';
import { Badge, Card, Empty, Field, fmtDate, useToast } from '../ui';

export default function TechJob() {
  const { id } = useParams();
  const { jobs, catalogue, loading } = useTechData();
  const { uploads } = useQueue();
  const toast = useToast();
  const job = jobs.find((j) => j.id === id);
  const [partQ, setPartQ] = useState('');
  const [partQty, setPartQty] = useState('1');
  const [note, setNote] = useState('');
  const [resolution, setResolution] = useState('');
  const [minutes, setMinutes] = useState('');
  const [signer, setSigner] = useState('');
  const sig = useRef<SignatureHandle>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [finishing, setFinishing] = useState(false);

  const matches = useMemo(() => {
    const q = partQ.trim().toLowerCase();
    return q.length < 2 ? [] : catalogue.filter((c) => c.name.toLowerCase().includes(q) || c.sku.toLowerCase().includes(q)).slice(0, 8);
  }, [partQ, catalogue]);

  if (loading && !job) return <div className="muted">Loading…</div>;
  if (!job) return <Empty text="This job is not on this phone. Go back and refresh when online." />;

  const completed = job.status === 'completed';
  const checkedIn = Boolean(job.checked_in_at);
  const w = job.warranty?.coverage;
  const myPhotos = uploads.filter((u) => u.owner_id === job.id && u.kind === 'photo').length;

  const checkIn = async () => { const pos = await getPosition(); await queueOp(job.id, { kind: 'checkin', ...pos }); toast('Checked in'); };
  const addPart = async (item: any) => {
    const qty = Number(partQty);
    if (!(qty > 0)) return toast('Enter a quantity', true);
    if (item.track_mode === 'serial') return toast('Serial-tracked units are issued by the store — ask the supervisor', true);
    await queueOp(job.id, { kind: 'add_part', item_id: item.id, qty, part_id: newId() });
    setPartQ(''); setPartQty('1'); toast(`${item.name} added`);
  };
  const addPhotos = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) await queueUpload({ owner_id: job.id, kind: 'photo', filename: f.name || 'photo.jpg', blob: await resizeImage(f) });
    if (photoInput.current) photoInput.current.value = '';
    toast('Photo saved');
  };
  const finish = async () => {
    if (resolution.trim().length < 3) return toast('Describe what was done', true);
    if ((!sig.current || sig.current.isEmpty()) && !window.confirm('The customer has not signed. Complete the job without a signature?')) return;
    setFinishing(true);
    try {
      let signature_client_id: string | undefined;
      if (sig.current && !sig.current.isEmpty()) {
        signature_client_id = await queueUpload({ owner_id: job.id, kind: 'signature', filename: 'signature.png', blob: await sig.current.toBlob() });
      }
      await queueOp(job.id, {
        kind: 'complete', resolution: resolution.trim(), ...(minutes ? { labour_minutes: Number(minutes) } : {}),
        ...(signer.trim() ? { signed_by_name: signer.trim() } : {}), ...(signature_client_id ? { signature_client_id } : {}),
      });
      toast('Job completed');
    } finally { setFinishing(false); }
  };

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Link to="/tech">← Jobs</Link>
        <span className="row">{job.pending && <Badge v="pending" label="not synced" />}<Badge v={job.status} /></span>
      </div>

      <Card>
        <h2>{job.number} · {job.kind.replace(/_/g, ' ')}</h2>
        <div><strong>{job.customer}</strong></div>
        <div className="row" style={{ marginTop: 6 }}>
          {job.customer_phone && <a className="btn" href={`tel:${job.customer_phone}`}>Call {job.customer_phone}</a>}
          {job.site_address && <a className="btn" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.site_address)}`}>Map</a>}
        </div>
        {job.site_address && <div className="muted small" style={{ marginTop: 6 }}>{job.site_address}</div>}
        {job.problem && <p style={{ marginBottom: 0 }}><strong>Problem:</strong> {job.problem}</p>}
      </Card>

      <Card title="Unit & warranty">
        {job.item_name ? <div>{job.item_name} · <strong>{job.serial_no}</strong></div> : <div className="muted">No unit linked to this job</div>}
        <div className="row" style={{ marginTop: 8 }}>
          <Badge v={job.coverage ?? 'out_of_warranty'} />
          {job.coverage === 'in_warranty' && w && <span className="small">Covered until {fmtDate(w.ends_on)} · {w.active.join(', ')}</span>}
          {job.coverage === 'out_of_warranty' && <span className="small">Chargeable — parts and labour are billed to the customer</span>}
          {job.coverage === 'amc' && <span className="small">Under AMC — no charge for this visit</span>}
          {job.coverage === 'goodwill' && <span className="small">Goodwill — no charge</span>}
        </div>
      </Card>

      {!completed && !checkedIn && <button className="btn primary big" onClick={checkIn}>Check in at site</button>}

      {job.checklist.length > 0 && (
        <Card title="Checklist">
          {job.checklist.map((c: any) => (
            <label key={c.id} className="check">
              <input type="checkbox" checked={c.done} disabled={completed} onChange={(e) => queueOp(job.id, { kind: 'checklist', item_id: c.id, done: e.target.checked })} />
              <span>{c.label}</span>
            </label>
          ))}
        </Card>
      )}

      <Card title="Parts used (from store)">
        {job.parts.length === 0 && <div className="muted small">Nothing used yet</div>}
        {job.parts.map((p: any) => (
          <div key={p.id} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
            <span>{p.item_name} × {p.qty}</span>
            <span className="row">{p.pending && <Badge v="pending" label="not synced" />}{p.chargeable ? <Badge v="out_of_warranty" label="billed" /> : <Badge v="in_warranty" label="no charge" />}</span>
          </div>
        ))}
        {!completed && (
          <div className="stack" style={{ marginTop: 10 }}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input placeholder="Search part name or code" value={partQ} onChange={(e) => setPartQ(e.target.value)} />
              <input style={{ width: 80 }} inputMode="decimal" value={partQty} onChange={(e) => setPartQty(e.target.value)} aria-label="Quantity" />
            </div>
            {matches.map((m) => (
              <button key={m.id} className="btn" style={{ textAlign: 'left' }} onClick={() => addPart(m)}>{m.name} <span className="muted small">{m.sku}{m.track_mode === 'serial' ? ' · serial' : ''}</span></button>
            ))}
          </div>
        )}
      </Card>

      <Card title="Photos">
        <div className="muted small" style={{ marginBottom: 6 }}>{myPhotos ? `${myPhotos} waiting to upload · ` : ''}{job.attachments?.length ?? 0} already uploaded</div>
        {!completed && <>
          <input ref={photoInput} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => addPhotos(e.target.files)} />
          <button className="btn" onClick={() => photoInput.current?.click()}>Take / add photo</button>
        </>}
      </Card>

      {!completed && (
        <Card title="Note">
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the supervisor" />
            <button className="btn" onClick={async () => { if (!note.trim()) return; await queueOp(job.id, { kind: 'note', text: note.trim() }); setNote(''); toast('Note saved'); }}>Add</button>
          </div>
        </Card>
      )}

      {completed ? (
        <Card title="Completed"><p style={{ margin: 0 }}>{job.resolution}</p></Card>
      ) : (
        <Card title="Finish job">
          <div className="stack">
            <Field label="What was done"><textarea value={resolution} onChange={(e) => setResolution(e.target.value)} /></Field>
            <Field label="Time spent (minutes)" hint="Leave blank to use check-in to now"><input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} /></Field>
            <Field label="Customer name"><input value={signer} onChange={(e) => setSigner(e.target.value)} /></Field>
            <Field label="Customer signature"><SignaturePad ref={sig} /></Field>
            <div className="row"><button className="btn small" onClick={() => sig.current?.clear()}>Clear signature</button></div>
            <button className="btn primary big" disabled={finishing || !checkedIn} onClick={finish}>{checkedIn ? 'Complete job' : 'Check in first'}</button>
          </div>
        </Card>
      )}
    </div>
  );
}
