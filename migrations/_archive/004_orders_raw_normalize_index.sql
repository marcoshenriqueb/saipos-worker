create index if not exists ix_orders_raw_normalize_pick
on orders_raw (normalized, received_at)
where normalized = false;
