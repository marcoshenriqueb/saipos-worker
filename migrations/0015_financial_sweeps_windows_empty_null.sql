-- Windows accepted as complete-and-empty because the Saipos Data API answered
-- `null` (instead of []) and the mirror has no rows dated in that window.
-- Additive only.
alter table financial_sweeps
  add column if not exists windows_empty_null integer not null default 0;
