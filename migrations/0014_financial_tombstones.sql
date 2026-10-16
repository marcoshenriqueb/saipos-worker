-- Deletion propagation for financial transactions (additive only).
-- Design: docs/2026-10-16-deletion-propagation-design.md
--
-- A daily full sweep of the Saipos API (by `date`) marks rows that are no
-- longer returned: first complete miss -> missing_since (strike 1); a later
-- complete miss -> deleted_at_source (strike 2, tombstone). A row seen again
-- (by the sweep or by the regular 2-min passes) clears both fields.

alter table financial_transactions_raw
  add column if not exists last_swept_at timestamptz,
  add column if not exists missing_since timestamptz,
  add column if not exists deleted_at_source timestamptz;

-- CONTRACT: the Mise app reads financial_transactions.deleted_at_source.
-- Do not rename.
alter table financial_transactions
  add column if not exists deleted_at_source timestamptz null;

create index if not exists ix_financial_transactions_deleted_at_source
  on financial_transactions (deleted_at_source)
  where deleted_at_source is not null;

create index if not exists ix_financial_transactions_raw_missing
  on financial_transactions_raw (missing_since)
  where missing_since is not null;

create table if not exists financial_sweeps (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  mode text not null,                         -- dry_run | apply
  status text not null default 'running',     -- running | complete | aborted | failed
  forced boolean not null default false,      -- circuit breaker overridden (--force)
  range_start timestamptz,
  range_end timestamptz,
  windows_total integer not null default 0,
  windows_ok integer not null default 0,
  windows_failed integer not null default 0,
  rows_seen integer not null default 0,       -- distinct rows returned by the API
  rows_new integer not null default 0,        -- seen in the API, absent from the mirror
  rows_in_range integer not null default 0,   -- live mirror rows in the candidate range
  candidates integer not null default 0,      -- live mirror rows in range NOT seen
  marked_missing integer not null default 0,  -- strike 1 (missing_since set)
  tombstoned integer not null default 0,      -- strike 2 (deleted_at_source set)
  cleared integer not null default 0,         -- seen again: missing_since/deleted_at_source cleared
  breaker_limit integer,
  abort_reason text,
  sample jsonb                                -- small sample of candidate keys (for review)
);

create index if not exists ix_financial_sweeps_started_at
  on financial_sweeps (started_at desc);
