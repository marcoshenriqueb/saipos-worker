create table if not exists sale_status_histories (
  id bigserial primary key,
  provider text not null default 'saipos',

  id_sale_status_history text not null,
  store_id text not null,
  order_id text not null,

  status_name text not null,
  status_created_at_source timestamptz not null,

  received_at timestamptz not null default now(),
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_sale_status_histories_provider_external
  on sale_status_histories (provider, id_sale_status_history);

create index if not exists ix_sale_status_histories_order_time
  on sale_status_histories (provider, store_id, order_id, status_created_at_source);

create index if not exists ix_sale_status_histories_status_time
  on sale_status_histories (status_name, status_created_at_source);
