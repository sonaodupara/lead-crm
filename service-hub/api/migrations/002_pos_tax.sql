-- Zoho POS keeps two tax records per item: GST (intra-state, a tax group) and IGST (inter-state).
-- The app keeps one `tax_id` for the on-screen preview (rates match) and remembers both Zoho ids so each
-- invoice line can carry the right one for the customer's place of supply.
alter table items add column zoho_tax_intra text, add column zoho_tax_inter text;
alter table tax_rates add column tax_specification text;   -- 'intra' | 'inter' | null (as reported by Zoho)
