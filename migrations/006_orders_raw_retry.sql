-- orders_raw: retry/backoff support for normalizer

alter table orders_raw
  add column if not exists attempts int not null default 0,
  add column if not exists last_error text,
  add column if not exists next_retry_at timestamptz,
  add column if not exists processing_started_at timestamptz;

create index if not exists ix_orders_raw_retry
  on orders_raw (normalized, next_retry_at);