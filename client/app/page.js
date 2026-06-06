'use client';
import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, RefreshCw } from 'lucide-react';
import StatsBar from '@/components/StatsBar';
import LeadModal from '@/components/LeadModal';
import LeadTable from '@/components/LeadTable';
import { getLeads, getStats, createLead, updateLead, deleteLead } from '@/lib/api';

const STATUS_FILTERS = ['All', 'New', 'Contacted', 'Qualified', 'Converted', 'Lost'];

export default function Home() {
  const [leads, setLeads] = useState([]);
  const [stats, setStats] = useState({});
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortOrder, setSortOrder] = useState('desc');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editLead, setEditLead] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getLeads({ search, status: statusFilter, sortBy, sortOrder, page, limit: 10 });
      setLeads(res.data.leads);
      setTotalPages(res.data.totalPages);
    } catch (err) {
      console.error('Failed to fetch leads:', err);
    }
    setLoading(false);
  }, [search, statusFilter, sortBy, sortOrder, page]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await getStats();
      setStats(res.data);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  }, []);

  useEffect(() => {
    fetchLeads();
    fetchStats();
  }, [fetchLeads, fetchStats]);

  const handleSort = (field) => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('asc');
    }
    setPage(1);
  };

  const handleSubmit = async (formData) => {
    try {
      if (editLead) {
        await updateLead(editLead._id, formData);
      } else {
        await createLead(formData);
      }
      setModalOpen(false);
      setEditLead(null);
      fetchLeads();
      fetchStats();
    } catch (err) {
      console.error('Failed to save lead:', err);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this lead?')) return;
    try {
      await deleteLead(id);
      fetchLeads();
      fetchStats();
    } catch (err) {
      console.error('Failed to delete lead:', err);
    }
  };

  const handleEdit = (lead) => {
    setEditLead(lead);
    setModalOpen(true);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50">
      <div className="max-w-7xl mx-auto px-4 py-8">

        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Lead Management</h1>
            <p className="text-gray-500 text-sm mt-1">Track and manage your sales pipeline</p>
          </div>
          <button
            onClick={() => { setEditLead(null); setModalOpen(true); }}
            className="flex items-center gap-2 bg-blue-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all"
          >
            <Plus size={16} />
            Add Lead
          </button>
        </div>

        <StatsBar stats={stats} />

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 mb-4">
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search by name, email or company..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => { setStatusFilter(s); setPage(1); }}
                  className={`px-4 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                    statusFilter === s
                      ? 'bg-blue-600 text-white shadow-md shadow-blue-200'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100 border border-gray-200'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <button
              onClick={() => { fetchLeads(); fetchStats(); }}
              className="p-2.5 border border-gray-200 rounded-xl hover:bg-gray-50 text-gray-500 transition-colors"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          {loading ? (
            <div className="text-center py-16 text-gray-400 text-sm">Loading leads...</div>
          ) : (
            <LeadTable
              leads={leads}
              onEdit={handleEdit}
              onDelete={handleDelete}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          )}
        </div>
      </div>

      <LeadModal
        isOpen={modalOpen}
        onClose={() => { setModalOpen(false); setEditLead(null); }}
        onSubmit={handleSubmit}
        lead={editLead}
      />
    </div>
  );
}