import { pool, upsertFinancialTransactionRaw } from "./db";
import { financialTransactionsAll } from "./saipos/dataApi";
import { fmtUtc, parseDateAtUtcMidnight, sleep, toDateOnlyUtc } from "./utils/common";

/**
 * Backfill one-shot para popular financial_transactions_raw em janelas
 * históricas. O endpoint da Saipos rejeita janelas > 15 dias, então
 * BACKFILL_FIN_WINDOW_DAYS é validado contra esse limite.
 *
 * Env vars:
 * - BACKFILL_FIN_START_DATE (YYYY-MM-DD, inclusive)
 * - BACKFILL_FIN_END_DATE (YYYY-MM-DD, exclusivo) — default: hoje
 * - BACKFILL_FIN_WINDOW_DAYS (default 15, max 15)
 * - BACKFILL_FIN_DATE_COLUMN_FILTER (default "date")
 * - BACKFILL_FIN_SLEEP_MS (default 400)
 * - BACKFILL_FIN_MAX_RETRIES (default 8)
 * - BACKFILL_FIN_RETRY_SLEEP_MS (default 5000)
 * - BACKFILL_FIN_ONLY_STORE_IDS (csv opcional)
 */
const FINANCIAL_MAX_WINDOW_DAYS = 15;

async function main(): Promise<void> {
  const startDateStr = process.env.BACKFILL_FIN_START_DATE || "2026-01-01";
  const endDateStr = process.env.BACKFILL_FIN_END_DATE || toDateOnlyUtc(new Date());
  const windowDays = Number(process.env.BACKFILL_FIN_WINDOW_DAYS || String(FINANCIAL_MAX_WINDOW_DAYS));
  const sleepMs = Number(process.env.BACKFILL_FIN_SLEEP_MS || "400");
  const maxRetries = Number(process.env.BACKFILL_FIN_MAX_RETRIES || "8");
  const retrySleepMs = Number(process.env.BACKFILL_FIN_RETRY_SLEEP_MS || "5000");
  const dateColumnFilter = process.env.BACKFILL_FIN_DATE_COLUMN_FILTER || "date";

  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new Error(`Invalid BACKFILL_FIN_WINDOW_DAYS=${process.env.BACKFILL_FIN_WINDOW_DAYS}`);
  }
  if (windowDays > FINANCIAL_MAX_WINDOW_DAYS) {
    throw new Error(
      `BACKFILL_FIN_WINDOW_DAYS=${windowDays} exceeds Saipos limit of ${FINANCIAL_MAX_WINDOW_DAYS} days`
    );
  }
  if (!Number.isFinite(sleepMs) || sleepMs < 0) {
    throw new Error(`Invalid BACKFILL_FIN_SLEEP_MS=${process.env.BACKFILL_FIN_SLEEP_MS}`);
  }
  if (!Number.isFinite(maxRetries) || maxRetries < 0) {
    throw new Error(`Invalid BACKFILL_FIN_MAX_RETRIES=${process.env.BACKFILL_FIN_MAX_RETRIES}`);
  }
  if (!Number.isFinite(retrySleepMs) || retrySleepMs < 0) {
    throw new Error(`Invalid BACKFILL_FIN_RETRY_SLEEP_MS=${process.env.BACKFILL_FIN_RETRY_SLEEP_MS}`);
  }

  const start = parseDateAtUtcMidnight(startDateStr);
  const endExclusive = parseDateAtUtcMidnight(endDateStr);

  if (start >= endExclusive) {
    throw new Error(`Invalid range: start=${startDateStr} must be < end=${endDateStr}`);
  }

  const onlyStores = (process.env.BACKFILL_FIN_ONLY_STORE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const onlyStoresSet = new Set(onlyStores);

  console.log(
    `💰 Backfill financial_transactions_raw | start=${startDateStr} end=${endDateStr} (exclusive) ` +
      `windowDays=${windowDays} dateColumn=${dateColumnFilter} sleepMs=${sleepMs} ` +
      `maxRetries=${maxRetries} retrySleepMs=${retrySleepMs}` +
      (onlyStores.length ? ` stores=${onlyStores.join(",")}` : "")
  );

  let totalRows = 0;
  let totalUpserted = 0;

  for (let cur = new Date(start); cur < endExclusive; ) {
    const next = new Date(cur.getTime() + windowDays * 24 * 60 * 60 * 1000);
    const winEnd = next < endExclusive ? next : endExclusive;
    const winStartStr = toDateOnlyUtc(cur);
    const winEndStr = toDateOnlyUtc(winEnd);

    const p_filter_date_start = fmtUtc(cur);
    const p_filter_date_end = fmtUtc(new Date(winEnd.getTime() - 1000));

    let attempt = 0;
    let completed = false;

    while (!completed) {
      try {
        const rows = await financialTransactionsAll({
          p_date_column_filter: dateColumnFilter,
          p_filter_date_start,
          p_filter_date_end,
          p_limit: 300,
          maxPages: 800,
        });

        totalRows += rows.length;

        const receivedAtIso = new Date().toISOString();
        let upserted = 0;
        let skipped = 0;

        for (const row of rows) {
          const storeId = (row as any)?.id_store != null ? String((row as any).id_store) : "";
          const financialTransactionId =
            (row as any)?.id_store_fin_transaction != null
              ? String((row as any).id_store_fin_transaction)
              : "";

          if (!storeId || !financialTransactionId) {
            skipped++;
            continue;
          }
          if (onlyStoresSet.size > 0 && !onlyStoresSet.has(storeId)) continue;

          await upsertFinancialTransactionRaw({
            provider: "saipos",
            store_id: storeId,
            financial_transaction_id: financialTransactionId,
            received_at: receivedAtIso,
            payload: row,
          });

          upserted++;
        }

        totalUpserted += upserted;
        console.log(
          `💰 window ${winStartStr}..${winEndStr} rows=${rows.length} upserted=${upserted} skipped=${skipped} attempt=${attempt + 1}`
        );
        completed = true;
      } catch (e: any) {
        attempt++;
        const msg = String(e?.message || e);
        const isRetryable =
          msg.includes("504") ||
          msg.includes("PGRST003") ||
          msg.toLowerCase().includes("timeout") ||
          msg.includes("ETIMEDOUT");

        if (!isRetryable || attempt > maxRetries) {
          console.error(
            `❌ janela ${winStartStr}..${winEndStr} falhou após ${attempt} tentativa(s).`
          );
          console.error(
            `🔁 Para retomar do ponto de falha: BACKFILL_FIN_START_DATE=${winStartStr}`
          );
          throw e;
        }

        const waitMs = retrySleepMs * attempt;
        console.warn(
          `⚠️ janela ${winStartStr}..${winEndStr} falhou (tentativa ${attempt}/${maxRetries}): ${msg}. Retry em ${waitMs}ms...`
        );
        if (waitMs > 0) await sleep(waitMs);
      }
    }

    cur = winEnd;
    if (sleepMs > 0) await sleep(sleepMs);
  }

  console.log(`✅ Backfill financeiro concluído | totalRows=${totalRows} totalUpserted=${totalUpserted}`);
}

main()
  .catch((e: any) => {
    console.error("❌ Backfill financeiro falhou:", e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
