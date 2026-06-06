export default function StatsBar({ stats }) {
  const cards = [
    { label: 'Total Leads', value: stats.total, color: 'bg-blue-600' },
    { label: 'New', value: stats.newLeads, color: 'bg-purple-600' },
    { label: 'Contacted', value: stats.contacted, color: 'bg-yellow-500' },
    { label: 'Qualified', value: stats.qualified, color: 'bg-indigo-600' },
    { label: 'Converted', value: stats.converted, color: 'bg-green-600' },
    { label: 'Lost', value: stats.lost, color: 'bg-red-600' },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
      {cards.map((card) => (
        <div key={card.label} className={`${card.color} text-white rounded-lg p-4 text-center`}>
          <div className="text-2xl font-bold">{card.value ?? 0}</div>
          <div className="text-sm mt-1">{card.label}</div>
        </div>
      ))}
    </div>
  );
}