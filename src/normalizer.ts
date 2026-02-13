import { pickRawForNormalize, markRawNormalized } from "./db";
import { upsertCustomer, insertAddress } from "./db";
import { upsertOrderNormalized, replaceOrderItems } from "./db";

/**
 * Long-running normalizer that reads raw orders, extracts/normalizes
 * customer, address, order and items data, and persists them in normalized tables.
 * Runs forever until the process is stopped.
 */
export async function runNormalizerForever() {

  console.log("🧠 Normalizer started");

  while (true) {

    const batch = await pickRawForNormalize(20);

    if (!batch.length) {
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }

    for (const raw of batch) {

      try {

        const payload = raw.payload;
        const first = Array.isArray(payload) ? payload[0] : payload;

        // ---------- CUSTOMER ----------
        const customer = first?.customer ?? {};

        const customerId = await upsertCustomer({
          provider: raw.provider,
          external_id: customer?.id ?? null,
          name: customer?.name ?? null,
          phone: customer?.phone ?? null,
          document_number: customer?.document_number ?? null,
        });

        // ---------- ADDRESS ----------
        const addressId = await insertAddress({
          customer_id: customerId,
          raw_address: first?.delivery_address ?? null,
        });

        // ---------- ORDER ----------
        await upsertOrderNormalized({
          provider: raw.provider,
          store_id: raw.store_id,
          order_id: raw.order_id,
          status: raw.status,
          received_at: raw.received_at,
          created_at: first?.created_at ?? null,

          customer_id: customerId,
          address_id: addressId,
          order_mode: first?.order_method?.mode ?? null,

          customer_name: first?.customer ?? null,
          notes: first?.notes ?? null,
          total_value: Number(first?.totalValue ?? 0),
          total_items_value: Number(first?.totalItems ?? 0),
          total_discount: Number(first?.totalDiscount ?? 0),
          total_increase: Number(first?.totalIncrease ?? 0),
          discount_reason: first?.discountReason ?? null,
          increase_reason: first?.increaseReason ?? null,
          items_count: first?.items?.length ?? 0,
        });

        // ---------- ITEMS ----------
        const items = (first?.items ?? []).map((it:any, idx:number)=>({
          line: idx+1,
          name: it.desc_sale_item,
          integration_code: it.integration_code,
          quantity: Number(it.quantity),
          unit_price: Number(it.unit_price),
          deleted: it.deleted,
          raw_item: it,
        }));

        await replaceOrderItems({
          provider: raw.provider,
          store_id: raw.store_id,
          order_id: raw.order_id,
          items,
        });

        await markRawNormalized(raw.id);

      } catch (err:any) {

        console.error("normalize failed:", raw.id, err.message);
      }
    }
  }
}