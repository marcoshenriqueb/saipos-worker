# Financial ingest

## New envs

- `FINANCIAL_WORKER_MODE=idle|ingest`
- `FINANCIAL_INGEST_DAYS_BACK=7` — pass `updated_at`
- `FINANCIAL_INGEST_LOOKBACK_HOURS=26` — pass `updated_at`
- `FINANCIAL_INGEST_DATE_DAYS_BACK=8` — pass `date`
- `FINANCIAL_INGEST_DATE_DAYS_FORWARD=6` — pass `date`
- `FINANCIAL_NORMALIZER_BATCH_SIZE=100`
- `FINANCIAL_SWEEP_*` — deletion sweep, see below

## Ingest — dois passes por ciclo

O worker faz **dois fetches por ciclo**, ambos com upsert no mesmo raw (dedup pela unique key):

1. **Pass `date`** — janela `[hoje−dateDaysBack, hoje+dateDaysForward]`. Cobre passado recente + futuro próximo. Garante que boletos/impostos/recorrências que **vencem** na janela operacional estão sincronizados, mesmo que tenham sido criados meses atrás (`updated_at` antigo).
2. **Pass `updated_at`** — janela `[hoje−daysBack−lookback, hoje]`. Pega edições e lançamentos recém-criados, inclusive recorrências com `date` distante (fora da janela do pass 1).

Motivo: a Saipos gera lançamentos recorrentes/agendados com `date` futuro mas `updated_at` da data de criação. Filtrar só por `updated_at` perde esses lançamentos. Cada pass é isolado — falha em um (ex: 504) não impede o outro.

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

## Deletion sweep (propagação de deleção)

Design: `docs/2026-10-16-deletion-propagation-design.md`. Migration: `0014_financial_tombstones.sql`.

The Saipos API has no "deleted" flag: a deleted financial transaction simply stops
being returned. Once a day the worker reads **every** `date` window from
`FINANCIAL_SWEEP_RANGE_START` to `max(financial_transactions.date, now) + FINANCIAL_SWEEP_FORWARD_DAYS`
(15-day windows, ~112 today) and compares the ids with the mirror.

Rules:
- **All-or-nothing.** A window counts only if it fully succeeds (5 attempts, backoff 15/30/45/60 s on top of the
  client's 5xx retry; response must be an array; page limit not hit; every row has ids). If any window fails,
  the sweep is recorded as `aborted` and nothing is marked, cleared or upserted.
- **Two strikes.** A live row in the candidate range (one day inside each edge) not returned by a complete sweep
  gets `financial_transactions_raw.missing_since` (strike 1). Missing again in a later complete sweep, at least
  `FINANCIAL_SWEEP_MIN_STRIKE_GAP_HOURS` after strike 1 → `deleted_at_source` on the raw row **and** on
  `financial_transactions.deleted_at_source` (same transaction). The Mise app reads that column.
- **The mirror mirrors.** A row returned again — by the sweep or by the regular 2-min passes / backfill — has
  `missing_since` and `deleted_at_source` cleared and, if it was tombstoned, is re-queued for normalization
  (the normalizer copies the raw `deleted_at_source`, i.e. NULL, into `financial_transactions`).
- **Circuit breaker.** If candidates > `max(FINANCIAL_SWEEP_BREAKER_MIN, FINANCIAL_SWEEP_BREAKER_PCT% of live rows in range)`
  the sweep marks nothing (status `aborted`) — rows seen alive are still upserted/cleared. Override only
  with a manual `--force` run after reviewing a dry run.
- Rows received by any pass after the sweep started are never marked.

Every run is recorded in `financial_sweeps` (mode, status, windows ok/failed, rows seen/new, rows in range,
candidates, marked_missing, tombstoned, cleared, breaker limit, abort reason, sample of up to 50 candidates).
In `dry_run`, `marked_missing` / `tombstoned` / `cleared` are what `apply` **would** do; nothing else is written.

Env vars:
- `FINANCIAL_SWEEP_MODE=off|dry_run|apply` — default **`dry_run`**
- `FINANCIAL_SWEEP_AT=04:30` — local time of the daily run
- `FINANCIAL_SWEEP_TZ=America/Sao_Paulo`
- `FINANCIAL_SWEEP_RANGE_START=2025-09-01`
- `FINANCIAL_SWEEP_FORWARD_DAYS=31`
- `FINANCIAL_SWEEP_SLEEP_MS=400` — between windows
- `FINANCIAL_SWEEP_BREAKER_MIN=50`, `FINANCIAL_SWEEP_BREAKER_PCT=5`
- `FINANCIAL_SWEEP_MIN_STRIKE_GAP_HOURS=20`

The scheduled sweep only runs when `FINANCIAL_WORKER_MODE=ingest` (the normalizer must be running for revivals)
and when migration 0014 is applied (otherwise it logs and skips; the 2-min ingest keeps working on the old schema).
Only one sweep runs at a time (Postgres advisory lock).

On demand:

```bash
npm run sweep:financial -- --mode=dry_run          # dev (ts-node)
node dist/sweepFinancial.js --mode=dry_run         # inside the container
node dist/sweepFinancial.js --mode=apply --force   # override the breaker (after review)
```

Exit code: 0 complete, 2 aborted/skipped, 1 failed. Inspect: `select * from financial_sweeps order by id desc limit 5;`

Initial load (hosts with a backlog, e.g. sheesh ~2.5k candidates): the breaker will trip. Run a dry run, review
`financial_sweeps.sample` / the log, then `--mode=apply --force` (strike 1); a day later run
`--mode=apply --force` again (strike 2). Note that `apply` also upserts rows that exist in the API but not in the
mirror (`rows_new`, e.g. 2025-09..12 never backfilled).

## Tests

`npm test` — `node:test` + ts-node, pure logic only (`test/`).

## Notes

- Saipos financial endpoint only supports windows up to 15 days
- `financialTransactionsAll` fails explicitly on a non-array response or when `maxPages` full pages are read (possible truncation) instead of silently returning a partial list
- raw payload é a única fonte de verdade em `financial_transactions_raw.payload`
- normalized data is split into `financial_transactions` and `financial_transaction_children`
- pai + filhos são gravados numa transação única (rollback em caso de erro)
- `paid`, `conciliated`, `recurring` são `boolean` (conversão Y/N -> true/false; valores desconhecidos viram null)
- datas são validadas no JS via `parseSourceDate` (formato não-ISO vira null em vez de quebrar a query)
- normalizer respeita `FINANCIAL_WORKER_MODE` — se `idle`, dorme sem consultar a tabela (seguro pra deploy antes da migration)
