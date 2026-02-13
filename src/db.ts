import { Pool } from "pg";
import { config } from "./config";

export const pool = new Pool({
  connectionString: config.databaseUrl,
});

export async function pingDb(): Promise<void> {
  const r = await pool.query("select now() as now");
  console.log("✅ DB OK:", r.rows[0].now);
}

export type InboxEvent = {
  id: number;
  provider: string;
  store_id: string;
  order_id: string;
  event: string;
  status: string;
  attempts: number;
  received_at: string;
  next_retry_at: string | null;
};

// Pega e “claim” do batch num passo só (SKIP LOCKED)
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
        last_error=$2
    where id=$1
  `,
    [id, errorMessage]
  );
}

export async function upsertOrdersRaw(args: {
  provider: string;
  store_id: string;
  order_id: string;
  status: string;
  received_at: string;
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

export async function upsertCustomer(args: {
  provider: string;
  external_id: string | null;
  name: string | null;
  phone: string | null;
  document_number: string | null;
}): Promise<number> {
  const r = await pool.query(
    `
    insert into customers (
      provider,
      external_id,
      name,
      phone,
      document_number
    )
    values ($1,$2,$3,$4,$5)

    on conflict (provider, external_id)
    do update set
      name = excluded.name,
      phone = excluded.phone,
      document_number = excluded.document_number,
      updated_at = now()

    returning id
    `,
    [
      args.provider,
      args.external_id,
      args.name,
      args.phone,
      args.document_number,
    ]
  );

  return r.rows[0].id;
}

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
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
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
      JSON.stringify(a)
    ]
  );

  return r.rows[0].id;
}

export async function pickRawForNormalize(limit: number) {
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
    select *
    from orders_raw
    where id in (select id from picked)
    `,
    [limit]
  );

  return r.rows;
}

export async function markRawNormalized(id: number) {
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

export async function markRawNormalizeError(id: number, error: string) {
  await pool.query(
    `
    update orders_raw
    set normalized = false
    where id = $1
    `,
    [id]
  );

  console.error("normalize error:", id, error);
}