# Financial ingest

## New envs

- `FINANCIAL_WORKER_MODE=idle|ingest`
- `FINANCIAL_INGEST_DAYS_BACK=7`
- `FINANCIAL_INGEST_DATE_COLUMN_FILTER=updated_at`
- `FINANCIAL_INGEST_LOOKBACK_HOURS=26`
- `FINANCIAL_NORMALIZER_BATCH_SIZE=100`

## Rollout

Default behavior remains unchanged for sales.

To enable the financial pipeline:

1. run migrations
2. set `FINANCIAL_WORKER_MODE=ingest`
3. restart the worker

## Notes

- Saipos financial endpoint only supports windows up to 15 days
- raw payload is preserved in `financial_transactions_raw`
- normalized data is split into `financial_transactions` and `financial_transaction_children`
