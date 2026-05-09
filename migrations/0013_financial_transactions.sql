create table if not exists financial_transactions_raw (
  id bigserial primary key,
  provider text not null default 'saipos',
  store_id text not null,
  financial_transaction_id text not null,
  received_at timestamptz not null default now(),
  payload jsonb not null,
  payload_hash text,

  normalized boolean not null default false,
  normalized_at timestamptz,

  attempts integer not null default 0,
  last_error text,
  next_retry_at timestamptz,
  processing_started_at timestamptz
);

create unique index if not exists ux_financial_transactions_raw
  on financial_transactions_raw (provider, store_id, financial_transaction_id);

create index if not exists ix_financial_transactions_raw_normalize_pick
  on financial_transactions_raw (normalized, received_at)
  where normalized = false;

create index if not exists ix_financial_transactions_raw_retry
  on financial_transactions_raw (normalized, next_retry_at);

create table if not exists financial_transactions (
  id bigserial primary key,
  provider text not null default 'saipos',
  store_id text not null,
  financial_transaction_id text not null,

  date timestamptz,
  issuance_date timestamptz,
  payment_date timestamptz,
  created_at_source timestamptz,
  updated_at_source timestamptz,

  paid boolean,
  conciliated boolean,
  recurring boolean,

  installment integer,
  total_installments integer,

  amount numeric,
  notes text,
  provider_trade_name text,
  bank_account_desc text,
  payment_method_desc text,
  transaction_desc text,
  financial_category_desc text,
  children_count integer not null default 0,

  -- raw payload preservado em financial_transactions_raw.payload (single source of truth)

  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_financial_transactions
  on financial_transactions (provider, store_id, financial_transaction_id);

-- competência (regime de competência)
create index if not exists ix_financial_transactions_date
  on financial_transactions (store_id, date);

-- caixa (regime de caixa)
create index if not exists ix_financial_transactions_payment_date
  on financial_transactions (store_id, payment_date);

-- ingest incremental por updated_at
create index if not exists ix_financial_transactions_updated_at_source
  on financial_transactions (updated_at_source);

create index if not exists ix_financial_transactions_category
  on financial_transactions (store_id, financial_category_desc);

-- contas a pagar/receber em aberto: paid = false ou null
create index if not exists ix_financial_transactions_unpaid
  on financial_transactions (store_id, payment_date)
  where paid is not true;

create table if not exists financial_transaction_children (
  id bigserial primary key,
  financial_transaction_row_id bigint not null references financial_transactions(id) on delete cascade,
  idx integer not null,
  paid boolean,
  amount numeric,
  provider_trade_name text,
  transaction_desc text,
  financial_category_desc text,
  raw_child jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_financial_transaction_children_row_idx
  on financial_transaction_children (financial_transaction_row_id, idx);

create index if not exists ix_financial_transaction_children_row
  on financial_transaction_children (financial_transaction_row_id);
