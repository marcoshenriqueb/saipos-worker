alter table customers
add constraint customers_not_all_null
check (
  coalesce(
    nullif(trim(name), ''),
    nullif(trim(phone), ''),
    nullif(trim(document_number), '')
  ) is not null
);

create unique index if not exists ux_customers_provider_document
on customers (provider, document_number)
where document_number is not null and document_number <> '';