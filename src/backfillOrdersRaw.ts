import { pool, upsertOrdersRaw } from "./db";
import { salesAll, salesItemsAll } from "./saipos/dataApi";
import { fmtUtc, parseDateAtUtcMidnight, sleep, toDateOnlyUtc } from "./utils/common";

/**
 * Backfill one-shot para popular orders_raw em janelas históricas.
 *
 * Env vars:
 * - BACKFILL_START_DATE (YYYY-MM-DD, inclusive)
 * - BACKFILL_END_DATE (YYYY-MM-DD, exclusivo)
 * - BACKFILL_WINDOW_DAYS (default 1)
 * - BACKFILL_SLEEP_MS (default 400)
 * - BACKFILL_ONLY_STORE_IDS (csv opcional, ex: 1004,3605)
 */
async function main(): Promise<void> {
  const startDateStr = process.env.BACKFILL_START_DATE || "2025-01-01";
  const endDateStr = process.env.BACKFILL_END_DATE || toDateOnlyUtc(new Date());
  const windowDays = Number(process.env.BACKFILL_WINDOW_DAYS || "1");
  const sleepMs = Number(process.env.BACKFILL_SLEEP_MS || "400");
  const maxRetries = Number(process.env.BACKFILL_MAX_RETRIES || "8");
  const retrySleepMs = Number(process.env.BACKFILL_RETRY_SLEEP_MS || "5000");

  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new Error(`Invalid BACKFILL_WINDOW_DAYS=${process.env.BACKFILL_WINDOW_DAYS}`);
  }
  if (!Number.isFinite(sleepMs) || sleepMs < 0) {
    throw new Error(`Invalid BACKFILL_SLEEP_MS=${process.env.BACKFILL_SLEEP_MS}`);
  }
  if (!Number.isFinite(maxRetries) || maxRetries < 0) {
    throw new Error(`Invalid BACKFILL_MAX_RETRIES=${process.env.BACKFILL_MAX_RETRIES}`);
  }
  if (!Number.isFinite(retrySleepMs) || retrySleepMs < 0) {
    throw new Error(`Invalid BACKFILL_RETRY_SLEEP_MS=${process.env.BACKFILL_RETRY_SLEEP_MS}`);
  }

  const start = parseDateAtUtcMidnight(startDateStr);
  const endExclusive = parseDateAtUtcMidnight(endDateStr);

  if (start >= endExclusive) {
    throw new Error(`Invalid range: start=${startDateStr} must be < end=${endDateStr}`);
  }

  const onlyStores = (process.env.BACKFILL_ONLY_STORE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const onlyStoresSet = new Set(onlyStores);

  console.log(
    `🚚 Backfill orders_raw | start=${startDateStr} end=${endDateStr} (exclusive) windowDays=${windowDays} sleepMs=${sleepMs} maxRetries=${maxRetries} retrySleepMs=${retrySleepMs}` +
      (onlyStores.length ? ` stores=${onlyStores.join(",")}` : "")
  );

  let totalSales = 0;
  let totalItems = 0;
  let totalUpserted = 0;

  // Processa por janela para reduzir risco de timeout/504 no endpoint da Data API.
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
        const sales = await salesAll({
          p_date_column_filter: "shift_date",
          p_filter_date_start,
          p_filter_date_end,
          p_limit: 300,
          maxPages: 800,
        });

        const items = await salesItemsAll({
          p_date_column_filter: "shift_date",
          p_filter_date_start,
          p_filter_date_end,
          p_limit: 300,
          maxPages: 1200,
        });

        totalSales += sales.length;
        totalItems += items.length;

        const itemsBySale = new Map<string, any[]>();
        for (const it of items) {
          const idStore = String((it as any)?.id_store ?? "");
          const idSale = String((it as any)?.id_sale ?? "");
          if (!idStore || !idSale) continue;

          const key = `${idStore}:${idSale}`;
          // Compatível com os 2 formatos observados no /v1/sales_items:
          // 1) agrupado por venda com `items: []`
          // 2) item por linha
          if (Array.isArray((it as any)?.items)) {
            itemsBySale.set(key, (it as any).items);
          } else {
            const arr = itemsBySale.get(key);
            if (arr) arr.push(it);
            else itemsBySale.set(key, [it]);
          }
        }

        const receivedAtIso = new Date().toISOString();
        let upserted = 0;

        for (const sale of sales) {
          const idStore = String((sale as any)?.id_store ?? "");
          const idSale = String((sale as any)?.id_sale ?? "");
          if (!idStore || !idSale) continue;
          if (onlyStoresSet.size > 0 && !onlyStoresSet.has(idStore)) continue;

          const key = `${idStore}:${idSale}`;
          const payloadEnriched = {
            ...sale,
            // Mantém os itens dentro do payload de venda para o normalizer atual.
            items: itemsBySale.get(key) ?? [],
          };

          await upsertOrdersRaw({
            provider: "saipos",
            store_id: idStore,
            order_id: idSale,
            canceled: String((sale as any)?.canceled ?? "").toUpperCase() === "Y",
            received_at: receivedAtIso,
            payload: payloadEnriched,
          });

          upserted++;
        }

        totalUpserted += upserted;
        console.log(
          `📦 window ${winStartStr}..${winEndStr} sales=${sales.length} items=${items.length} upserted=${upserted} attempt=${attempt + 1}`
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
            `🔁 Para retomar do ponto de falha: BACKFILL_START_DATE=${winStartStr}`
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

  console.log(
    `✅ Backfill concluído | totalSales=${totalSales} totalItems=${totalItems} totalUpserted=${totalUpserted}`
  );
}

main()
  .catch((e: any) => {
    console.error("❌ Backfill falhou:", e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
