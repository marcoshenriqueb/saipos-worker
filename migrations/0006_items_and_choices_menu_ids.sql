alter table order_items
  add column if not exists id_store_item text;

create index if not exists ix_order_items_id_store_item
  on order_items (id_store_item);

alter table order_item_choices
  add column if not exists id_store_choice_item text;

create index if not exists ix_order_item_choices_id_store_choice_item
  on order_item_choices (id_store_choice_item);

-- Backfill best-effort from raw payload for historical rows
update order_items
set id_store_item = raw_item->>'id_store_item'
where id_store_item is null
  and raw_item ? 'id_store_item';

update order_item_choices
set
  id_store_choice_item = coalesce(id_store_choice_item, raw_choice->>'id_store_choice_item'),
  name = coalesce(name, raw_choice->>'desc_sale_item_choice'),
  unit_price = coalesce(
    unit_price,
    nullif(raw_choice->>'aditional_price', '')::numeric,
    nullif(raw_choice->>'additional_price', '')::numeric
  ),
  quantity = coalesce(
    quantity,
    nullif(raw_choice->>'quantity', '')::numeric,
    1
  )
where
  (id_store_choice_item is null and raw_choice ? 'id_store_choice_item')
  or (name is null and raw_choice ? 'desc_sale_item_choice')
  or (unit_price is null and (raw_choice ? 'aditional_price' or raw_choice ? 'additional_price'))
  or quantity is null;
