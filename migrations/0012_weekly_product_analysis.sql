-- Weekly AI analysis snapshots for BI/Metabase consumption.

create table if not exists weekly_product_analysis (
  id bigserial primary key,
  store_id text not null,
  period_start date not null,
  period_end date not null,
  model text,
  payload jsonb not null,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_product_analysis_period_check
    check (period_end >= period_start),
  constraint weekly_product_analysis_store_period_uniq
    unique (store_id, period_start, period_end)
);

create index if not exists ix_weekly_product_analysis_store_generated
  on weekly_product_analysis (store_id, generated_at desc);

create index if not exists ix_weekly_product_analysis_payload_gin
  on weekly_product_analysis
  using gin (payload);
