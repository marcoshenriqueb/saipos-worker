create table if not exists stores (
  id bigserial primary key,
  provider text not null default 'saipos',
  store_id text not null,

  name text,
  legal_name text,
  document_number text,
  email text,
  phone text,
  city text,
  state text,
  timezone text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_stores_provider_store_id
  on stores (provider, store_id);

create index if not exists ix_stores_name
  on stores (name);
