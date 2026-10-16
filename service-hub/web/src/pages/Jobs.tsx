import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useGet, useInvalidate } from '../hooks';
import { Badge, Combo, Field, fetchers, fmtDateTime, Modal, PageHead, Table, useAction, type Option } from '../ui';

export default function Jobs() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState('');
  const [tech, setTech] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const techs = useGet<any[]>('/api/technicians');
  const list = useGet<any[]>(`/api/jobs${qs({ open: open && !status, status, assigned_to: tech, q })}`);
  const canCreate = user && ['owner', 'supervisor', 'accountant'].includes(user.role);
  return (
    <div className="stack">
      <PageHead title="Service jobs">{canCreate && <button className="btn primary" onClick={() => setCreating(true)}>New job</button>}</PageHead>
      <div className="row">
        <div className="grow"><input placeholder="Search customer, job or serial" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select style={{ width: 160 }} value={status} onChange={(e) => { setStatus(e.target.value); setOpen(false); }}>
          <option value="">{open ? 'Open jobs' : 'All jobs'}</option>
          {['new', 'scheduled', 'in_progress', 'on_hold', 'completed', 'invoiced', 'closed', 'cancelled'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select>
        <select style={{ width: 160 }} value={tech} onChange={(e) => setTech(e.target.value)}><option value="">All technicians</option>{techs.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
      </div>
      <Table rows={list.data} onRow={(r) => nav(`/jobs/${r.id}`)} empty="No jobs match." cols={[
        { head: 'Job', cell: (r) => <><strong>{r.number}</strong><div className="muted small">{r.kind.replace(/_/g, ' ')}</div></> },
        { head: 'Customer', cell: (r) => <>{r.customer}<div className="muted small">{r.item_name ? `${r.item_name} · ${r.serial_no}` : ''}</div></> },
        { head: 'Technician', cell: (r) => r.technician ?? <span className="muted">Unassigned</span> },
        { head: 'Scheduled', cell: (r) => fmtDateTime(r.scheduled_start) },
        { head: 'Coverage', cell: (r) => r.coverage ? <Badge v={r.coverage} /> : '—' },
        { head: 'Status', cell: (r) => <span className="row"><Badge v={r.status} />{r.priority !== 'normal' && <Badge v={r.priority} />}{r.sla_breached && <Badge v="failed" label="past SLA" />}</span> },
      ]} />
      {creating && <NewJob onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewJob({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const { run, busy } = useAction();
  const inval = useInvalidate();
  const techs = useGet<any[]>('/api/technicians');
  const [customer, setCustomer] = useState<Option | null>(null);
  const [serial, setSerial] = useState<Option | null>(null);
  const [f, setF] = useState({ kind: 'repair', priority: 'normal', problem: '', site_address: '', contact_name: '', contact_phone: '', assigned_to: '', scheduled_start: '' });
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const pickSerial = (o: Option | null) => {
    setSerial(o);
    if (o?.data?.customer && !customer) setCustomer({ id: o.data.customer_id ?? '', label: o.data.customer });
  };
  const create = async () => {
    const body: any = { kind: f.kind, priority: f.priority, problem: f.problem || null, site_address: f.site_address || null, contact_name: f.contact_name || null, contact_phone: f.contact_phone || null,
      serial_id: serial?.id ?? null, assigned_to: f.assigned_to || null, scheduled_start: f.scheduled_start ? new Date(f.scheduled_start).toISOString() : null };
    if (customer?.id) body.customer_id = customer.id;
    const r = await run(() => api.post('/api/jobs', body), 'Job created');
    if (r) { inval('/api/jobs'); nav(`/jobs/${r.id}`); }
  };
  return (
    <Modal title="New service job" onClose={onClose}>
      <div className="stack">
        <Field label="Unit (serial number)" hint="Pick the unit and the customer, warranty and coverage are filled in for you"><Combo value={serial} onChange={pickSerial} fetcher={fetchers.serials} placeholder="Type at least 2 characters of the serial" /></Field>
        <Field label="Customer"><Combo value={customer} onChange={setCustomer} fetcher={fetchers.customers} /></Field>
        <div className="grid">
          <Field label="Type"><select value={f.kind} onChange={(e) => set('kind', e.target.value)}>{['repair', 'warranty_claim', 'installation', 'inspection'].map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</select></Field>
          <Field label="Priority"><select value={f.priority} onChange={(e) => set('priority', e.target.value)}>{['low', 'normal', 'high', 'urgent'].map((k) => <option key={k}>{k}</option>)}</select></Field>
          <Field label="Assign to"><select value={f.assigned_to} onChange={(e) => set('assigned_to', e.target.value)}><option value="">— later —</option>{techs.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <Field label="Visit date & time"><input type="datetime-local" value={f.scheduled_start} onChange={(e) => set('scheduled_start', e.target.value)} /></Field>
        </div>
        <Field label="Problem"><textarea value={f.problem} onChange={(e) => set('problem', e.target.value)} /></Field>
        <Field label="Site address"><textarea value={f.site_address} onChange={(e) => set('site_address', e.target.value)} /></Field>
        <div className="grid"><Field label="Contact person"><input value={f.contact_name} onChange={(e) => set('contact_name', e.target.value)} /></Field><Field label="Contact phone"><input value={f.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} /></Field></div>
        <button className="btn primary" disabled={busy || (!customer && !serial)} onClick={create}>Create job</button>
      </div>
    </Modal>
  );
}
