import { Pool } from "pg";
import { config } from "./config";

export const pool = new Pool({
  connectionString: config.databaseUrl,
});

export async function pingDb(): Promise<void> {
  const r = await pool.query("select now() as now");
  console.log("✅ DB OK:", r.rows[0].now);
}

/**
 * orders_raw upsert (immutable-ish snapshot for reprocessing)
 */
export async function upsertOrdersRaw(args: {
  provider: string;
  store_id: string;
  order_id: string;
  canceled: boolean | null;
  received_at: string; // timestamptz string
  payload: any;
}): Promise<void> {
  await pool.query(
    `
    insert into orders_raw (provider, store_id, order_id, canceled, received_at, payload, payload_hash)
    values ($1,$2,$3,$4,$5,$6::jsonb, md5(($6::jsonb)::text))
    on conflict (provider, store_id, order_id)
    do update set
      canceled = excluded.canceled,
      received_at = excluded.received_at,
      payload = excluded.payload,
      payload_hash = excluded.payload_hash,
      normalized = case
        when orders_raw.payload_hash is distinct from excluded.payload_hash then false
        else orders_raw.normalized
      end,
      normalized_at = case
        when orders_raw.payload_hash is distinct from excluded.payload_hash then null
        else orders_raw.normalized_at
      end,
      attempts = case
        when orders_raw.payload_hash is distinct from excluded.payload_hash then 0
        else orders_raw.attempts
      end,
      last_error = case
        when orders_raw.payload_hash is distinct from excluded.payload_hash then null
        else orders_raw.last_error
      end,
      next_retry_at = case
        when orders_raw.payload_hash is distinct from excluded.payload_hash then null
        else orders_raw.next_retry_at
      end,
      processing_started_at = case
        when orders_raw.payload_hash is distinct from excluded.payload_hash then null
        else orders_raw.processing_started_at
      end
    `,
    [args.provider, args.store_id, args.order_id, args.canceled, args.received_at, JSON.stringify(args.payload)]
  );
}

/**
 * customers
 */
export async function upsertCustomer(args: {
  provider: string;
  external_id: string | null;
  name: string | null;
  phone: string | null;
  document_number: string | null;
}): Promise<number> {
  const provider = args.provider;
  const externalId = args.external_id ? String(args.external_id).trim() : null;
  const name = args.name ? String(args.name).trim() : null;

  // Normalize common BR formats to digits-only
  const phone = args.phone ? String(args.phone).replace(/\D/g, "") : null;
  const documentNumber = args.document_number ? String(args.document_number).replace(/\D/g, "") : null;

  // If we have a CPF/document number, use it as the primary id (unique constraint exists).
  if (documentNumber) {
    const r = await pool.query(
      `
      insert into customers (provider, document_number, external_id, name, phone, updated_at)
      values ($1, $2, $3, $4, $5, now())
      on conflict (provider, document_number) where document_number is not null
      do update set
        external_id = coalesce(excluded.external_id, customers.external_id),
        name = coalesce(excluded.name, customers.name),
        phone = coalesce(excluded.phone, customers.phone),
        updated_at = now()
      returning id
      `,
      [provider, documentNumber, externalId, name, phone]
    );
    return Number(r.rows[0].id);
  }

  // No CPF: try to reuse an existing customer by provider + external_id OR provider + phone
  if (externalId || phone) {
    const existing = await pool.query(
      `
      select id
      from customers
      where provider = $1
        and (
          ($2 is not null and external_id = $2) or
          ($3 is not null and phone = $3)
        )
      limit 1
      `,
      [provider, externalId, phone]
    );

    if (existing.rowCount && existing.rows[0]?.id) {
      const id = Number(existing.rows[0].id);
      // Best-effort enrich
      await pool.query(
        `
        update customers
        set
          external_id = coalesce($2, external_id),
          name = coalesce($3, name),
          phone = coalesce($4, phone),
          updated_at = now()
        where id = $1
        `,
        [id, externalId, name, phone]
      );
      return id;
    }
  }

  // Insert new (no guaranteed dedupe key available)
  const ins = await pool.query(
    `
    insert into customers (provider, external_id, name, phone, updated_at)
    values ($1, $2, $3, $4, now())
    returning id
    `,
    [provider, externalId, name, phone]
  );

  return Number(ins.rows[0].id);
}

/**
 * Normalizer: pick raw orders that are not normalized yet (SKIP LOCKED)
 * Note: We return only columns needed by normalizer (id/provider/store_id/order_id/canceled/received_at/payload).
 */
export type OrdersRawRow = {
  id: number;
  provider: string;
  store_id: string;
  order_id: string;
  canceled: boolean | null;
  received_at: string;
  payload: any;
};

export async function pickRawForNormalize(limit: number): Promise<OrdersRawRow[]> {
  const r = await pool.query(
    `
    with picked as (
      select id
      from orders_raw
      where normalized = false
      and (next_retry_at is null or next_retry_at <= now())
      order by received_at asc
      limit $1
      for update skip locked
    )
    select r.id, r.provider, r.store_id, r.order_id, r.canceled, r.received_at, r.payload
    from orders_raw r
    join picked p on p.id = r.id
    `,
    [limit]
  );
  return r.rows as OrdersRawRow[];
}

export async function markRawNormalized(id: number): Promise<void> {
  await pool.query(
    `
    update orders_raw
    set
      normalized = true,
      normalized_at = now(),
      processing_started_at = null,
      last_error = null,
      next_retry_at = null
    where id = $1
    `,
    [id]
  );
}

export async function markRawNormalizeError(id: number, error: string): Promise<void> {
  await pool.query(
    `
    update orders_raw
    set
      attempts = attempts + 1,
      last_error = $2,
      next_retry_at = now() + interval '5 minutes',
      processing_started_at = null
    where id = $1
    `,
    [id, error]
  );

  console.error("normalize error:", id, error);
}

/**
 * order_items (normalized BI table)
 * Replace snapshot: delete all items for this order and insert current snapshot.
 */
export async function replaceOrderItems(args: {
  provider: string;
  store_id: string;
  order_id: string;
  items: Array<{
    line: number;
    name: string | null;
    integration_code: string | null;
    quantity: number | null;
    unit_price: number | null;
    deleted: string | null;
    raw_item: any;
  }>;
}): Promise<void> {
  await pool.query(
    `delete from order_items where provider=$1 and store_id=$2 and order_id=$3`,
    [args.provider, args.store_id, args.order_id]
  );

  if (!args.items.length) return;

  const values: any[] = [];
  const placeholders: string[] = [];
  let p = 1;

  for (const it of args.items) {
    placeholders.push(
      `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::jsonb)`
    );
    values.push(
      args.provider,
      args.store_id,
      args.order_id,
      it.line,
      it.name,
      it.integration_code,
      it.quantity,
      it.unit_price,
      it.deleted,
      JSON.stringify(it.raw_item ?? {})
    );
  }

  await pool.query(
    `
    insert into order_items (
      provider, store_id, order_id,
      line, name, integration_code, quantity, unit_price, deleted, raw_item
    )
    values ${placeholders.join(",")}
    `,
    values
  );
}

// =========================
// Normalizer v2 helpers (Saipos Data API /v1/sales)
// Keep all SQL in db.ts; normalizer.ts should only parse/transform.
// =========================

function digitsOnly(v: any): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\D/g, "");
  return s ? s : null;
}

function toBoolCanceled(v: any): boolean | null {
  if (v == null) return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toUpperCase();
  if (s === "Y" || s === "S" || s === "TRUE" || s === "1") return true;
  if (s === "N" || s === "FALSE" || s === "0") return false;
  return null;
}

/**
 * Upsert customer using your uniques (provider + document/email/phone/external_id).
 * Returns customer row id.
 */
export async function upsertCustomerV2(args: {
  provider: string;
  external_id: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  document_number: string | null;
}): Promise<number> {
  const provider = args.provider;
  const externalId = args.external_id ? String(args.external_id).trim() : null;
  const name = args.name ? String(args.name).trim() : null;
  const email = args.email ? String(args.email).trim() : null;
  const phone = digitsOnly(args.phone);
  const documentNumber = digitsOnly(args.document_number);

  if (documentNumber) {
    const r = await pool.query(
      `
      insert into customers (provider, document_number, external_id, name, email, phone, updated_at)
      values ($1,$2,$3,$4,$5,$6, now())
      on conflict (provider, document_number) where document_number is not null and document_number <> ''
      do update set
        external_id = coalesce(excluded.external_id, customers.external_id),
        name = coalesce(excluded.name, customers.name),
        email = coalesce(excluded.email, customers.email),
        phone = coalesce(excluded.phone, customers.phone),
        updated_at = now()
      returning id
      `,
      [provider, documentNumber, externalId, name, email, phone]
    );
    return Number(r.rows[0].id);
  }

  if (email) {
    const r = await pool.query(
      `
      insert into customers (provider, email, external_id, name, phone, updated_at)
      values ($1,$2,$3,$4,$5, now())
      on conflict (provider, email) where email is not null and email <> ''
      do update set
        external_id = coalesce(excluded.external_id, customers.external_id),
        name = coalesce(excluded.name, customers.name),
        phone = coalesce(excluded.phone, customers.phone),
        updated_at = now()
      returning id
      `,
      [provider, email, externalId, name, phone]
    );
    return Number(r.rows[0].id);
  }

  if (phone) {
    const r = await pool.query(
      `
      insert into customers (provider, phone, external_id, name, email, updated_at)
      values ($1,$2,$3,$4,$5, now())
      on conflict (provider, phone) where phone is not null and phone <> ''
      do update set
        external_id = coalesce(excluded.external_id, customers.external_id),
        name = coalesce(excluded.name, customers.name),
        email = coalesce(excluded.email, customers.email),
        updated_at = now()
      returning id
      `,
      [provider, phone, externalId, name, email]
    );
    return Number(r.rows[0].id);
  }

  const r = await pool.query(
    `
    insert into customers (provider, external_id, name, email, phone, updated_at)
    values ($1,$2,$3,$4,$5, now())
    on conflict (provider, external_id) where external_id is not null and external_id <> ''
    do update set
      name = coalesce(excluded.name, customers.name),
      email = coalesce(excluded.email, customers.email),
      phone = coalesce(excluded.phone, customers.phone),
      updated_at = now()
    returning id
    `,
    [provider, externalId, name, email, phone]
  );

  return Number(r.rows[0].id);
}

/**
 * Upsert normalized order row. Returns orders.id (order_row_id).
 */
export async function upsertOrderV2(args: {
  provider: string;
  store_id: string;
  order_id: string;
  received_at: string;

  id_sale_type: number | null;
  shift_date: string | null; // date
  created_at_source: string | null;
  updated_at_source: string | null;
  sale_number: string | null;
  desc_sale: string | null;

  canceled: any; // Y/N/bool
  count_canceled_items: number | null;

  notes: string | null;
  discount_reason: string | null;
  increase_reason: string | null;

  total_amount: number | null;
  total_discount: number | null;
  total_increase: number | null;
  total_amount_items: number | null;

  items_count: number | null;

  customer_id: number | null;
  partner_sale_source: string | null;
}): Promise<number> {
  const r = await pool.query(
    `
    insert into orders (
      provider, store_id, order_id,
      sale_type_id, shift_date,
      created_at_source, updated_at_source,
      sale_number, desc_sale,
      canceled, canceled_items_count,
      notes, discount_reason, increase_reason,
      total_amount, total_discount, total_increase, total_amount_items,
      items_count,
      customer_id,
      partner_sale_source,
      received_at, updated_at
    )
    values (
      $1,$2,$3,
      $4,$5,
      $6,$7,
      $8,$9,
      $10,$11,
      $12,$13,$14,
      $15,$16,$17,$18,
      $19,
      $20,
      $21,
      $22, now()
    )
    on conflict (provider, store_id, order_id)
    do update set
      sale_type_id = excluded.sale_type_id,
      shift_date = excluded.shift_date,
      created_at_source = coalesce(excluded.created_at_source, orders.created_at_source),
      updated_at_source = coalesce(excluded.updated_at_source, orders.updated_at_source),
      sale_number = excluded.sale_number,
      desc_sale = excluded.desc_sale,
      canceled = excluded.canceled,
      canceled_items_count = excluded.canceled_items_count,
      notes = excluded.notes,
      discount_reason = excluded.discount_reason,
      increase_reason = excluded.increase_reason,
      total_amount = excluded.total_amount,
      total_discount = excluded.total_discount,
      total_increase = excluded.total_increase,
      total_amount_items = excluded.total_amount_items,
      items_count = excluded.items_count,
      customer_id = excluded.customer_id,
      partner_sale_source = excluded.partner_sale_source,
      received_at = excluded.received_at,
      updated_at = now()
    returning id
    `,
    [
      args.provider,
      args.store_id,
      args.order_id,
      args.id_sale_type,
      args.shift_date,
      args.created_at_source,
      args.updated_at_source,
      args.sale_number,
      args.desc_sale,
      toBoolCanceled(args.canceled),
      args.count_canceled_items,
      args.notes,
      args.discount_reason,
      args.increase_reason,
      args.total_amount,
      args.total_discount,
      args.total_increase,
      args.total_amount_items,
      args.items_count,
      args.customer_id,
      args.partner_sale_source,
      args.received_at,
    ]
  );

  return Number(r.rows[0].id);
}

export async function replaceOrderDeliveryV2(orderRowId: number, delivery: any): Promise<void> {
  await pool.query(`delete from order_deliveries where order_row_id=$1`, [orderRowId]);
  if (!delivery) return;

  await pool.query(
    `
    insert into order_deliveries (
      order_row_id,
      delivery_fee, delivery_time, delivery_by,
      state, city, district, street, number, complement, reference, zipcode,
      raw_delivery,
      updated_at
    )
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb, now())
    `,
    [
      orderRowId,
      delivery.delivery_fee ?? null,
      delivery.delivery_time ?? null,
      delivery.delivery_by ?? null,
      delivery.state ?? null,
      delivery.city ?? null,
      delivery.district ?? null,
      delivery.street ?? null,
      delivery.number ?? null,
      delivery.complement ?? null,
      delivery.reference ?? null,
      delivery.zipcode ?? null,
      JSON.stringify(delivery),
    ]
  );
}

export async function replaceOrderPaymentsV2(orderRowId: number, payments: any[]): Promise<void> {
  await pool.query(`delete from order_payments where order_row_id=$1`, [orderRowId]);
  if (!Array.isArray(payments) || payments.length === 0) return;

  for (let i = 0; i < payments.length; i++) {
    const p = payments[i] ?? {};
    await pool.query(
      `
      insert into order_payments (
        order_row_id,
        idx,
        payment_amount,
        change_for,
        created_at_source,
        payment_type,
        raw_payment,
        updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7::jsonb, now())
      `,
      [
        orderRowId,
        i,
        p.payment_amount ?? null,
        p.change_for ?? null,
        p.created_at ?? null,
        p.desc_store_payment_type ?? null,
        JSON.stringify(p),
      ]
    );
  }
}

export async function replaceOrderItemsAndChoicesV2(args: {
  provider: string;
  store_id: string;
  order_id: string;
  items: any[];
}): Promise<void> {
  await pool.query(`delete from order_item_choices where provider=$1 and store_id=$2 and order_id=$3`, [
    args.provider,
    args.store_id,
    args.order_id,
  ]);
  await pool.query(`delete from order_items where provider=$1 and store_id=$2 and order_id=$3`, [
    args.provider,
    args.store_id,
    args.order_id,
  ]);

  if (!Array.isArray(args.items) || args.items.length === 0) return;

  for (let idx = 0; idx < args.items.length; idx++) {
    const it = args.items[idx] ?? {};
    const line = idx + 1;

    await pool.query(
      `
      insert into order_items (
        provider, store_id, order_id,
        line, name, integration_code, id_store_item, quantity, unit_price, deleted, raw_item,
        updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, now())
      `,
      [
        args.provider,
        args.store_id,
        args.order_id,
        line,
        it.desc_sale_item ?? it.name ?? null,
        it.integration_code ?? null,
        it.id_store_item != null ? String(it.id_store_item) : null,
        it.quantity != null ? Number(it.quantity) : null,
        it.unit_price != null ? Number(it.unit_price) : null,
        it.deleted ?? null,
        JSON.stringify(it),
      ]
    );

    const choices = Array.isArray(it.choice_items)
      ? it.choice_items
      : Array.isArray(it.choices)
        ? it.choices
        : [];
    for (let cidx = 0; cidx < choices.length; cidx++) {
      const ch = choices[cidx] ?? {};
      const choiceLine = cidx + 1;

      await pool.query(
        `
        insert into order_item_choices (
          provider, store_id, order_id,
          item_line, choice_line,
          name, quantity, unit_price, id_store_choice_item,
          raw_choice,
          updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, now())
        `,
        [
          args.provider,
          args.store_id,
          args.order_id,
          line,
          choiceLine,
          ch.desc_sale_item_choice ?? ch.desc_sale_item ?? ch.name ?? null,
          ch.quantity != null ? Number(ch.quantity) : 1,
          ch.unit_price != null
            ? Number(ch.unit_price)
            : ch.aditional_price != null
              ? Number(ch.aditional_price)
              : ch.additional_price != null
                ? Number(ch.additional_price)
                : null,
          ch.id_store_choice_item != null ? String(ch.id_store_choice_item) : null,
          JSON.stringify(ch),
        ]
      );
    }
  }
}
