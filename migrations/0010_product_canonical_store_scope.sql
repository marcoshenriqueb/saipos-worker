-- Scope canonical mappings/suggestions by store to avoid cross-store collisions.

alter table if exists product_canonical_overrides
  add column if not exists store_id text;

update product_canonical_overrides
set store_id = '__legacy__'
where store_id is null;

alter table if exists product_canonical_overrides
  alter column store_id set not null;

do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'product_canonical_overrides'::regclass
      and contype = 'p'
  loop
    execute format(
      'alter table product_canonical_overrides drop constraint %I',
      c.conname
    );
  end loop;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'product_canonical_overrides'::regclass
      and contype = 'p'
  ) then
    alter table product_canonical_overrides
      add primary key (store_id, source_type, source_key);
  end if;
end $$;

alter table if exists product_alias_suggestions
  add column if not exists store_id text;

update product_alias_suggestions
set store_id = '__legacy__'
where store_id is null;

alter table if exists product_alias_suggestions
  alter column store_id set not null;

do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'product_alias_suggestions'::regclass
      and contype = 'u'
  loop
    execute format(
      'alter table product_alias_suggestions drop constraint %I',
      c.conname
    );
  end loop;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'product_alias_suggestions'::regclass
      and conname = 'ux_product_alias_suggestions_store_source_name'
  ) then
    alter table product_alias_suggestions
      add constraint ux_product_alias_suggestions_store_source_name
      unique (store_id, source_type, source_key, suggested_canonical_name);
  end if;
end $$;

drop index if exists ix_product_alias_suggestions_source;

create index if not exists ix_product_alias_suggestions_source
  on product_alias_suggestions (store_id, source_type, source_key, created_at desc);
