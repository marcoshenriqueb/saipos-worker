-- Backfill de lojas com base no orders_raw até 2025-01-01 (inclusive).
-- Fonte: payload JSON da venda (quando houver campos de loja).
-- Executar no banco "saipos".
-- Estratégia:
-- 1) filtra payloads históricos até a data de corte;
-- 2) escolhe o registro mais recente por loja no período;
-- 3) faz upsert em stores sem apagar dados já existentes.

with source_rows as (
  select
    r.provider,
    r.store_id,
    r.received_at,
    r.id,
    nullif(trim(coalesce(
      r.payload->>'desc_store',
      r.payload->>'store_name',
      r.payload->>'name_store',
      r.payload->>'store_trade_name',
      r.payload->>'fantasy_name'
    )), '') as name,
    nullif(trim(coalesce(
      r.payload->>'store_legal_name',
      r.payload->>'legal_name',
      r.payload->>'company_name'
    )), '') as legal_name,
    nullif(regexp_replace(coalesce(
      r.payload->>'store_document',
      r.payload->>'cnpj',
      r.payload->>'document_number'
    ), '\D', '', 'g'), '') as document_number,
    nullif(trim(coalesce(
      r.payload->>'store_email',
      r.payload->>'email_store',
      r.payload->>'email'
    )), '') as email,
    nullif(regexp_replace(coalesce(
      r.payload->>'store_phone',
      r.payload->>'phone_store',
      r.payload->>'phone'
    ), '\D', '', 'g'), '') as phone,
    nullif(trim(coalesce(
      r.payload->>'store_city',
      r.payload->>'city_store',
      r.payload->>'city'
    )), '') as city,
    nullif(trim(coalesce(
      r.payload->>'store_state',
      r.payload->>'state_store',
      r.payload->>'state'
    )), '') as state,
    nullif(trim(coalesce(
      r.payload->>'store_timezone',
      r.payload->>'timezone'
    )), '') as timezone
  from orders_raw r
  where
    (
      (r.payload ? 'shift_date')
      and (r.payload->>'shift_date') ~ '^\d{4}-\d{2}-\d{2}$'
      and (r.payload->>'shift_date')::date <= date '2025-01-01'
    )
    or
    (
      (r.payload ? 'created_at')
      and (r.payload->>'created_at') ~ '^\d{4}-\d{2}-\d{2}T'
      and (r.payload->>'created_at')::timestamptz < timestamptz '2025-01-02 00:00:00+00'
    )
),
base as (
  select distinct provider, store_id
  from source_rows
),
ranked as (
  select
    s.*,
    -- Prioriza a linha mais recente para representar cada loja.
    row_number() over (
      partition by s.provider, s.store_id
      order by s.received_at desc, s.id desc
    ) as rn
  from source_rows s
),
chosen as (
  select
    provider,
    store_id,
    name,
    legal_name,
    document_number,
    email,
    phone,
    city,
    state,
    timezone
  from ranked
  where rn = 1
)
insert into stores (
  provider,
  store_id,
  name,
  legal_name,
  document_number,
  email,
  phone,
  city,
  state,
  timezone,
  updated_at
)
select
  b.provider,
  b.store_id,
  c.name,
  c.legal_name,
  c.document_number,
  c.email,
  c.phone,
  c.city,
  c.state,
  c.timezone,
  now()
from base b
left join chosen c
  on c.provider = b.provider
 and c.store_id = b.store_id
on conflict (provider, store_id)
do update set
  name = coalesce(excluded.name, stores.name),
  legal_name = coalesce(excluded.legal_name, stores.legal_name),
  document_number = coalesce(excluded.document_number, stores.document_number),
  email = coalesce(excluded.email, stores.email),
  phone = coalesce(excluded.phone, stores.phone),
  city = coalesce(excluded.city, stores.city),
  state = coalesce(excluded.state, stores.state),
  timezone = coalesce(excluded.timezone, stores.timezone),
  updated_at = now();
