import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

/** GET with caching. Pass null to skip. */
export function useGet<T = any>(path: string | null) {
  return useQuery<T>({ queryKey: [path], queryFn: () => api.get<T>(path!), enabled: Boolean(path) });
}
export function useInvalidate() {
  const qc = useQueryClient();
  return (prefix?: string) => qc.invalidateQueries({ predicate: (q) => !prefix || String(q.queryKey[0]).startsWith(prefix) });
}
export const useTaxes = () => useGet<{ id: string; name: string; percentage: number }[]>('/api/taxes');

/** Same rounding rules as the server (integer paise) so previews match what is saved. */
export function lineTotals(l: { qty: number; rate: number; discount_pct?: number; tax_pct?: number }) {
  const gross = Math.round(l.qty * l.rate * 100);
  const net = gross - Math.round(gross * ((l.discount_pct ?? 0) / 100));
  const tax = Math.round(net * ((l.tax_pct ?? 0) / 100));
  return { net: net / 100, tax: tax / 100 };
}
export function docTotals(lines: { qty: number; rate: number; discount_pct?: number; tax_pct?: number }[]) {
  let net = 0, tax = 0;
  for (const l of lines) { const t = lineTotals(l); net += Math.round(t.net * 100); tax += Math.round(t.tax * 100); }
  return { subtotal: net / 100, tax: tax / 100, total: (net + tax) / 100 };
}
