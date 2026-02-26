import { config } from "./config";
import {
  pickRawForNormalize,
  markRawNormalized,
  markRawNormalizeError,
  upsertCustomerV2,
  upsertOrderV2,
  replaceOrderDeliveryV2,
  replaceOrderPaymentsV2,
  replaceOrderItemsAndChoicesV2,
} from "./db";
import { customerPhoneOrNull, digitsOnlyOrNull, numberOrNull, sleep, trimOrNull } from "./utils/common";

function ynBool(v: any): boolean | null {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  if (s === "Y") return true;
  if (s === "N") return false;
  if (typeof v === "boolean") return v;
  return null;
}

/**
 * Extract a consistent "sale" object from orders_raw.payload
 * (Some APIs wrap as { data: ... } or { items: [...] }).
 */
function getSaleFromPayload(payload: any): any {
  if (!payload) return null;

  // common wrappers
  if (payload.data && typeof payload.data === "object") return payload.data;
  if (payload.sale && typeof payload.sale === "object") return payload.sale;

  // already the sale
  return payload;
}

/**
 * Find the items array in the sale payload.
 * Saipos sandbox (order api) used `items`, data api may also use `items`.
 * Keep flexible.
 */
function getSaleItems(sale: any): any[] {
  if (!sale) return [];
  const candidates = [
    sale.items,
    sale.sale_items,
    sale.itens,
    sale.products,
    sale.order_items,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

/**
 * Decide whether we should create a customer row.
 * Rule: create ONLY if we have at least one strong identifier:
 * - external_id (id_customer)
 * - email
 * - phone
 * - document_number (cpf_cnpj)
 * If only name exists, do NOT create customer; store name on order instead.
 */
function shouldCreateCustomer(c: any): boolean {
  if (!c) return false;

  const externalId = trimOrNull(c.id_customer ?? c.external_id);
  const email = trimOrNull(c.email);
  const phone = customerPhoneOrNull(c.phone);
  const doc = digitsOnlyOrNull(c.cpf_cnpj ?? c.document_number);

  return Boolean(externalId || email || phone || doc);
}

async function normalizeOne(row: {
  id: number;
  provider: string;
  store_id: string;
  order_id: string;
  canceled: boolean | null;
  received_at: string;
  payload: any;
}): Promise<void> {
  const sale = getSaleFromPayload(row.payload);
  if (!sale || typeof sale !== "object") {
    throw new Error("payload inválido: sale não é objeto");
  }

  // --- customer ---
  const cust = sale.customer ?? null;

  let customerId: number | null = null;

  if (cust && typeof cust === "object") {
    const name = trimOrNull(cust.name);
    const externalId = trimOrNull(cust.id_customer ?? cust.external_id);
    const email = trimOrNull(cust.email);
    const phone = customerPhoneOrNull(cust.phone);
    const doc = digitsOnlyOrNull(cust.cpf_cnpj ?? cust.document_number);

    if (shouldCreateCustomer(cust)) {
      customerId = await upsertCustomerV2({
        provider: row.provider,
        external_id: externalId,
        name,
        email,
        phone,
        document_number: doc,
      });
    }
  }

  // --- order (orders table) ---
  const orderRowId = await upsertOrderV2({
    provider: row.provider,
    store_id: row.store_id,
    order_id: row.order_id,
    received_at: row.received_at,

    id_sale_type: sale.id_sale_type != null ? Number(sale.id_sale_type) : null,
    shift_date: trimOrNull(sale.shift_date),
    created_at_source: trimOrNull(sale.created_at),
    updated_at_source: trimOrNull(sale.updated_at),
    sale_number: trimOrNull(sale.sale_number),
    desc_sale: trimOrNull(sale.desc_sale),

    canceled: ynBool(sale.canceled) ?? row.canceled,
    count_canceled_items: sale.count_canceled_items != null ? Number(sale.count_canceled_items) : null,

    notes: trimOrNull(sale.notes),
    discount_reason: trimOrNull(sale.discount_reason),
    increase_reason: trimOrNull(sale.increase_reason),

    total_amount: numberOrNull(sale.total_amount),
    total_discount: numberOrNull(sale.total_discount),
    total_increase: numberOrNull(sale.total_increase),
    total_amount_items: numberOrNull(sale.total_amount_items),

    // items_count can be informed or derived
    items_count: sale.total_items != null ? Number(sale.total_items) : getSaleItems(sale).length,

    customer_id: customerId,
    partner_sale_source: trimOrNull(sale.partner_sale?.desc_partner_sale),
  });

  // --- delivery (order_deliveries) ---
  await replaceOrderDeliveryV2(orderRowId, sale.delivery ?? null);

  // --- payments (order_payments) ---
  await replaceOrderPaymentsV2(orderRowId, Array.isArray(sale.payments) ? sale.payments : []);

  // --- items + choices (order_items / order_item_choices) ---
  const items = getSaleItems(sale);

  if (items.length > 0) {
    await replaceOrderItemsAndChoicesV2({
      provider: row.provider,
      store_id: row.store_id,
      order_id: row.order_id,
      items,
    });
  } else {
    console.warn(
      `ℹ️ sem itens no payload (order_id=${row.order_id}). Vou normalizar só a order por enquanto.`
    );
  }

  // success
  await markRawNormalized(row.id);
}

export async function runNormalizerForever(): Promise<void> {
  console.log("🧱 Normalizer iniciado.");

  while (true) {
    try {
      const batch = await pickRawForNormalize(config.normalize.batchSize);

      if (batch.length === 0) {
        await sleep(config.pollIntervalMs);
        continue;
      }

      console.log(`🧱 Normalizer picked ${batch.length} raw orders`);

      for (const row of batch) {
        try {
          await normalizeOne(row);
          console.log(`✅ normalized orders_raw.id=${row.id} order_id=${row.order_id}`);
        } catch (e: any) {
          const msg = String(e?.message || e);
          console.warn(`⚠️ normalize error orders_raw.id=${row.id} order_id=${row.order_id}: ${msg}`);
          await markRawNormalizeError(row.id, msg);
        }
      }
    } catch (e: any) {
      console.error("❌ Normalizer loop error:", e?.message || e);
      await sleep(2000);
    }
  }
}
