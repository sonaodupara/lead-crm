import { useState } from 'react';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useGet, useInvalidate } from '../hooks';
import { Badge, Field, fmtDate, Modal, PageHead, Table, useAction } from '../ui';

export default function Stock() {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const [low, setLow] = useState(false);
  const [tab, setTab] = useState<'stock' | 'batches'>('stock');
  const [item, setItem] = useState<any>(null);
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const rows = useGet<any[]>(`/api/stock${qs({ q, low })}`);
  const batches = useGet<any[]>(tab === 'batches' ? '/api/batches' : null);
  const canEdit = user && ['owner', 'supervisor', 'accountant'].includes(user.role);

  return (
    <div className="stack">
      <PageHead title="Stock & items">{canEdit && <button className="btn primary" onClick={() => setEditing('new')}>New item</button>}</PageHead>
      <div className="row">
        <button className={`btn ${tab === 'stock' ? 'primary' : ''}`} onClick={() => setTab('stock')}>Stock levels</button>
        <button className={`btn ${tab === 'batches' ? 'primary' : ''}`} onClick={() => setTab('batches')}>Batches & expiry</button>
      </div>
      {tab === 'stock' && <>
        <div className="row"><div className="grow"><input placeholder="Search item or code" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <label className="row"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Low stock only</label></div>
        <Table rows={rows.data} onRow={setItem} empty="No items match." cols={[
          { head: 'Item', cell: (r) => <><strong>{r.name}</strong><div className="muted small">{r.sku}{r.brand ? ` · ${r.brand}` : ''}</div></> },
          { head: 'Tracking', cell: (r) => <Badge v={r.track_mode === 'none' ? 'draft' : 'info'} label={r.track_mode} /> },
          { head: 'On hand', className: 'right', cell: (r) => <strong className={r.on_hand <= r.reorder_level && r.reorder_level > 0 ? 'bad' : ''}>{r.on_hand} {r.unit}</strong> },
          { head: 'Reorder at', className: 'right', cell: (r) => r.reorder_level || '—' },
          { head: 'Used (90d)', className: 'right', cell: (r) => r.used_90d },
        ]} />
      </>}
      {tab === 'batches' && (
        <Table rows={batches.data} empty="No batches recorded." cols={[
          { head: 'Item', cell: (r) => <><strong>{r.item_name}</strong><div className="muted small">{r.sku}</div></> },
          { head: 'Batch', cell: (r) => r.batch_no },
          { head: 'Expiry', cell: (r) => r.expiry_date ? <span className={r.expiry_date < new Date().toISOString().slice(0, 10) ? 'bad' : ''}>{fmtDate(r.expiry_date)}</span> : '—' },
          { head: 'Supplier', cell: (r) => r.vendor_name ?? '—' },
          { head: 'On hand', className: 'right', cell: (r) => r.on_hand },
        ]} />
      )}
      {item && <ItemModal item={item} canEdit={!!canEdit} onClose={() => setItem(null)} onEdit={() => { setEditing(item); setItem(null); }} />}
      {editing && <ItemForm item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ItemModal({ item, canEdit, onClose, onEdit }: { item: any; canEdit: boolean; onClose: () => void; onEdit: () => void }) {
  const breakdown = useGet<any[]>(`/api/items/${item.id}/stock`);
  const inval = useInvalidate();
  const { run, busy } = useAction();
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Modal title={item.name} onClose={onClose}>
      <div className="stack">
        <div className="muted small">{item.sku} · On hand {item.on_hand} {item.unit}</div>
        <Table rows={breakdown.data} empty="No stock movements yet." cols={[
          { head: 'Location', cell: (r) => r.location }, { head: 'Batch', cell: (r) => r.batch_no ?? '—' },
          { head: 'Expiry', cell: (r) => fmtDate(r.expiry_date) }, { head: 'Qty', className: 'right', cell: (r) => r.qty }]} />
        {canEdit && item.track_mode !== 'serial' && (
          <div className="card"><h3>Stock adjustment</h3>
            <div className="grid"><Field label="Quantity (+ add, − remove)"><input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
              <Field label="Reason (required)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
            <div style={{ marginTop: 10 }}><button className="btn" disabled={busy || !qty || reason.length < 3} onClick={async () => {
              if (await run(() => api.post('/api/stock/adjust', { item_id: item.id, qty: Number(qty), reason }), 'Stock adjusted')) { inval('/api/stock'); inval(`/api/items/${item.id}`); onClose(); }
            }}>Apply</button></div>
          </div>)}
        {canEdit && <div><button className="btn" onClick={onEdit}>Edit item</button></div>}
      </div>
    </Modal>
  );
}

function ItemForm({ item, onClose }: { item: any | null; onClose: () => void }) {
  const { run, busy } = useAction();
  const inval = useInvalidate();
  const taxes = useGet<any[]>('/api/taxes');
  const tpls = useGet<any[]>('/api/warranty-templates');
  const full = useGet<any>(item ? `/api/items/${item.id}` : null);
  const [f, setF] = useState<any>(null);
  const cur = f ?? (item ? full.data : { sku: '', name: '', brand: '', category: '', hsn_code: '', unit: 'nos', track_mode: 'none', rate: 0, purchase_rate: 0, reorder_level: 0, is_service: false, tax_id: null, warranty_template_id: null });
  if (!cur) return <Modal title="Item" onClose={onClose}>Loading…</Modal>;
  const set = (k: string, v: any) => setF({ ...cur, [k]: v });
  const save = async () => {
    const body = { sku: cur.sku, name: cur.name, brand: cur.brand || null, category: cur.category || null, hsn_code: cur.hsn_code || null, unit: cur.unit,
      track_mode: cur.track_mode, rate: Number(cur.rate), purchase_rate: Number(cur.purchase_rate), reorder_level: Number(cur.reorder_level),
      is_service: cur.is_service, tax_id: cur.tax_id || null, warranty_template_id: cur.warranty_template_id || null };
    const r = await run(() => item ? api.patch(`/api/items/${item.id}`, body) : api.post('/api/items', body), 'Item saved');
    if (r) { inval('/api/stock'); inval('/api/items'); onClose(); }
  };
  return (
    <Modal title={item ? 'Edit item' : 'New item'} onClose={onClose}>
      <div className="stack">
        <div className="grid">
          <Field label="Code (SKU)"><input value={cur.sku} disabled={!!item} onChange={(e) => set('sku', e.target.value)} /></Field>
          <Field label="Name"><input value={cur.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Brand"><input value={cur.brand ?? ''} onChange={(e) => set('brand', e.target.value)} /></Field>
          <Field label="Category"><input value={cur.category ?? ''} onChange={(e) => set('category', e.target.value)} /></Field>
          <Field label="HSN / SAC"><input value={cur.hsn_code ?? ''} onChange={(e) => set('hsn_code', e.target.value)} /></Field>
          <Field label="Unit"><input value={cur.unit} onChange={(e) => set('unit', e.target.value)} /></Field>
          <Field label="Selling rate"><input inputMode="decimal" value={cur.rate} onChange={(e) => set('rate', e.target.value)} /></Field>
          <Field label="Purchase rate"><input inputMode="decimal" value={cur.purchase_rate} onChange={(e) => set('purchase_rate', e.target.value)} /></Field>
          <Field label="Reorder level"><input inputMode="decimal" value={cur.reorder_level} onChange={(e) => set('reorder_level', e.target.value)} /></Field>
          <Field label="Tax (from Zoho)"><select value={cur.tax_id ?? ''} onChange={(e) => set('tax_id', e.target.value)}><option value="">— none —</option>
            {taxes.data?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.percentage}%)</option>)}</select></Field>
          <Field label="Tracking" hint="Cannot change after stock exists"><select value={cur.track_mode} onChange={(e) => set('track_mode', e.target.value)}>
            <option value="none">Quantity only</option><option value="batch">By batch</option><option value="serial">By serial number</option></select></Field>
          <Field label="Warranty terms"><select value={cur.warranty_template_id ?? ''} onChange={(e) => set('warranty_template_id', e.target.value)}><option value="">— none / use rules —</option>
            {tpls.data?.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
        </div>
        <label className="row"><input type="checkbox" checked={cur.is_service} onChange={(e) => set('is_service', e.target.checked)} /> Service item (no stock, e.g. labour)</label>
        <button className="btn primary" disabled={busy || !cur.sku || !cur.name} onClick={save}>Save</button>
      </div>
    </Modal>
  );
}
