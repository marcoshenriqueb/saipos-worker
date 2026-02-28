-- Rollback of product canonical analysis support tables.
-- Keeps migration history append-only and safely removes unused structures.

drop table if exists product_alias_suggestions;
drop table if exists product_canonical_overrides;
drop table if exists daily_product_analysis;
