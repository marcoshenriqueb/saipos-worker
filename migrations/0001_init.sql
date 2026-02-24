-- 0001_init.sql
-- Baseline schema for Saipos ingestion (Data API + events/webhook queue)
-- Values stored as numeric to match previous schema; can migrate to integer cents later if desired.

-- =============
-- Raw: sales/orders payloads (source of truth)
-- =============
create table if not exists orders_raw (
  id bigserial primary key,
  provider text not null default 'saipos',
  store_id text not null,
  order_id text not null,
  status text,
  received_at timestamptz not null default now(),
  payload jsonb not null,

  normalized boolean not null default false,
  normalized_at timestamptz,

  attempts integer not null default 0,
  last_error text,
  next_retry_at timestamptz,
  processing_started_at timestamptz
);

create unique index if not exists ux_orders_raw
  on orders_raw (provider, store_id, order_id);

create index if not exists ix_orders_raw_normalize_pick
  on orders_raw (normalized, received_at)
  where normalized = false;

create index if not exists ix_orders_raw_retry
  on orders_raw (normalized, next_retry_at);

create index if not exists ix_orders_raw_not_normalized
  on orders_raw (id)
  where normalized = false;

-- =============
-- Customers (only create if has phone OR cpf/cnpj OR email)
-- =============
create table if not exists customers (
  id bigserial primary key,
  provider text not null,

  external_id text,          -- customer.id_customer (if provided)
  name text,
  email text,
  birth_date date,
  phone text,
  document_number text,      -- cpf_cnpj

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customers_not_all_null check (
    coalesce(
      nullif(trim(name), ''),
      nullif(trim(email), ''),
      nullif(trim(phone), ''),
      nullif(trim(document_number), '')
    ) is not null
  )
);

-- Uniques (partial where makes it safe for null/empty)
create unique index if not exists ux_customers_provider_external
  on customers (provider, external_id)
  where external_id is not null and external_id <> '';

create unique index if not exists ux_customers_provider_email
  on customers (provider, email)
  where email is not null and email <> '';

create unique index if not exists ux_customers_provider_phone
  on customers (provider, phone)
  where phone is not null and phone <> '';

create unique index if not exists ux_customers_provider_document
  on customers (provider, document_number)
  where document_number is not null and document_number <> '';

-- =============
-- Orders (normalized)
-- =============
create table if not exists orders (
  id bigserial primary key,
  provider text not null default 'saipos',
  store_id text not null,
  order_id text not null,                -- id_sale (Saipos)

  sale_type_id integer,                  -- id_sale_type (1..4)
  shift_date date,                       -- shift_date (filter by "ontem" in Saipos logic)

  created_at_source timestamptz,         -- created_at from Saipos
  updated_at_source timestamptz,         -- updated_at from Saipos

  sale_number text,                      -- delivery sale_number (optional)
  desc_sale text,                        -- free text for table/ticket
  canceled boolean,                      -- canceled: Y/N -> boolean
  canceled_items_count integer,          -- count_canceled_items

  notes text,
  discount_reason text,
  increase_reason text,

  total_amount numeric,
  total_discount numeric,
  total_increase numeric,
  total_amount_items numeric,

  items_count integer,

  customer_id bigint references customers(id),
  customer_name text,                    -- fallback when customer is not identifiable

  received_at timestamptz not null default now(), -- when we ingested/normalized
  created_at timestamptz not null default now(),  -- local row timestamp
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_orders
  on orders (provider, store_id, order_id);

create index if not exists ix_orders_dates
  on orders (store_id, shift_date, created_at_source);

create index if not exists ix_orders_status
  on orders (store_id, canceled);

create index if not exists ix_orders_customer
  on orders (customer_id);

-- =============
-- Delivery (only for sale_type_id = 1) - 1:1 with order
-- =============
create table if not exists order_deliveries (
  id bigserial primary key,
  order_row_id bigint not null references orders(id) on delete cascade,

  delivery_fee numeric,
  delivery_time text,
  delivery_by text, -- MERCHANT|PARTNER

  state text,
  city text,
  district text,
  street text,
  number text,
  complement text,
  reference text,
  zipcode text,

  raw_delivery jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_order_deliveries_order
  on order_deliveries (order_row_id);

-- =============
-- Payments (array) - N:1 with order
-- =============
create table if not exists order_payments (
  id bigserial primary key,
  order_row_id bigint not null references orders(id) on delete cascade,

  idx integer not null, -- position in payments array
  payment_amount numeric,
  change_for numeric,
  created_at_source timestamptz,
  payment_type text, -- desc_store_payment_type

  raw_payment jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_order_payments_order_idx
  on order_payments (order_row_id, idx);

create index if not exists ix_order_payments_order
  on order_payments (order_row_id);

-- =============
-- Items - N:1 with order
-- =============
create table if not exists order_items (
  id bigserial primary key,
  provider text not null default 'saipos',
  store_id text not null,
  order_id text not null,

  line integer not null, -- 1..N in the order
  name text,
  integration_code text,
  quantity numeric,
  unit_price numeric,
  deleted text, -- "Y"/"N" if Saipos returns it; keep as text to avoid mismatch
  raw_item jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_order_items
  on order_items (provider, store_id, order_id, line);

create index if not exists ix_order_items_order
  on order_items (store_id, order_id);

-- =============
-- Item choices/add-ons - N:1 with item
-- =============
create table if not exists order_item_choices (
  id bigserial primary key,
  provider text not null default 'saipos',
  store_id text not null,
  order_id text not null,
  item_line integer not null,     -- matches order_items.line
  choice_line integer not null,   -- 1..N within the item

  name text,
  quantity numeric,
  unit_price numeric,
  raw_choice jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_order_item_choices
  on order_item_choices (provider, store_id, order_id, item_line, choice_line);

create index if not exists ix_order_item_choices_order
  on order_item_choices (store_id, order_id, item_line);