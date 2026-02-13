-- =========================
-- CUSTOMERS
-- =========================

create table if not exists customers (
  id bigserial primary key,
  provider text not null,
  external_id text,
  name text,
  phone text,
  document_number text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- evita duplicar cliente do mesmo provider
create unique index if not exists ux_customers_provider_external
on customers (provider, external_id);



-- =========================
-- ADDRESSES
-- =========================

create table if not exists addresses (
  id bigserial primary key,
  customer_id bigint references customers(id),

  street text,
  number text,
  district text,
  city text,
  state text,
  postal_code text,
  country text,

  raw_address jsonb,

  created_at timestamptz default now()
);

create index if not exists ix_addresses_customer
on addresses(customer_id);



-- =========================
-- ORDERS ALTER
-- =========================

alter table orders
add column if not exists customer_id bigint references customers(id);

alter table orders
add column if not exists address_id bigint references addresses(id);

alter table orders
add column if not exists order_mode text;



-- =========================
-- PERFORMANCE INDEX
-- =========================

create index if not exists ix_orders_customer
on orders(customer_id);