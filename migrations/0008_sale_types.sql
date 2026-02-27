create table if not exists sale_types (
  id bigserial primary key,
  provider text not null default 'saipos',
  sale_type_id integer not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_sale_types_provider_id
  on sale_types (provider, sale_type_id);

create index if not exists ix_sale_types_name
  on sale_types (name);

-- Seed base conhecido da Saipos.
insert into sale_types (provider, sale_type_id, name)
values
  ('saipos', 1, 'Entrega'),
  ('saipos', 2, 'Retirada no balcão / Takeout'),
  ('saipos', 3, 'Salão (mesas e comandas)'),
  ('saipos', 4, 'Ficha / Senha')
on conflict (provider, sale_type_id)
do update set
  name = excluded.name,
  updated_at = now();
