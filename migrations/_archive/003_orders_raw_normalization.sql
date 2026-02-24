-- =====================================
-- ADD NORMALIZATION CONTROL TO RAW
-- =====================================

alter table orders_raw
add column if not exists normalized boolean not null default false;

alter table orders_raw
add column if not exists normalized_at timestamptz;



-- =====================================
-- PERFORMANCE INDEX
-- =====================================

create index if not exists ix_orders_raw_not_normalized
on orders_raw(id)
where normalized = false;