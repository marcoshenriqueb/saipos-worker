import { config } from "./config";
import { salesAll, salesItemsAll } from "./saipos/dataApi";
import { upsertOrdersRaw } from "./db";

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Format "YYYY-MM-DD HH:mm:ss" em UTC (compatível com exemplo da Saipos)
 */
function fmtUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-` +
    `${pad(d.getUTCMonth() + 1)}-` +
    `${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:` +
    `${pad(d.getUTCMinutes())}:` +
    `${pad(d.getUTCSeconds())}`
  );
}

/**
 * Janela: pega últimos N dias, mas termina em "agora - 26h" por causa do delay da Data API.
 * (mantém simples e robusto para começar)
 */
function computeWindowUtc(daysBack: number): { start: Date; end: Date } {
  const now = new Date();

  // Saipos Data API tem delay ~24h; usamos 26h para margem
  const end = new Date(now.getTime() - 26 * 60 * 60 * 1000);

  // volta N dias a partir do end
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);

  return { start, end };
}

export async function runWorkerForever(): Promise<void> {
  console.log("🚀 Worker (Data API ingest) iniciado.");

  while (true) {
    try {
      if (config.workerMode !== "ingest") {
        // modo seguro: não faz nada
        await sleep(config.pollIntervalMs);
        continue;
      }

      const { start, end } = computeWindowUtc(config.ingest.daysBack);

      const p_date_column_filter = "shift_date";
      const p_filter_date_start = fmtUtc(start);
      const p_filter_date_end = fmtUtc(end);

      // 1) vendas
      const sales = await salesAll({
        p_date_column_filter,
        p_filter_date_start,
        p_filter_date_end,
        p_limit: 300,
        maxPages: 200,
      });

      // 2) itens das vendas (endpoint separado)
      const items = await salesItemsAll({
        p_date_column_filter,
        p_filter_date_start,
        p_filter_date_end,
        p_limit: 300,
        maxPages: 400,
      });

      // 3) indexa itens por (id_store,id_sale)
      const itemsBySale = new Map<string, any[]>();
      for (const it of items) {
        const idStore = String((it as any)?.id_store ?? "");
        const idSale = String((it as any)?.id_sale ?? "");
        if (!idStore || !idSale) continue;
        const key = `${idStore}:${idSale}`;
        const arr = itemsBySale.get(key);
        if (arr) arr.push(it);
        else itemsBySale.set(key, [it]);
      }

      console.log(
        `📦 Window shift_date UTC: ${p_filter_date_start} -> ${p_filter_date_end} | sales=${sales.length} | items=${items.length}`
      );

      // 4) salva em orders_raw com payload enriquecido
      const receivedAtIso = new Date().toISOString();
      let upserted = 0;

      for (const sale of sales) {
        const idStore = String((sale as any)?.id_store ?? "");
        const idSale = String((sale as any)?.id_sale ?? "");
        if (!idStore || !idSale) continue;

        const key = `${idStore}:${idSale}`;
        const saleItems = itemsBySale.get(key) ?? [];

        const payloadEnriched = {
          ...sale,
          items: saleItems,
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

      console.log(`✅ orders_raw upserted=${upserted}`);

      await sleep(config.pollIntervalMs);
    } catch (e: any) {
      console.error("❌ Worker error:", e?.message || e);
      await sleep(3000);
    }
  }
}