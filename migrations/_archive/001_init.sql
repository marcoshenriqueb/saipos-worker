-- 001_init.sql
-- Base schema for Saipos ingestion + normalized tables for BI
-- Run with: psql "$DATABASE_URL" -f migrations/001_init.sql

-- ========== inbox queue ==========
create table if not exists events_inbox (
  id bigserial primary key,
  provider text not null default 'saipos',
  store_id text not null,
  order_id text not null,
  event text not null,                    -- ex: CONFIRMED
  status text not null default 'pending', -- pending|processing|done|error|dead
  attempts int not null default 0,

  received_at timestamptz not null default now(),
  processing_started_at timestamptz,
  next_retry_at timestamptz,

  last_error text,
  raw_event jsonb
);

create unique index if not exists ux_events_inbox_dedupe
  on events_inbox (provider, store_id, order_id, event);

create index if not exists ix_events_inbox_queue
  on events_inbox (status, next_retry_at, received_at);

-- ========== raw orders ==========
create table if not exists orders_raw (
  id bigserial primary key,
  provider text not null default 'saipos',
  store_id text not null,
  order_id text not null,
  status text,
  received_at timestamptz not null default now(),
  payload jsonb not null
);

create unique index if not exists ux_orders_raw
  on orders_raw (provider, store_id, order_id);

-- ========== normalized for BI ==========
create table if not exists orders (
  id bigserial primary key,
  provider text not null default 'saipos',
  store_id text not null,
  order_id text not null,

  status text,

  created_at timestamptz,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  customer_name text,
  notes text,

  total_value numeric,
  total_items_value numeric,
  total_discount numeric,
  total_increase numeric,

  discount_reason text,
  increase_reason text,

  items_count int,

  constraint ux_orders unique (provider, store_id, order_id)
);

create index if not exists ix_orders_dates
  on orders (store_id, created_at);

create index if not exists ix_orders_status
  on orders (store_id, status);

create table if not exists order_items (
  id bigserial primary key,
  provider text not null default 'saipos',
  store_id text not null,
  order_id text not null,

  line int not null,           -- 1..n per order
  name text,
  integration_code text,
  quantity numeric,
  unit_price numeric,
  deleted text,

  raw_item jsonb,

  constraint ux_order_items unique (provider, store_id, order_id, line)
);

create index if not exists ix_order_items_order
  on order_items (store_id, order_id);
