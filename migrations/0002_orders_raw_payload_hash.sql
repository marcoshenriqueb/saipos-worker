alter table orders_raw
  add column if not exists payload_hash text;

update orders_raw
set payload_hash = md5(payload::text)
where payload_hash is null;

alter table orders_raw
  alter column payload_hash set not null;
