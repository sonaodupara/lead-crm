import { lazy, Suspense } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useAuth, type Role } from './auth';
import { flush, useAutoSync, useOnline, useQueue, discardFailed } from './offline';
import { fmtDateTime } from './ui';

const page = (f: () => Promise<{ default: React.ComponentType }>) => lazy(f);
const P = {
  Login: page(() => import('./pages/Login')), Dashboard: page(() => import('./pages/Dashboard')),
  Lookup: page(() => import('./pages/Lookup')), Stock: page(() => import('./pages/Stock')),
  Warranties: page(() => import('./pages/Warranties')), Templates: page(() => import('./pages/WarrantyTemplates')),
  Bills: page(() => import('./pages/Bills')), BillEdit: page(() => import('./pages/BillEdit')),
  Invoices: page(() => import('./pages/Invoices')), InvoiceEdit: page(() => import('./pages/InvoiceEdit')),
  Jobs: page(() => import('./pages/Jobs')), JobDetail: page(() => import('./pages/JobDetail')),
  Amc: page(() => import('./pages/Amc')), AmcDetail: page(() => import('./pages/AmcDetail')),
  Zoho: page(() => import('./pages/ZohoStatus')), Admin: page(() => import('./pages/Admin')),
  TechJobs: page(() => import('./pages/TechJobs')), TechJob: page(() => import('./pages/TechJob')),
};

interface NavItem { to: string; label: string; roles: Role[] }
const ALL: Role[] = ['owner', 'supervisor', 'accountant', 'sales'];
const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', roles: ALL },
  { to: '/lookup', label: 'Find unit', roles: [...ALL, 'technician'] },
  { to: '/jobs', label: 'Service jobs', roles: ['owner', 'supervisor', 'accountant'] },
  { to: '/stock', label: 'Stock & items', roles: ALL },
  { to: '/warranties', label: 'Warranties', roles: ['owner', 'supervisor', 'accountant', 'sales'] },
  { to: '/amc', label: 'AMC contracts', roles: ['owner', 'supervisor', 'accountant'] },
  { to: '/invoices', label: 'Invoices', roles: ['owner', 'accountant', 'supervisor', 'sales'] },
  { to: '/bills', label: 'Purchase bills', roles: ['owner', 'accountant', 'supervisor'] },
  { to: '/templates', label: 'Warranty terms', roles: ['owner', 'supervisor'] },
  { to: '/zoho', label: 'Zoho sync', roles: ['owner', 'accountant'] },
  { to: '/admin', label: 'People & settings', roles: ['owner', 'supervisor', 'accountant', 'sales'] },
];
const TECH_NAV = [{ to: '/tech', label: 'My jobs' }, { to: '/lookup', label: 'Find unit' }];

function SyncBanner() {
  const online = useOnline();
  const { pending, failed } = useQueue();
  const last = localStorage.getItem('sh_last_sync');
  if (failed.length) return (
    <div className="banner failed"><span>{failed.length} change(s) were rejected by the server: {(failed[0] as any).failed}</span><button className="btn small" onClick={() => void discardFailed()}>Dismiss</button></div>);
  if (!online) return <div className="banner offline"><span>Offline — your work is saved on this phone{pending ? ` (${pending} waiting to sync)` : ''}</span></div>;
  if (pending) return <div className="banner pending"><span>{pending} change(s) waiting to sync</span><button className="btn small" onClick={() => void flush()}>Sync now</button></div>;
  return last ? <div className="banner" style={{ justifyContent: 'center', fontWeight: 400 }}><span className="muted small">Synced {fmtDateTime(last)}</span></div> : null;
}

export default function App() {
  const { user, loading, logout } = useAuth();
  useAutoSync(user?.role === 'technician' || user?.role === 'supervisor');

  if (loading) return <div className="login muted">Loading…</div>;
  if (!user) return <Suspense fallback={null}><Routes><Route path="*" element={<P.Login />} /></Routes></Suspense>;

  const tech = user.role === 'technician';
  const items = tech ? TECH_NAV : NAV.filter((n) => n.roles.includes(user.role));
  const link = (n: { to: string; label: string }) => <NavLink key={n.to} to={n.to} end={n.to === '/'}>{n.label}</NavLink>;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Service Hub</div>
        {items.map(link)}
        <div className="who"><div><strong>{user.name}</strong></div><div className="muted">{user.role}</div><button className="btn small" style={{ marginTop: 8 }} onClick={logout}>Sign out</button></div>
      </aside>
      <div>
        <div className="topbar"><strong style={{ color: 'var(--brand)' }}>Service Hub</strong><span className="row"><span className="muted small">{user.name}</span><button className="btn small" onClick={logout}>Sign out</button></span></div>
        <SyncBanner />
        <main className="main">
          <Suspense fallback={<div className="muted">Loading…</div>}>
            <Routes>
              {tech ? (
                <>
                  <Route path="/tech" element={<P.TechJobs />} />
                  <Route path="/tech/job/:id" element={<P.TechJob />} />
                  <Route path="/lookup" element={<P.Lookup />} />
                  <Route path="*" element={<Navigate to="/tech" replace />} />
                </>
              ) : (
                <>
                  <Route path="/" element={<P.Dashboard />} />
                  <Route path="/lookup" element={<P.Lookup />} />
                  <Route path="/stock" element={<P.Stock />} />
                  <Route path="/warranties" element={<P.Warranties />} />
                  <Route path="/templates" element={<P.Templates />} />
                  <Route path="/bills" element={<P.Bills />} />
                  <Route path="/bills/:id" element={<P.BillEdit />} />
                  <Route path="/invoices" element={<P.Invoices />} />
                  <Route path="/invoices/:id" element={<P.InvoiceEdit />} />
                  <Route path="/jobs" element={<P.Jobs />} />
                  <Route path="/jobs/:id" element={<P.JobDetail />} />
                  <Route path="/amc" element={<P.Amc />} />
                  <Route path="/amc/:id" element={<P.AmcDetail />} />
                  <Route path="/zoho" element={<P.Zoho />} />
                  <Route path="/admin" element={<P.Admin />} />
                  {user.role === 'supervisor' && <Route path="/tech" element={<P.TechJobs />} />}
                  {user.role === 'supervisor' && <Route path="/tech/job/:id" element={<P.TechJob />} />}
                  <Route path="*" element={<Navigate to="/" replace />} />
                </>
              )}
            </Routes>
          </Suspense>
        </main>
      </div>
      <nav className="tabs">{items.slice(0, tech ? 2 : 5).map(link)}{!tech && <NavLink to="/admin">More</NavLink>}</nav>
    </div>
  );
}
