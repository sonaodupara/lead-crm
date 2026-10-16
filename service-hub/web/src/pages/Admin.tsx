import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useGet, useInvalidate } from '../hooks';
import { Badge, Card, Combo, Field, fetchers, Modal, PageHead, Table, useAction, type Option } from '../ui';

export default function Admin() {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';
  const canParty = user && ['owner', 'supervisor', 'accountant', 'sales'].includes(user.role);
  const [tab, setTab] = useState<'customers' | 'vendors' | 'users' | 'settings' | 'account'>('customers');
  const tabs = [...(canParty ? [['customers', 'Customers'], ['vendors', 'Vendors']] : []), ...(isOwner ? [['users', 'Users'], ['settings', 'Settings']] : []), ['account', 'My account']] as [typeof tab, string][];
  return (
    <div className="stack">
      <PageHead title="People & settings" />
      <div className="row">{tabs.map(([k, l]) => <button key={k} className={`btn small ${tab === k ? 'primary' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {(tab === 'customers' || tab === 'vendors') && <Parties kind={tab} />}
      {tab === 'users' && isOwner && <Users />}
      {tab === 'settings' && isOwner && <Settings />}
      {tab === 'account' && <Account />}
    </div>
  );
}

function Parties({ kind }: { kind: 'customers' | 'vendors' }) {
  const [q, setQ] = useState('');
  const list = useGet<any[]>(`/api/${kind}?q=${encodeURIComponent(q)}&limit=200`);
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="row"><div className="grow"><input placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} /></div><button className="btn primary" onClick={() => setOpen(true)}>Add</button></div>
      <Table rows={list.data} cols={[{ head: 'Name', cell: (r) => <strong>{r.name}</strong> }, { head: 'Phone', cell: (r) => r.phone ?? '—' }, { head: 'GSTIN', cell: (r) => r.gstin ?? '—' },
        { head: 'Zoho', cell: (r) => r.linked ? <Badge v="synced" label="linked" /> : <Badge v="pending" label="not linked" /> }]} />
      <p className="muted small">Customers and vendors are pulled from Zoho automatically. Add one here only if it is new, then create the same contact in Zoho so documents can sync.</p>
      {open && <PartyForm kind={kind} onClose={() => setOpen(false)} />}
    </>
  );
}
function PartyForm({ kind, onClose }: { kind: string; onClose: () => void }) {
  const [f, setF] = useState({ name: '', phone: '', email: '', gstin: '' });
  const { run, busy } = useAction(); const inval = useInvalidate();
  return (
    <Modal title={kind === 'customers' ? 'New customer' : 'New vendor'} onClose={onClose}>
      <div className="stack">
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="grid"><Field label="Phone"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field><Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="GSTIN"><input value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value })} /></Field></div>
        <button className="btn primary" disabled={busy || !f.name} onClick={async () => { if (await run(() => api.post(`/api/${kind}`, { name: f.name, phone: f.phone || null, email: f.email || null, gstin: f.gstin || null }), 'Saved')) { inval(`/api/${kind}`); onClose(); } }}>Save</button>
      </div>
    </Modal>
  );
}

function Users() {
  const list = useGet<any[]>('/api/users');
  const [open, setOpen] = useState(false);
  const inval = useInvalidate(); const { run } = useAction();
  return (
    <>
      <div className="row"><button className="btn primary" onClick={() => setOpen(true)}>Add user</button></div>
      <Table rows={list.data} cols={[{ head: 'Name', cell: (u) => <strong>{u.name}</strong> }, { head: 'Email', cell: (u) => u.email }, { head: 'Role', cell: (u) => <Badge v="info" label={u.role} /> },
        { head: '', cell: (u) => <button className="btn small" onClick={async () => { await run(() => api.patch(`/api/users/${u.id}`, { active: !u.active }), u.active ? 'Disabled' : 'Enabled'); inval('/api/users'); }}>{u.active ? 'Disable' : 'Enable'}</button> }]} />
      {open && <UserForm onClose={() => setOpen(false)} />}
    </>
  );
}
function UserForm({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', role: 'technician', password: '' });
  const { run, busy } = useAction(); const inval = useInvalidate();
  return (
    <Modal title="Add user" onClose={onClose}>
      <div className="stack"><div className="grid">
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Email (login)"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Phone"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Role"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{['technician', 'supervisor', 'accountant', 'sales', 'owner'].map((r) => <option key={r}>{r}</option>)}</select></Field>
        <Field label="Temporary password" hint="At least 8 characters"><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field></div>
        <button className="btn primary" disabled={busy || !f.name || !f.email || f.password.length < 8} onClick={async () => { if (await run(() => api.post('/api/users', { ...f, phone: f.phone || undefined }), 'User added')) { inval('/api/users'); onClose(); } }}>Add</button></div>
    </Modal>
  );
}

function Settings() {
  const s = useGet<any>('/api/settings');
  const { run, busy } = useAction(); const inval = useInvalidate();
  const [labour, setLabour] = useState<Option | null | undefined>(undefined);
  const [travel, setTravel] = useState<Option | null | undefined>(undefined);
  const [company, setCompany] = useState<string | undefined>(undefined);
  const cur = s.data?.job_billing ?? {};
  const itemOpt = (id?: string): Option | null => id ? { id, label: 'Selected item' } : null;
  return (
    <Card title="Billing items for service jobs">
      <p className="muted small" style={{ marginTop: 0 }}>Chargeable jobs add labour and travel to the invoice as these service items. Create them in Zoho first (type: service), then they appear after the next sync.</p>
      <div className="grid">
        <Field label="Labour item"><Combo value={labour === undefined ? itemOpt(cur.labour_item_id) : labour} onChange={setLabour} fetcher={fetchers.items} /></Field>
        <Field label="Travel item"><Combo value={travel === undefined ? itemOpt(cur.travel_item_id) : travel} onChange={setTravel} fetcher={fetchers.items} /></Field>
      </div>
      <div style={{ marginTop: 10 }}><button className="btn primary" disabled={busy} onClick={async () => {
        await run(() => api.put('/api/settings/job_billing', { labour_item_id: (labour === undefined ? cur.labour_item_id : labour?.id) ?? null, travel_item_id: (travel === undefined ? cur.travel_item_id : travel?.id) ?? null }), 'Saved'); inval('/api/settings'); }}>Save</button></div>
      <h3 style={{ marginTop: 20 }}>Company name on certificates</h3>
      <div className="row" style={{ flexWrap: 'nowrap' }}><input value={company ?? s.data?.company?.name ?? ''} onChange={(e) => setCompany(e.target.value)} />
        <button className="btn" disabled={busy || company === undefined} onClick={async () => { await run(() => api.put('/api/settings/company', { name: company }), 'Saved'); inval('/api/settings'); }}>Save</button></div>
    </Card>
  );
}

function Account() {
  const { user } = useAuth();
  const [cur, setCur] = useState(''); const [next, setNext] = useState('');
  const { run, busy } = useAction();
  return (
    <Card title={`Signed in as ${user?.name}`}>
      <div className="grid"><Field label="Current password"><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
        <Field label="New password (8+ characters)"><input type="password" value={next} onChange={(e) => setNext(e.target.value)} /></Field></div>
      <div style={{ marginTop: 10 }}><button className="btn" disabled={busy || next.length < 8} onClick={async () => { if (await run(() => api.post('/api/auth/password', { current: cur, next }), 'Password changed')) { setCur(''); setNext(''); } }}>Change password</button></div>
    </Card>
  );
}
