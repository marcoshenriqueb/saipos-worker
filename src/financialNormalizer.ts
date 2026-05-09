import { config } from "./config";
import {
  markFinancialRawNormalizeError,
  markFinancialRawNormalized,
  pickFinancialRawForNormalize,
  upsertFinancialTransactionWithChildren,
} from "./db";
import { numberOrNull, parseSourceDate, sleep, trimOrNull } from "./utils/common";

function getFinancialTransactionFromPayload(payload: any): any {
  if (!payload) return null;
  if (payload.data && typeof payload.data === "object") return payload.data;
  return payload;
}

async function normalizeOne(row: {
  id: number;
  provider: string;
  store_id: string;
  financial_transaction_id: string;
  received_at: string;
  payload: any;
}): Promise<void> {
  const tx = getFinancialTransactionFromPayload(row.payload);
  if (!tx || typeof tx !== "object") {
    throw new Error("payload inválido: financial transaction não é objeto");
  }

  const children = Array.isArray(tx.children) ? tx.children : [];

  await upsertFinancialTransactionWithChildren({
    provider: row.provider,
    store_id: row.store_id,
    financial_transaction_id: row.financial_transaction_id,
    received_at: row.received_at,
    date: parseSourceDate(tx.date),
    issuance_date: parseSourceDate(tx.issuance_date),
    payment_date: parseSourceDate(tx.payment_date),
    created_at_source: parseSourceDate(tx.created_at),
    updated_at_source: parseSourceDate(tx.updated_at),
    paid: tx.paid,
    conciliated: tx.conciliated,
    recurring: tx.recurring,
    installment: numberOrNull(tx.installment),
    total_installments: numberOrNull(tx.total_installments),
    amount: numberOrNull(tx.amount),
    notes: trimOrNull(tx.notes),
    provider_trade_name: trimOrNull(tx.provider_trade_name),
    bank_account_desc: trimOrNull(tx.desc_store_bank_account),
    payment_method_desc: trimOrNull(tx.desc_store_payment_method),
    transaction_desc: trimOrNull(tx.desc_store_fin_transaction),
    financial_category_desc: trimOrNull(tx.desc_store_category_financial),
    children,
  });

  await markFinancialRawNormalized(row.id);
}

export async function runFinancialNormalizerForever(): Promise<void> {
  console.log(
    `🧾 Financial normalizer iniciado (mode=${config.financialWorkerMode}).`
  );

  while (true) {
    try {
      // Mesmo gate do ingest: se o pipeline financeiro está desligado, o
      // normalizer também dorme. Evita queries em loop quando a tabela ainda
      // não existe (deploy do código antes da migration).
      if (config.financialWorkerMode !== "ingest") {
        await sleep(config.pollIntervalMs);
        continue;
      }

      const batch = await pickFinancialRawForNormalize(config.financialNormalize.batchSize);

      if (batch.length === 0) {
        await sleep(config.pollIntervalMs);
        continue;
      }

      console.log(`🧾 Financial normalizer picked ${batch.length} raw transactions`);

      for (const row of batch) {
        try {
          await normalizeOne(row);
          console.log(
            `✅ normalized financial_transactions_raw.id=${row.id} financial_transaction_id=${row.financial_transaction_id}`
          );
        } catch (e: any) {
          const msg = String(e?.message || e);
          console.warn(
            `⚠️ financial normalize error financial_transactions_raw.id=${row.id} financial_transaction_id=${row.financial_transaction_id}: ${msg}`
          );
          await markFinancialRawNormalizeError(row.id, msg);
        }
      }
    } catch (e: any) {
      console.error("❌ Financial normalizer loop error:", e?.message || e);
      await sleep(2000);
    }
  }
}
