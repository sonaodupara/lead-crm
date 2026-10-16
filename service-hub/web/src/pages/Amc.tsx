import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api';
import { useGet, useInvalidate, useTaxes } from '../hooks';
import { Badge, Combo, Field, fetchers, fmtDate, Modal, money, PageHead, Table, todayStr, useAction, type Option } from '../ui';

export default function Amc() {
  const nav = useNavigate();
  const [status, setStatus] = useState('active');
  const [creating, setCreating] = useState(false);
  const list = useGet<any[]>(`/api/amc${qs({ status })}`);
  return (
    <div className="stack">
      <PageHead title="AMC contracts"><button className="btn primary" onClick={() => setCreating(true)}>New contract</button></PageHead>
      <div className="row">{['active', 'expired', 'cancelled', ''].map((s) => <button key={s} className={`btn small ${status === s ? 'primary' : ''}`} onClick={() => setStatus(s)}>{s || 'All'}</button>)}</div>
      <Table rows={list.data} onRow={(r) => nav(`/amc/${r.id}`)} empty="No contracts." cols={[
        { head: 'Contract', cell: (r) => <strong>{r.number}</strong> }, { head: 'Customer', cell: (r) => r.customer },
        { head: 'Billing', cell: (r) => r.billing_mode === 'annual' ? `Annual ${money(r.annual_amount)}` : `${money(r.per_visit_amount)} per visit` },
        { head: 'Term', cell: (r) => `${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}` }, { head: 'Units', cell: (r) => r.units },
        { head: 'Visits', cell: (r) => `${r.visits_done}/${r.visits_total}` }, { head: 'Status', cell: (r) => <Badge v={r.status} /> },
      ]} />
      {creating && <NewContract onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewContract({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const { run, busy } = useAction();
  const inval = useInvalidate();
  const taxes = useTaxes();
  const [customer, setCustomer] = useState<Option | null>(null);
  const [service, setService] = useState<Option | null>(null);
  const [units, setUnits] = useState<Option[]>([]);
  const [pick, setPick] = useState<Option | null>(null);
  const [f, setF] = useState({ billing_mode: 'annual', start_date: todayStr(), end_date: '', visits_per_year: '2', amount: '', tax_id: '', terms: '' });
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const create = async () => {
    const amt = Number(f.amount);
    const r = await run(() => api.post('/api/amc', { customer_id: customer!.id, billing_mode: f.billing_mode, start_date: f.start_date, end_date: f.end_date || undefined, visits_per_year: Number(f.visits_per_year),
      ...(f.billing_mode === 'annual' ? { annual_amount: amt } : { per_visit_amount: amt }), tax_id: f.tax_id || null, service_item_id: service?.id ?? null, serial_ids: units.map((u) => u.id), terms: f.terms || null }), 'Contract created');
    if (r) { inval('/api/amc'); nav(`/amc/${r.id}`); }
  };
  return (
    <Modal title="New AMC contract" onClose={onClose}>
      <div className="stack">
        <Field label="Customer"><Combo value={customer} onChange={setCustomer} fetcher={fetchers.customers} /></Field>
        <Field label="Covered units" hint="Add each unit by serial number">
          <Combo value={pick} onChange={(o) => { if (o) { setUnits((u) => u.some((x) => x.id === o.id) ? u : [...u, o]); setPick(null); } }} fetcher={fetchers.serials} placeholder="Type serial number" /></Field>
        <div className="row">{units.map((u) => <span key={u.id} className="badge info">{u.label} <a href="#" onClick={(e) => { e.preventDefault(); setUnits(units.filter((x) => x.id !== u.id)); }}>✕</a></span>)}</div>
        <div className="grid">
          <Field label="Billing"><select value={f.billing_mode} onChange={(e) => set('billing_mode', e.target.value)}><option value="annual">Annual (one invoice)</option><option value="per_visit">Per visit</option></select></Field>
          <Field label={f.billing_mode === 'annual' ? 'Annual amount (before tax)' : 'Amount per visit (before tax)'}><input inputMode="decimal" value={f.amount} onChange={(e) => set('amount', e.target.value)} /></Field>
          <Field label="Visits per year"><input inputMode="numeric" value={f.visits_per_year} onChange={(e) => set('visits_per_year', e.target.value)} /></Field>
          <Field label="Starts"><input type="date" value={f.start_date} onChange={(e) => set('start_date', e.target.value)} /></Field>
          <Field label="Ends" hint="Blank = one year"><input type="date" value={f.end_date} onChange={(e) => set('end_date', e.target.value)} /></Field>
          <Field label="Tax (Zoho)"><select value={f.tax_id} onChange={(e) => set('tax_id', e.target.value)}><option value="">—</option>{taxes.data?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.percentage}%)</option>)}</select></Field>
        </div>
        <Field label="Service item used on invoices" hint="A service item that exists in Zoho, e.g. “AMC service”"><Combo value={service} onChange={setService} fetcher={fetchers.items} /></Field>
        <Field label="Terms"><textarea value={f.terms} onChange={(e) => set('terms', e.target.value)} /></Field>
        <button className="btn primary" disabled={busy || !customer || !units.length || !Number(f.amount)} onClick={create}>Create contract</button>
      </div>
    </Modal>
  );
}
