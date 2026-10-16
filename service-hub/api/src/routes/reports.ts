import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { roles } from '../auth.js';

export default async function reports(app: FastifyInstance) {
  app.get('/api/dashboard', { preHandler: roles('supervisor', 'accountant', 'sales') }, async () => {
    const one = async (sql: string) => (await pool.query(sql)).rows[0].n as number;
    const [expiring30, expiring90, lowStock, expiringBatches, openJobs, slaBreached, unassigned, syncFailed, draftInvoices, amcVisitsDue, billsToSend] = await Promise.all([
      one(`select count(*)::int n from warranties where status='active' and greatest(parts_end,labour_end,onsite_end) between current_date and current_date+30`),
      one(`select count(*)::int n from warranties where status='active' and greatest(parts_end,labour_end,onsite_end) between current_date and current_date+90`),
      one(`select count(*)::int n from (select i.id from items i left join stock_movements m on m.item_id=i.id where i.active and not i.is_service and i.reorder_level>0
             group by i.id, i.reorder_level having coalesce(sum(m.qty),0) <= i.reorder_level) t`),
      one(`select count(*)::int n from batches b where b.expiry_date between current_date and current_date+60
             and coalesce((select sum(qty) from stock_movements m where m.batch_id=b.id),0) > 0`),
      one(`select count(*)::int n from service_jobs where status in ('new','scheduled','in_progress','on_hold')`),
      one(`select count(*)::int n from service_jobs where status in ('new','scheduled','in_progress','on_hold') and sla_due_at < now()`),
      one(`select count(*)::int n from service_jobs where status='new' and assigned_to is null`),
      one(`select (select count(*) from sales_invoices where sync_status='failed') + (select count(*) from purchase_bills where sync_status='failed') as n`),
      one(`select count(*)::int n from sales_invoices where status='draft'`),
      one(`select count(*)::int n from amc_visits v join amc_contracts k on k.id=v.contract_id where v.status='scheduled' and k.status='active' and v.due_date <= current_date+14`),
      one(`select count(*)::int n from purchase_bills where status='received' and sync_status='not_synced'`),
    ]);
    return { warranties_expiring_30d: expiring30, warranties_expiring_90d: expiring90, low_stock_items: lowStock,
      batches_expiring_60d: expiringBatches, open_jobs: openJobs, sla_breached: slaBreached, unassigned_jobs: unassigned,
      zoho_sync_failures: syncFailed, draft_invoices: draftInvoices, amc_visits_due_14d: amcVisitsDue, bills_to_send: billsToSend };
  });

  /** What warranty service is costing, by brand/item: parts at purchase cost on in-warranty jobs. */
  app.get('/api/reports/warranty-cost', { preHandler: roles('supervisor', 'accountant') }, async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(730).default(365) }).parse(req.query);
    return (await pool.query(
      `select coalesce(si.brand,'(no brand)') as brand, si.name as item_name, count(distinct j.id)::int as jobs,
              coalesce(sum(p.qty * ip.purchase_rate),0) as parts_cost, coalesce(sum(j.labour_minutes),0)::int as labour_minutes,
              count(distinct j.id) filter (where j.vendor_recovery)::int as vendor_recovery_jobs
         from service_jobs j join serial_units s on s.id=j.serial_id join items si on si.id=s.item_id
         left join job_parts p on p.job_id=j.id left join items ip on ip.id=p.item_id
        where j.coverage='in_warranty' and j.created_at >= now() - ($1 || ' days')::interval
        group by si.brand, si.name order by parts_cost desc limit 200`, [String(days)])).rows;
  });

  /** Repeat failures by batch — early warning for a bad lot. */
  app.get('/api/reports/batch-failures', { preHandler: roles('supervisor', 'accountant') }, async () =>
    (await pool.query(
      `select i.name as item_name, b.id as batch_id, b.batch_no, v.name as vendor,
              count(distinct s.id) filter (where s.status in ('sold','in_service'))::int as units_sold,
              count(distinct j.id)::int as jobs,
              round(100.0 * count(distinct s.id) filter (where j.id is not null) / nullif(count(distinct s.id) filter (where s.status in ('sold','in_service')),0), 1) as failure_rate_pct
         from batches b join items i on i.id=b.item_id left join vendors v on v.id=b.vendor_id
         join serial_units s on s.batch_id=b.id
         left join service_jobs j on j.serial_id=s.id and j.kind in ('repair','warranty_claim')
        group by i.name, b.id, b.batch_no, v.name having count(distinct j.id) > 0
        order by failure_rate_pct desc nulls last, jobs desc limit 100`)).rows);
}
