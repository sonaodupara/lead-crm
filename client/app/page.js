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
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 py-8">

        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Lead Management CRM</h1>
            <p className="text-gray-500 text-sm mt-1">Manage and track your sales leads</p>
          </div>
          <button
            onClick={() => { setEditLead(null); setModalOpen(true); }}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
          >
            <Plus size={16} />
            Add Lead
          </button>
        </div>

        <StatsBar stats={stats} />

        <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search by name, email or company..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => { setStatusFilter(s); setPage(1); }}
                  className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                    statusFilter === s
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <button
              onClick={() => { fetchLeads(); fetchStats(); }}
              className="p-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-600"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-10 text-gray-400">Loading leads...</div>
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

      <LeadModal
        isOpen={modalOpen}
        onClose={() => { setModalOpen(false); setEditLead(null); }}
        onSubmit={handleSubmit}
        lead={editLead}
      />
    </div>
  );
}