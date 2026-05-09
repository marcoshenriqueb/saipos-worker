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

## Backfill histórico

Script one-shot pra trazer dados antigos:

```bash
BACKFILL_FIN_START_DATE=2026-01-01 \
BACKFILL_FIN_END_DATE=2026-05-09 \
npm run backfill:financial-raw
```

Envs:
- `BACKFILL_FIN_START_DATE` (YYYY-MM-DD, inclusive) — default: `2026-01-01`
- `BACKFILL_FIN_END_DATE` (YYYY-MM-DD, exclusivo) — default: hoje
- `BACKFILL_FIN_WINDOW_DAYS` — default 15, **máx 15** (limite da Saipos)
- `BACKFILL_FIN_DATE_COLUMN_FILTER` — default `date` (competência)
- `BACKFILL_FIN_SLEEP_MS` — default 400 (entre janelas)
- `BACKFILL_FIN_MAX_RETRIES` / `BACKFILL_FIN_RETRY_SLEEP_MS` — retry em 5xx/timeout
- `BACKFILL_FIN_ONLY_STORE_IDS` — csv pra filtrar lojas específicas

O backfill grava em `financial_transactions_raw` via upsert. O normalizer cuida do resto **se `FINANCIAL_WORKER_MODE=ingest`**.

## Notes

- Saipos financial endpoint only supports windows up to 15 days
- raw payload é a única fonte de verdade em `financial_transactions_raw.payload`
- normalized data is split into `financial_transactions` and `financial_transaction_children`
- pai + filhos são gravados numa transação única (rollback em caso de erro)
- `paid`, `conciliated`, `recurring` são `boolean` (conversão Y/N -> true/false; valores desconhecidos viram null)
- datas são validadas no JS via `parseSourceDate` (formato não-ISO vira null em vez de quebrar a query)
- normalizer respeita `FINANCIAL_WORKER_MODE` — se `idle`, dorme sem consultar a tabela (seguro pra deploy antes da migration)
