create table if not exists product_canonical_overrides (
  source_type text not null,
  source_key text not null,
  canonical_name text not null,
  updated_at timestamptz not null default now(),
  primary key (source_type, source_key),
  constraint product_canonical_overrides_source_type_check
    check (source_type in ('item', 'choice'))
);

create index if not exists ix_product_canonical_overrides_name
  on product_canonical_overrides (canonical_name);

create table if not exists product_alias_suggestions (
  id bigserial primary key,
  source_type text not null,
  source_key text not null,
  raw_name text,
  suggested_canonical_name text not null,
  confidence numeric not null,
  reason text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  constraint product_alias_suggestions_source_type_check
    check (source_type in ('item', 'choice')),
  constraint product_alias_suggestions_status_check
    check (status in ('pending', 'approved', 'rejected', 'auto_approved')),
  constraint product_alias_suggestions_confidence_check
    check (confidence >= 0 and confidence <= 1),
  unique (source_type, source_key, suggested_canonical_name)
);

create index if not exists ix_product_alias_suggestions_status
  on product_alias_suggestions (status, created_at desc);

create index if not exists ix_product_alias_suggestions_source
  on product_alias_suggestions (source_type, source_key, created_at desc);

create table if not exists daily_product_analysis (
  id bigserial primary key,
  analysis_date date not null,
  store_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (analysis_date, store_id)
);

create index if not exists ix_daily_product_analysis_store_date
  on daily_product_analysis (store_id, analysis_date desc);
