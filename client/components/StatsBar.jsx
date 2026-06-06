import { Users, Sparkles, Phone, Target, Trophy, XCircle } from 'lucide-react';

const cards = [
  { label: 'Total Leads', key: 'total', bg: 'bg-gradient-to-br from-blue-500 to-blue-700', icon: Users },
  { label: 'New', key: 'newLeads', bg: 'bg-gradient-to-br from-purple-500 to-purple-700', icon: Sparkles },
  { label: 'Contacted', key: 'contacted', bg: 'bg-gradient-to-br from-amber-400 to-amber-600', icon: Phone },
  { label: 'Qualified', key: 'qualified', bg: 'bg-gradient-to-br from-indigo-500 to-indigo-700', icon: Target },
  { label: 'Converted', key: 'converted', bg: 'bg-gradient-to-br from-emerald-500 to-emerald-700', icon: Trophy },
  { label: 'Lost', key: 'lost', bg: 'bg-gradient-to-br from-red-500 to-red-700', icon: XCircle },
];

export default function StatsBar({ stats }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
      {cards.map(({ label, key, bg, icon: Icon }) => (
        <div key={label} className={`${bg} text-white rounded-2xl p-4 shadow-lg`}>
          <Icon size={20} className="mb-2 opacity-80" />
          <div className="text-3xl font-bold">{stats[key] ?? 0}</div>
          <div className="text-xs font-medium mt-1 text-white/80">{label}</div>
        </div>
      ))}
    </div>
  );
}