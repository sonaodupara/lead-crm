-- Service Hub: initial schema
-- Conventions: uuid primary keys, timestamptz everywhere, money as numeric(14,2),
-- quantities as numeric(14,3). Zoho remains the books of record for accounting
-- documents; this schema owns serial/batch/warranty/service data.

-- ───────────────────────── users & settings ─────────────────────────
create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  name          text not null,
  phone         text,
  role          text not null check (role in ('owner','supervisor','accountant','technician','sales')),
  password_hash text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create unique index users_email_uq on users (lower(email));

create table settings (
  key   text primary key,
  value jsonb not null
);

create table doc_counters (
  name     text primary key,
  next_val bigint not null default 1
);

create table audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor       uuid references users(id),
  action      text not null,
  entity_type text,
  entity_id   text,
  detail      jsonb
);
create index audit_log_entity_ix on audit_log (entity_type, entity_id);

-- ───────────────────────── masters (synced from Zoho) ─────────────────────────
create table tax_rates (
  id          uuid primary key default gen_random_uuid(),
  zoho_tax_id text unique,
  name        text not null,
  percentage  numeric(7,3) not null default 0,
  tax_type    text,
  active      boolean not null default true,
  raw         jsonb,
  synced_at   timestamptz
);

create table customers (
  id               uuid primary key default gen_random_uuid(),
  zoho_contact_id  text unique,
  name             text not null,
  phone            text,
  email            text,
  gstin            text,
  gst_treatment    text,
  place_of_supply  text,
  billing_address  jsonb,
  shipping_address jsonb,
  notes            text,
  synced_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index customers_name_ix on customers (lower(name));
create index customers_phone_ix on customers (phone);

create table vendors (
  id               uuid primary key default gen_random_uuid(),
  zoho_contact_id  text unique,
  name             text not null,
  phone            text,
  email            text,
  gstin            text,
  gst_treatment    text,
  place_of_supply  text,
  billing_address  jsonb,
  synced_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index vendors_name_ix on vendors (lower(name));

create table locations (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,
  kind             text not null default 'store' check (kind in ('store','van','site')),
  zoho_location_id text,
  active           boolean not null default true
);
insert into locations (name, kind) values ('Main Store', 'store');

-- ───────────────────────── warranty templates ─────────────────────────
create table warranty_templates (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  name              text not null,
  parts_months      int  not null default 0 check (parts_months >= 0),
  labour_months     int  not null default 0 check (labour_months >= 0),
  onsite_months     int  not null default 0 check (onsite_months >= 0),
  -- Warranty starts on the invoice date (business decision). Other triggers are
  -- modelled so the owner can change the rule per template later.
  start_trigger     text not null default 'invoice_date'
                    check (start_trigger in ('invoice_date','delivery_date','installation_date','manufacture_date')),
  coverage          jsonb not null default '[]'::jsonb,   -- e.g. ["parts","labour","onsite","pickup_drop"]
  exclusions        text,
  conditions        text,
  transferable      boolean not null default false,
  registration_days int check (registration_days is null or registration_days > 0),
  extendable        boolean not null default false,
  terms_text        text,   -- wording printed on invoice / certificate / Zoho custom field
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Fallback rules when an item has no direct template: category > brand > default
create table warranty_rules (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references warranty_templates(id) on delete cascade,
  scope       text not null check (scope in ('category','brand','default')),
  scope_value text,
  check ((scope = 'default') = (scope_value is null))
);
create unique index warranty_rules_scope_uq on warranty_rules (scope, coalesce(lower(scope_value), ''));

-- ───────────────────────── items, batches, serials ─────────────────────────
create table items (
  id                    uuid primary key default gen_random_uuid(),
  zoho_item_id          text unique,
  sku                   text not null unique,
  name                  text not null,
  brand                 text,
  category              text,
  hsn_code              text,
  unit                  text not null default 'nos',
  track_mode            text not null default 'none' check (track_mode in ('none','batch','serial')),
  rate                  numeric(14,2) not null default 0,
  purchase_rate         numeric(14,2) not null default 0,
  tax_id                uuid references tax_rates(id),
  reorder_level         numeric(14,3) not null default 0,
  warranty_template_id  uuid references warranty_templates(id),
  is_service            boolean not null default false,
  active                boolean not null default true,
  synced_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index items_name_ix on items (lower(name));

create table batches (
  id                    uuid primary key default gen_random_uuid(),
  item_id               uuid not null references items(id),
  batch_no              text not null,
  mfg_date              date,
  expiry_date           date,
  vendor_id             uuid references vendors(id),
  purchase_bill_id      uuid,           -- fk added below once bills exist
  cost                  numeric(14,2),
  warranty_template_id  uuid references warranty_templates(id),  -- batch-specific terms
  notes                 text,
  created_at            timestamptz not null default now(),
  unique (item_id, batch_no)
);

create table serial_units (
  id               uuid primary key default gen_random_uuid(),
  item_id          uuid not null references items(id),
  serial_no        text not null,
  batch_id         uuid references batches(id),
  status           text not null default 'in_stock'
                   check (status in ('in_stock','sold','returned','scrapped','in_service')),
  vendor_id        uuid references vendors(id),
  location_id      uuid references locations(id),
  customer_id      uuid references customers(id),
  sale_invoice_id  uuid,           -- fk added below
  sold_on          date,
  created_at       timestamptz not null default now(),
  unique (item_id, serial_no)
);
create index serial_units_serial_ix on serial_units (lower(serial_no));
create index serial_units_customer_ix on serial_units (customer_id);

-- Stock ledger: quantity on hand = sum(qty). Never updated, only appended.
create table stock_movements (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  item_id     uuid not null references items(id),
  batch_id    uuid references batches(id),
  serial_id   uuid references serial_units(id),
  location_id uuid not null references locations(id),
  qty         numeric(14,3) not null check (qty <> 0),
  kind        text not null check (kind in
              ('opening','purchase','sale','job_issue','job_return','adjustment','transfer_in','transfer_out','sale_return')),
  ref_type    text,
  ref_id      uuid,
  note        text,
  created_by  uuid references users(id)
);
create index stock_movements_item_ix on stock_movements (item_id, location_id);
create index stock_movements_batch_ix on stock_movements (batch_id);
create index stock_movements_ref_ix on stock_movements (ref_type, ref_id);

-- ───────────────────────── documents: purchase bills & sales invoices ─────────────────────────
create table purchase_bills (
  id              uuid primary key default gen_random_uuid(),
  number          text not null unique,          -- app reference, e.g. BILL-000001
  vendor_bill_no  text,                          -- number printed on the vendor's bill
  vendor_id       uuid not null references vendors(id),
  bill_date       date not null,
  due_date        date,
  place_of_supply text,
  gst_treatment   text,
  status          text not null default 'draft' check (status in ('draft','received','cancelled')),
  sync_status     text not null default 'not_synced' check (sync_status in ('not_synced','pending','synced','failed')),
  zoho_bill_id    text,
  zoho_status     text,
  subtotal        numeric(14,2) not null default 0,
  tax_total       numeric(14,2) not null default 0,
  total           numeric(14,2) not null default 0,
  zoho_total      numeric(14,2),
  notes           text,
  created_by      uuid references users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index purchase_bills_vendor_billno_uq
  on purchase_bills (vendor_id, lower(vendor_bill_no)) where vendor_bill_no is not null and status <> 'cancelled';

create table purchase_bill_lines (
  id           uuid primary key default gen_random_uuid(),
  bill_id      uuid not null references purchase_bills(id) on delete cascade,
  line_no      int  not null,
  item_id      uuid not null references items(id),
  description  text,
  qty          numeric(14,3) not null check (qty > 0),
  rate         numeric(14,2) not null check (rate >= 0),
  tax_id       uuid references tax_rates(id),
  amount       numeric(14,2) not null default 0,
  batch_no     text,
  mfg_date     date,
  expiry_date  date,
  serial_nos   text[] not null default '{}',
  location_id  uuid references locations(id),
  unique (bill_id, line_no)
);

create table sales_invoices (
  id                 uuid primary key default gen_random_uuid(),
  number             text not null unique,        -- app reference, e.g. INV-000001 (sent to Zoho as reference_number)
  customer_id        uuid not null references customers(id),
  invoice_date       date not null,                -- warranty start date
  due_date           date,
  place_of_supply    text,
  gst_treatment      text,
  status             text not null default 'draft' check (status in ('draft','confirmed','cancelled')),
  sync_status        text not null default 'not_synced' check (sync_status in ('not_synced','pending','synced','failed')),
  zoho_invoice_id    text,
  zoho_invoice_number text,
  zoho_status        text,
  source             text not null default 'manual' check (source in ('manual','service_job','amc')),
  subtotal           numeric(14,2) not null default 0,
  tax_total          numeric(14,2) not null default 0,
  total              numeric(14,2) not null default 0,
  zoho_total         numeric(14,2),
  notes              text,
  terms              text,
  created_by         uuid references users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index sales_invoices_customer_ix on sales_invoices (customer_id);

create table sales_invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references sales_invoices(id) on delete cascade,
  line_no       int  not null,
  item_id       uuid not null references items(id),
  description   text,
  qty           numeric(14,3) not null check (qty > 0),
  rate          numeric(14,2) not null check (rate >= 0),
  discount_pct  numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  tax_id        uuid references tax_rates(id),
  amount        numeric(14,2) not null default 0,    -- pre-tax, after discount
  batch_id      uuid references batches(id),
  serial_ids    uuid[] not null default '{}',
  location_id   uuid references locations(id),
  skip_stock    boolean not null default false,   -- stock already issued elsewhere (e.g. job card parts)
  unique (invoice_id, line_no)
);

alter table batches
  add constraint batches_purchase_bill_fk foreign key (purchase_bill_id) references purchase_bills(id);
alter table serial_units
  add constraint serial_units_sale_invoice_fk foreign key (sale_invoice_id) references sales_invoices(id);

create table attachments (
  id           uuid primary key default gen_random_uuid(),
  owner_type   text not null check (owner_type in ('purchase_bill','sales_invoice','service_job','warranty','amc_contract')),
  owner_id     uuid not null,
  kind         text not null default 'document' check (kind in ('document','photo','signature','bill_scan')),
  filename     text not null,
  mime         text not null,
  size_bytes   bigint not null,
  storage_path text not null,
  client_id    uuid unique,                -- idempotent offline uploads
  uploaded_by  uuid references users(id),
  created_at   timestamptz not null default now()
);
create index attachments_owner_ix on attachments (owner_type, owner_id);

-- ───────────────────────── warranties ─────────────────────────
create table warranties (
  id               uuid primary key default gen_random_uuid(),
  serial_id        uuid not null references serial_units(id),
  sale_invoice_id  uuid not null references sales_invoices(id),
  customer_id      uuid not null references customers(id),
  template_id      uuid references warranty_templates(id),
  terms_snapshot   jsonb not null,          -- frozen copy of the template at time of sale
  start_date       date not null,
  parts_end        date,
  labour_end       date,
  onsite_end       date,
  extended_months  int not null default 0,
  status           text not null default 'active' check (status in ('active','void')),
  void_reason      text,
  zoho_synced_at   timestamptz,
  created_at       timestamptz not null default now(),
  unique (serial_id, sale_invoice_id)
);
create index warranties_end_ix on warranties (parts_end);

create table warranty_extensions (
  id           uuid primary key default gen_random_uuid(),
  warranty_id  uuid not null references warranties(id) on delete cascade,
  months       int not null check (months > 0),
  price        numeric(14,2) not null default 0,
  invoice_id   uuid references sales_invoices(id),
  created_by   uuid references users(id),
  created_at   timestamptz not null default now()
);

-- ───────────────────────── AMC contracts ─────────────────────────
create table amc_contracts (
  id               uuid primary key default gen_random_uuid(),
  number           text not null unique,
  customer_id      uuid not null references customers(id),
  billing_mode     text not null check (billing_mode in ('per_visit','annual')),
  start_date       date not null,
  end_date         date not null check (end_date >= start_date),
  visits_per_year  int  not null default 2 check (visits_per_year > 0),
  annual_amount    numeric(14,2) not null default 0,
  per_visit_amount numeric(14,2) not null default 0,
  tax_id           uuid references tax_rates(id),
  service_item_id  uuid references items(id),     -- Zoho service item used on the invoice
  status           text not null default 'active' check (status in ('draft','active','expired','cancelled')),
  renewal_of       uuid references amc_contracts(id),
  annual_invoice_id uuid references sales_invoices(id),
  terms            text,
  created_at       timestamptz not null default now()
);

create table amc_contract_units (
  contract_id uuid not null references amc_contracts(id) on delete cascade,
  serial_id   uuid not null references serial_units(id),
  primary key (contract_id, serial_id)
);

-- ───────────────────────── field service ─────────────────────────
create table service_jobs (
  id                  uuid primary key default gen_random_uuid(),
  number              text not null unique,
  kind                text not null check (kind in ('installation','repair','amc_visit','inspection','warranty_claim')),
  status              text not null default 'new' check (status in
                      ('new','scheduled','in_progress','on_hold','completed','invoiced','closed','cancelled')),
  priority            text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  customer_id         uuid not null references customers(id),
  serial_id           uuid references serial_units(id),
  warranty_id         uuid references warranties(id),
  contract_id         uuid references amc_contracts(id),
  site_address        text,
  contact_name        text,
  contact_phone       text,
  problem             text,
  scheduled_start     timestamptz,
  scheduled_end       timestamptz,
  assigned_to         uuid references users(id),
  sla_due_at          timestamptz,
  -- coverage decision: system-suggested, supervisor may override with a reason
  coverage            text check (coverage in ('in_warranty','out_of_warranty','goodwill','amc')),
  coverage_suggested  text,
  coverage_override_reason text,
  coverage_set_by     uuid references users(id),
  checked_in_at       timestamptz,
  checkin_lat         numeric(9,6),
  checkin_lng         numeric(9,6),
  checked_out_at      timestamptz,
  resolution          text,
  labour_minutes      int not null default 0,
  labour_rate_per_hr  numeric(14,2) not null default 0,
  travel_charge       numeric(14,2) not null default 0,
  signed_by_name      text,
  signed_at           timestamptz,
  signature_attachment_id uuid references attachments(id),
  invoice_id          uuid references sales_invoices(id),
  vendor_recovery     boolean not null default false,   -- parts/cost to claim back from supplier
  created_by          uuid references users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index service_jobs_assigned_ix on service_jobs (assigned_to, status);
create index service_jobs_serial_ix on service_jobs (serial_id);

create table amc_visits (
  id          uuid primary key default gen_random_uuid(),
  contract_id uuid not null references amc_contracts(id) on delete cascade,
  due_date    date not null,
  status      text not null default 'scheduled' check (status in ('scheduled','done','skipped')),
  job_id      uuid references service_jobs(id),
  invoice_id  uuid references sales_invoices(id)
);
create index amc_visits_due_ix on amc_visits (due_date) where status = 'scheduled';

create table job_parts (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references service_jobs(id) on delete cascade,
  item_id       uuid not null references items(id),
  batch_id      uuid references batches(id),
  serial_id     uuid references serial_units(id),
  qty           numeric(14,3) not null check (qty > 0),
  unit_price    numeric(14,2) not null default 0,
  chargeable    boolean not null default true,
  location_id   uuid not null references locations(id),
  op_id         uuid unique,                -- idempotency key from offline client
  added_by      uuid references users(id),
  created_at    timestamptz not null default now()
);

create table job_events (
  id         bigserial primary key,
  job_id     uuid not null references service_jobs(id) on delete cascade,
  at         timestamptz not null default now(),
  actor      uuid references users(id),
  kind       text not null,
  payload    jsonb not null default '{}'::jsonb
);
create index job_events_job_ix on job_events (job_id, at);

create table job_checklist_items (
  id       uuid primary key default gen_random_uuid(),
  job_id   uuid not null references service_jobs(id) on delete cascade,
  label    text not null,
  done     boolean not null default false,
  done_at  timestamptz,
  sort     int not null default 0
);

create table checklist_templates (
  kind  text primary key,
  items jsonb not null default '[]'::jsonb
);
insert into checklist_templates (kind, items) values
  ('installation',   '["Unit unpacked and checked for damage","Serial number matches invoice","Installed and levelled / mounted","Power-on and functional test","Customer shown basic operation","Warranty terms explained"]'),
  ('repair',         '["Fault reproduced","Cause identified","Repair done","Functional test passed","Customer informed of cause"]'),
  ('warranty_claim', '["Serial number and warranty verified","Fault reproduced","Photos of fault / label taken","Repair or replacement done","Functional test passed"]'),
  ('amc_visit',      '["Visual inspection","Cleaning / servicing done","Performance check","Consumables checked","Report discussed with customer"]'),
  ('inspection',     '["Inspection completed","Findings recorded","Recommendation given"]');

-- ───────────────────────── offline sync & Zoho outbox ─────────────────────────
create table client_ops (
  op_id      uuid primary key,
  user_id    uuid not null references users(id),
  kind       text not null,
  applied_at timestamptz not null default now(),
  result     jsonb
);

create table zoho_outbox (
  id              bigserial primary key,
  entity_type     text not null check (entity_type in ('sales_invoice','purchase_bill','warranty','item_fields')),
  entity_id       uuid not null,
  action          text not null default 'upsert',
  idempotency_key text not null unique,
  status          text not null default 'pending' check (status in ('pending','processing','done','failed')),
  attempts        int  not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  done_at         timestamptz
);
create index zoho_outbox_due_ix on zoho_outbox (status, next_attempt_at);

create table zoho_sync_state (
  entity           text primary key,
  last_synced_at   timestamptz,
  last_error       text
);
