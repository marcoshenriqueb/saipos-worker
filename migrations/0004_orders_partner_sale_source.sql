alter table orders
  add column if not exists partner_sale_source text;

create index if not exists ix_orders_partner_sale_source
  on orders (partner_sale_source);
