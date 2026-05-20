import { config } from "./config";
import { upsertFinancialTransactionRaw } from "./db";
import { financialTransactionsAll } from "./saipos/dataApi";
import { fmtUtc, sleep } from "./utils/common";

const FINANCIAL_MAX_WINDOW_DAYS = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Janela do pass `updated_at`: pega edições e lançamentos recém-criados/editados.
 * Termina em "agora", volta daysBack dias + lookbackHours. Capada em 15 dias.
 */
function computeUpdatedAtWindow(daysBack: number, lookbackHours: number): { start: Date; end: Date } {
  const safeDaysBack = Math.min(Math.max(1, Math.floor(daysBack)), FINANCIAL_MAX_WINDOW_DAYS);
  const safeLookbackHours = Math.max(0, Math.floor(lookbackHours));

  const end = new Date();
  const start = new Date(end.getTime() - safeDaysBack * DAY_MS - safeLookbackHours * 60 * 60 * 1000);

  const maxStart = new Date(end.getTime() - FINANCIAL_MAX_WINDOW_DAYS * DAY_MS);
  return { start: start < maxStart ? maxStart : start, end };
}

/**
 * Janela do pass `date`: passado recente + futuro próximo. Garante que tudo
 * que vence na janela operacional está sincronizado independente de quando o
 * lançamento foi criado/editado na Saipos. Total capado em 15 dias.
 */
function computeDateWindow(daysBack: number, daysForward: number): { start: Date; end: Date } {
  let safeBack = Math.max(0, Math.floor(daysBack));
  let safeForward = Math.max(0, Math.floor(daysForward));

  if (safeBack + safeForward > FINANCIAL_MAX_WINDOW_DAYS) {
    safeForward = Math.min(safeForward, FINANCIAL_MAX_WINDOW_DAYS);
    safeBack = FINANCIAL_MAX_WINDOW_DAYS - safeForward;
  }

  const now = new Date();
  const start = new Date(now.getTime() - safeBack * DAY_MS);
  const end = new Date(now.getTime() + safeForward * DAY_MS);
  return { start, end };
}

/**
 * Busca uma janela por um filtro de data e faz upsert em financial_transactions_raw.
 */
async function ingestPass(dateColumn: string, start: Date, end: Date): Promise<void> {
  const p_filter_date_start = fmtUtc(start);
  const p_filter_date_end = fmtUtc(end);

  const rows = await financialTransactionsAll({
    p_date_column_filter: dateColumn,
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
    `💰 Financial pass ${dateColumn} UTC: ${p_filter_date_start} -> ${p_filter_date_end} | rows=${rows.length} | upserted=${upserted} | skipped=${skipped}`
  );
}

export async function runFinancialWorkerForever(): Promise<void> {
  console.log("💰 Financial worker (Data API ingest) iniciado.");

  while (true) {
    try {
      if (config.financialWorkerMode !== "ingest") {
        await sleep(config.pollIntervalMs);
        continue;
      }

      // Pass `date` — janela operacional (passado recente + futuro próximo).
      // Pega boletos/impostos/recorrências que VENCEM na janela mesmo que
      // tenham sido criados meses atrás (updated_at antigo).
      const dateWin = computeDateWindow(
        config.financialIngest.dateDaysBack,
        config.financialIngest.dateDaysForward
      );

      // Pass `updated_at` — edições e lançamentos recém-criados, inclusive
      // recorrências com `date` distante (fora da janela do pass `date`).
      const updWin = computeUpdatedAtWindow(
        config.financialIngest.daysBack,
        config.financialIngest.lookbackHours
      );

      // Cada pass é isolado: falha em um (ex: 504) não impede o outro.
      for (const pass of [
        { col: "date", win: dateWin },
        { col: "updated_at", win: updWin },
      ]) {
        try {
          await ingestPass(pass.col, pass.win.start, pass.win.end);
        } catch (e: any) {
          console.error(`❌ Financial worker pass ${pass.col} error:`, e?.message || e);
        }
      }

      await sleep(config.pollIntervalMs);
    } catch (e: any) {
      console.error("❌ Financial worker error:", e?.message || e);
      await sleep(3000);
    }
  }
}
