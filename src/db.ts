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
 * events_inbox row (worker ingest loop)
 */
export type InboxEvent = {
  id: number;
  provider: string;
  store_id: string;
  order_id: string;
  event: string;
  status: string;
  attempts: number;
  received_at: string; // timestamptz
  next_retry_at: string | null;
};

/**
 * Pick + claim a batch of events in one statement (SKIP LOCKED)
 */
export async function pickEvents(batchSize: number): Promise<InboxEvent[]> {
  const sql = `
    with picked as (
      select id
      from events_inbox
      where
        status in ('pending','error')
        and (next_retry_at is null or next_retry_at <= now())
      order by received_at asc
      limit $1
      for update skip locked
    )
    update events_inbox e
    set status='processing',
        processing_started_at=now(),
        attempts = attempts + 1
    from picked
    where e.id = picked.id
    returning
      e.id, e.provider, e.store_id, e.order_id, e.event, e.status, e.attempts, e.received_at, e.next_retry_at
  `;
  const r = await pool.query(sql, [batchSize]);
  return r.rows as InboxEvent[];
}

export async function markDone(id: number): Promise<void> {
  await pool.query(
    `
    update events_inbox
    set status='done',
        processing_started_at=null,
        last_error=null,
        next_retry_at=null
    where id=$1
    `,
    [id]
  );
}

export async function markError(id: number, errorMessage: string, nextRetryAt: Date | null): Promise<void> {
  await pool.query(
    `
    update events_inbox
    set status='error',
        processing_started_at=null,
        last_error=$2,
        next_retry_at=$3
    where id=$1
    `,
    [id, errorMessage, nextRetryAt]
  );
}

export async function markDead(id: number, errorMessage: string): Promise<void> {
  await pool.query(
    `
    update events_inbox
    set status='dead',
        processing_started_at=null,
        last_error=$2,
        next_retry_at=null
    where id=$1
    `,
    [id, errorMessage]
  );
}

/**
 * orders_raw upsert (immutable-ish snapshot for reprocessing)
 */
export async function upsertOrdersRaw(args: {
  provider: string;
  store_id: string;
  order_id: string;
  status: string | null;
  received_at: string; // timestamptz string
  payload: any;
}): Promise<void> {
  await pool.query(
    `
    insert into orders_raw (provider, store_id, order_id, status, received_at, payload)
    values ($1,$2,$3,$4,$5,$6::jsonb)
    on conflict (provider, store_id, order_id)
    do update set
      status = excluded.status,
      received_at = excluded.received_at,
      payload = excluded.payload
    `,
    [args.provider, args.store_id, args.order_id, args.status, args.received_at, JSON.stringify(args.payload)]
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
      on conflict on constraint ux_customers_document
      do update set
        provider = excluded.provider,
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
 * addresses (simple insert, no dedupe for now)
 */
export async function insertAddress(args: {
  customer_id: number;
  raw_address: any;
}): Promise<number | null> {
  const a = args.raw_address;
  if (!a) return null;

  const r = await pool.query(
    `
    insert into addresses (
      customer_id,
      street,
      number,
      district,
      city,
      state,
      postal_code,
      country,
      raw_address
    )
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    returning id
    `,
    [
      args.customer_id,
      a.street_name ?? null,
      a.street_number ?? null,
      a.district ?? null,
      a.city ?? null,
      a.state ?? null,
      a.postal_code ?? null,
      a.country ?? null,
      JSON.stringify(a),
    ]
  );

  return Number(r.rows[0].id);
}

/**
 * Normalizer: pick raw orders that are not normalized yet (SKIP LOCKED)
 * Note: We return only columns needed by normalizer (id/provider/store_id/order_id/status/received_at/payload).
 */
export type OrdersRawRow = {
  id: number;
  provider: string;
  store_id: string;
  order_id: string;
  status: string | null;
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
      order by received_at asc
      limit $1
      for update skip locked
    )
    select r.id, r.provider, r.store_id, r.order_id, r.status, r.received_at, r.payload
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
    set normalized = true,
        normalized_at = now()
    where id = $1
    `,
    [id]
  );
}

export async function markRawNormalizeError(id: number, error: string): Promise<void> {
  // keep normalized=false so it can be retried later; just log for now
  console.error("normalize error:", id, error);
}

/**
 * orders (normalized BI table)
 */
export async function upsertOrderNormalized(args: {
  provider: string;
  store_id: string;
  order_id: string;
  status: string | null;
  received_at: string; // timestamptz
  created_at: string | null; // timestamptz

  // FK refs
  customer_id: number | null;
  address_id: number | null;

  // dims
  order_mode: string | null;

  // attrs
  customer_name: string | null;
  notes: string | null;

  // money
  total_value: number | null;
  total_items_value: number | null; // valor total dos itens
  total_discount: number | null;
  total_increase: number | null;

  // reasons
  discount_reason: string | null;
  increase_reason: string | null;

  // counts
  items_count: number | null;
}): Promise<void> {
  await pool.query(
    `
    insert into orders (
      provider, store_id, order_id,
      status,
      created_at, received_at, updated_at,
      customer_id, address_id,
      order_mode,
      customer_name, notes,
      total_value, total_items_value, total_discount, total_increase,
      discount_reason, increase_reason,
      items_count
    )
    values (
      $1,$2,$3,
      $4,
      $5,$6, now(),
      $7,$8,
      $9,
      $10,$11,
      $12,$13,$14,$15,
      $16,$17,
      $18
    )
    on conflict (provider, store_id, order_id)
    do update set
      status = excluded.status,
      created_at = coalesce(excluded.created_at, orders.created_at),
      received_at = excluded.received_at,
      updated_at = now(),
      customer_id = excluded.customer_id,
      address_id = excluded.address_id,
      order_mode = excluded.order_mode,
      customer_name = excluded.customer_name,
      notes = excluded.notes,
      total_value = excluded.total_value,
      total_items_value = excluded.total_items_value,
      total_discount = excluded.total_discount,
      total_increase = excluded.total_increase,
      discount_reason = excluded.discount_reason,
      increase_reason = excluded.increase_reason,
      items_count = excluded.items_count
    `,
    [
      args.provider,
      args.store_id,
      args.order_id,
      args.status,
      args.created_at,
      args.received_at,
      args.customer_id,
      args.address_id,
      args.order_mode,
      args.customer_name,
      args.notes,
      args.total_value,
      args.total_items_value,
      args.total_discount,
      args.total_increase,
      args.discount_reason,
      args.increase_reason,
      args.items_count,
    ]
  );
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
    on conflict (provider, store_id, order_id, line)
    do update set
      name = excluded.name,
      integration_code = excluded.integration_code,
      quantity = excluded.quantity,
      unit_price = excluded.unit_price,
      deleted = excluded.deleted,
      raw_item = excluded.raw_item
    `,
    values
  );
}