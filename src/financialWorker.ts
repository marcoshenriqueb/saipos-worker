import { config } from "./config";
import { upsertFinancialTransactionRaw } from "./db";
import { financialTransactionsAll } from "./saipos/dataApi";
import { fmtUtc, sleep } from "./utils/common";

const FINANCIAL_MAX_WINDOW_DAYS = 15;

function computeFinancialWindowUtc(daysBack: number, lookbackHours: number): { start: Date; end: Date } {
  const safeDaysBack = Math.min(Math.max(1, Math.floor(daysBack)), FINANCIAL_MAX_WINDOW_DAYS);
  const safeLookbackHours = Math.max(0, Math.floor(lookbackHours));

  const end = new Date();
  const start = new Date(end.getTime() - safeDaysBack * 24 * 60 * 60 * 1000 - safeLookbackHours * 60 * 60 * 1000);

  const maxStart = new Date(end.getTime() - FINANCIAL_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  if (start < maxStart) return { start: maxStart, end };
  return { start, end };
}

export async function runFinancialWorkerForever(): Promise<void> {
  console.log("💰 Financial worker (Data API ingest) iniciado.");

  while (true) {
    try {
      if (config.financialWorkerMode !== "ingest") {
        await sleep(config.pollIntervalMs);
        continue;
      }

      const { start, end } = computeFinancialWindowUtc(
        config.financialIngest.daysBack,
        config.financialIngest.lookbackHours
      );

      const p_date_column_filter = config.financialIngest.dateColumnFilter;
      const p_filter_date_start = fmtUtc(start);
      const p_filter_date_end = fmtUtc(end);

      const rows = await financialTransactionsAll({
        p_date_column_filter,
        p_filter_date_start,
        p_filter_date_end,
        p_limit: 300,
        maxPages: 100,
      });

      const receivedAtIso = new Date().toISOString();
      let upserted = 0;
      let skipped = 0;

      for (const row of rows) {
        const storeId = row?.id_store != null ? String(row.id_store) : "";
        const financialTransactionId = row?.id_store_fin_transaction != null
          ? String(row.id_store_fin_transaction)
          : "";

        if (!storeId || !financialTransactionId) {
          skipped++;
          continue;
        }

        await upsertFinancialTransactionRaw({
          provider: "saipos",
          store_id: storeId,
          financial_transaction_id: financialTransactionId,
          received_at: receivedAtIso,
          payload: row,
        });
        upserted++;
      }

      console.log(
        `💰 Financial window ${p_date_column_filter} UTC: ${p_filter_date_start} -> ${p_filter_date_end} | rows=${rows.length} | upserted=${upserted} | skipped=${skipped}`
      );

      await sleep(config.pollIntervalMs);
    } catch (e: any) {
      console.error("❌ Financial worker error:", e?.message || e);
      await sleep(3000);
    }
  }
}
