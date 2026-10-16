import { useState } from 'react';
import { api } from '../api';
import { useGet, useInvalidate } from '../hooks';
import { Badge, Card, Field, Modal, PageHead, Table, useAction } from '../ui';

const COVER = [['parts', 'Parts'], ['labour', 'Labour'], ['onsite', 'On-site visit'], ['pickup_drop', 'Pick-up & drop']] as const;
const blank = { code: '', name: '', parts_months: 12, labour_months: 12, onsite_months: 0, start_trigger: 'invoice_date', coverage: ['parts', 'labour'] as string[],
  exclusions: '', conditions: '', transferable: false, registration_days: '', extendable: true, terms_text: '', active: true };

export default function WarrantyTemplates() {
  const list = useGet<any[]>('/api/warranty-templates');
  const rules = useGet<any[]>('/api/warranty-rules');
  const [edit, setEdit] = useState<any | null>(null);
  const [ruleOpen, setRuleOpen] = useState(false);
  const inval = useInvalidate();
  return (
    <div className="stack">
      <PageHead title="Warranty terms"><button className="btn primary" onClick={() => setEdit({ ...blank })}>New terms</button></PageHead>
      <p className="muted" style={{ margin: 0 }}>Each set of terms can be attached to an item, a batch, or applied by rule. Terms are copied onto every warranty when it is issued, so changing them later never alters warranties already sold.</p>
      <Table rows={list.data} onRow={(r) => setEdit({ ...r, registration_days: r.registration_days ?? '' })} cols={[
        { head: 'Code', cell: (r) => <strong>{r.code}</strong> }, { head: 'Name', cell: (r) => r.name },
        { head: 'Parts', cell: (r) => `${r.parts_months}m` }, { head: 'Labour', cell: (r) => `${r.labour_months}m` }, { head: 'On-site', cell: (r) => `${r.onsite_months}m` },
        { head: 'Items', cell: (r) => r.items_using }, { head: '', cell: (r) => r.active ? null : <Badge v="void" label="inactive" /> },
      ]} />
      <Card title="Automatic rules" right={<button className="btn small" onClick={() => setRuleOpen(true)}>Add rule</button>}>
        <p className="muted small" style={{ marginTop: 0 }}>Used when an item has no terms of its own. Order: batch → item → category → brand → default. Without a rule, an item with no terms gets no warranty.</p>
        <Table rows={rules.data} empty="No rules — only items with their own terms get a warranty." cols={[
          { head: 'Applies to', cell: (r) => r.scope === 'default' ? 'Everything else' : `${r.scope}: ${r.scope_value}` }, { head: 'Terms', cell: (r) => `${r.code} — ${r.template_name}` },
          { head: '', cell: (r) => <button className="btn small danger" onClick={async (e) => { e.stopPropagation(); await api.del(`/api/warranty-rules/${r.id}`); inval('/api/warranty-rules'); }}>Remove</button> }]} />
      </Card>
      {edit && <Editor t={edit} onClose={() => setEdit(null)} />}
      {ruleOpen && <RuleModal templates={list.data ?? []} onClose={() => setRuleOpen(false)} />}
    </div>
  );
}

function Editor({ t, onClose }: { t: any; onClose: () => void }) {
  const [f, setF] = useState(t);
  const { run, busy } = useAction();
  const inval = useInvalidate();
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const num = (k: string) => <input inputMode="numeric" value={f[k]} onChange={(e) => set(k, e.target.value.replace(/\D/g, ''))} />;
  const save = async () => {
    const body = { code: f.code, name: f.name, parts_months: Number(f.parts_months) || 0, labour_months: Number(f.labour_months) || 0, onsite_months: Number(f.onsite_months) || 0,
      start_trigger: f.start_trigger, coverage: f.coverage, exclusions: f.exclusions || null, conditions: f.conditions || null, transferable: f.transferable,
      registration_days: f.registration_days ? Number(f.registration_days) : null, extendable: f.extendable, terms_text: f.terms_text || null, active: f.active };
    if (await run(() => f.id ? api.put(`/api/warranty-templates/${f.id}`, body) : api.post('/api/warranty-templates', body), 'Warranty terms saved')) { inval('/api/warranty-templates'); onClose(); }
  };
  return (
    <Modal title={f.id ? 'Edit warranty terms' : 'New warranty terms'} onClose={onClose}>
      <div className="stack">
        <div className="grid"><Field label="Code"><input value={f.code} onChange={(e) => set('code', e.target.value)} /></Field><Field label="Name"><input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field></div>
        <h3>Duration</h3>
        <div className="grid"><Field label="Parts (months)">{num('parts_months')}</Field><Field label="Labour (months)">{num('labour_months')}</Field><Field label="On-site service (months)">{num('onsite_months')}</Field></div>
        <Field label="Warranty starts on" hint="Your current policy is the invoice date."><select value={f.start_trigger} onChange={(e) => set('start_trigger', e.target.value)}>
          <option value="invoice_date">Invoice date</option><option value="delivery_date">Delivery date</option><option value="installation_date">Installation date</option><option value="manufacture_date">Manufacture date</option></select></Field>
        <div><div className="muted small" style={{ fontWeight: 600, marginBottom: 4 }}>Covers</div>
          <div className="row">{COVER.map(([k, l]) => <label key={k} className="row"><input type="checkbox" checked={f.coverage.includes(k)} onChange={(e) => set('coverage', e.target.checked ? [...f.coverage, k] : f.coverage.filter((x: string) => x !== k))} />{l}</label>)}</div></div>
        <Field label="Exclusions"><textarea value={f.exclusions ?? ''} onChange={(e) => set('exclusions', e.target.value)} placeholder="Misuse, power surge, unauthorised repair…" /></Field>
        <Field label="Conditions"><textarea value={f.conditions ?? ''} onChange={(e) => set('conditions', e.target.value)} placeholder="Original invoice required; serial label must be intact…" /></Field>
        <div className="grid">
          <Field label="Must be registered within (days)" hint="Leave blank if not required"><input inputMode="numeric" value={f.registration_days} onChange={(e) => set('registration_days', e.target.value.replace(/\D/g, ''))} /></Field>
          <div className="stack"><label className="row"><input type="checkbox" checked={f.transferable} onChange={(e) => set('transferable', e.target.checked)} />Transferable to a new owner</label>
            <label className="row"><input type="checkbox" checked={f.extendable} onChange={(e) => set('extendable', e.target.checked)} />Can be extended (paid extended warranty)</label>
            <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} />Active</label></div>
        </div>
        <Field label="Wording printed on the certificate and invoice" hint="Also written to the Zoho invoice's warranty terms field."><textarea value={f.terms_text ?? ''} onChange={(e) => set('terms_text', e.target.value)} /></Field>
        <button className="btn primary" disabled={busy || !f.code || !f.name} onClick={save}>Save</button>
      </div>
    </Modal>
  );
}

function RuleModal({ templates, onClose }: { templates: any[]; onClose: () => void }) {
  const [scope, setScope] = useState('category'); const [value, setValue] = useState(''); const [tid, setTid] = useState('');
  const { run, busy } = useAction(); const inval = useInvalidate();
  return (
    <Modal title="Add rule" onClose={onClose}>
      <div className="stack">
        <Field label="Applies to"><select value={scope} onChange={(e) => setScope(e.target.value)}><option value="category">An item category</option><option value="brand">A brand</option><option value="default">Everything else</option></select></Field>
        {scope !== 'default' && <Field label={scope === 'brand' ? 'Brand name' : 'Category name'}><input value={value} onChange={(e) => setValue(e.target.value)} /></Field>}
        <Field label="Warranty terms"><select value={tid} onChange={(e) => setTid(e.target.value)}><option value="">— choose —</option>{templates.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}</select></Field>
        <button className="btn primary" disabled={busy || !tid || (scope !== 'default' && !value)} onClick={async () => {
          if (await run(() => api.post('/api/warranty-rules', { scope, scope_value: scope === 'default' ? null : value, template_id: tid }), 'Rule saved')) { inval('/api/warranty-rules'); onClose(); }
        }}>Save rule</button>
      </div>
    </Modal>
  );
}
