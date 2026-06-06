'use client';
import { useState, useEffect } from 'react';
import { X } from 'lucide-react';

const STATUS_OPTIONS = ['New', 'Contacted', 'Qualified', 'Converted', 'Lost'];

const STATUS_COLORS = {
  New: 'bg-purple-50 text-purple-700 border-purple-200',
  Contacted: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  Qualified: 'bg-blue-50 text-blue-700 border-blue-200',
  Converted: 'bg-green-50 text-green-700 border-green-200',
  Lost: 'bg-red-50 text-red-700 border-red-200',
};

const emptyForm = {
  name: '', email: '', phone: '', company: '', status: 'New', notes: '',
};

export default function LeadModal({ isOpen, onClose, onSubmit, lead }) {
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    setForm(lead || emptyForm);
    setErrors({});
  }, [lead, isOpen]);

  const validate = () => {
    const e = {};
    if (!form.name.trim()) e.name = 'Name is required.';
    if (!form.email.trim()) e.email = 'Email is required.';
    if (!form.phone.trim()) e.phone = 'Phone is required.';
    if (!form.company.trim()) e.company = 'Company is required.';
    return e;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const e2 = validate();
    if (Object.keys(e2).length > 0) { setErrors(e2); return; }
    setLoading(true);
    await onSubmit(form);
    setLoading(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="text-xl font-bold text-gray-900">
              {lead ? 'Edit Lead' : 'Add New Lead'}
            </h2>
            <p className="text-sm text-gray-500 mt-0.5">
              {lead ? 'Update lead information' : 'Fill in the details below'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {[
                { label: 'Full Name', key: 'name', type: 'text', placeholder: 'Enter full name' },
                { label: 'Email Address', key: 'email', type: 'email', placeholder: 'Enter email address' },
                { label: 'Phone Number', key: 'phone', type: 'text', placeholder: 'Enter phone number' },
                { label: 'Company Name', key: 'company', type: 'text', placeholder: 'Enter company name' },
            ].map(({ label, key, type, placeholder }) => (
              <div key={key} className="col-span-2 sm:col-span-1">
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">{label}</label>
                <input
                  type={type}
                  value={form[key]}
                  placeholder={placeholder}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 hover:bg-white transition-colors"
                />
                {errors[key] && <p className="text-red-500 text-xs mt-1">{errors[key]}</p>}
              </div>
            ))}
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1.5">Lead Status</label>
            <div className="grid grid-cols-5 gap-2">
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setForm({ ...form, status: s })}
                  className={`px-2 py-2 rounded-xl text-xs font-semibold border transition-all ${
                    form.status === s
                      ? STATUS_COLORS[s] + ' ring-2 ring-offset-1 ring-blue-400'
                      : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1.5">Notes</label>
            <textarea
              value={form.notes}
              placeholder="Add any relevant notes about this lead..."
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={3}
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 hover:bg-white transition-colors resize-none"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-gray-200 text-gray-700 rounded-xl py-2.5 text-sm font-semibold hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-blue-600 text-white rounded-xl py-2.5 text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-sm"
            >
              {loading ? 'Saving...' : lead ? 'Update Lead' : 'Add Lead'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}