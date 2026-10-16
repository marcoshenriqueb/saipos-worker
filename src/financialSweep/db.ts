import type { PoolClient } from "pg";
import { pool } from "../db";
import { MirrorRow, rowKey } from "./logic";

/** pg advisory lock key: only one sweep (scheduled or CLI) at a time. */
const SWEEP_LOCK_KEY = 7_424_014;

export async function tryAcquireSweepLock(): Promise<PoolClient | null> {
  const client = await pool.connect();
  try {
    const r = await client.query("select pg_try_advisory_lock($1) as ok", [SWEEP_LOCK_KEY]);
    if (r.rows[0]?.ok) return client;
  } catch (e) {
    client.release();
    throw e;
  }
  client.release();
  return null;
}

export async function releaseSweepLock(client: PoolClient): Promise<void> {
  try {
    await client.query("select pg_advisory_unlock($1)", [SWEEP_LOCK_KEY]);
  } finally {
    client.release();
  }
}

export async function insertSweep(args: { startedAt: Date; mode: string; forced: boolean }): Promise<number> {
  const r = await pool.query(
    `insert into financial_sweeps (started_at, mode, forced, status) values ($1, $2, $3, 'running') returning id`,
    [args.startedAt.toISOString(), args.mode, args.forced]
  );
  return Number(r.rows[0].id);
}

export async function finishSweep(
  id: number,
  f: {
    status: "complete" | "aborted" | "failed";
    rangeStart?: Date | null;
    rangeEnd?: Date | null;
    windowsTotal?: number;
    windowsOk?: number;
    windowsFailed?: number;
    rowsSeen?: number;
    rowsNew?: number;
    rowsInRange?: number;
    candidates?: number;
    markedMissing?: number;
    tombstoned?: number;
    cleared?: number;
    breakerLimit?: number | null;
    abortReason?: string | null;
    sample?: any;
  }
): Promise<void> {
  await pool.query(
    `
    update financial_sweeps set
      finished_at = now(),
      status = $2,
      range_start = $3, range_end = $4,
      windows_total = $5, windows_ok = $6, windows_failed = $7,
      rows_seen = $8, rows_new = $9, rows_in_range = $10, candidates = $11,
      marked_missing = $12, tombstoned = $13, cleared = $14,
      breaker_limit = $15, abort_reason = $16, sample = $17::jsonb
    where id = $1
    `,
    [
      id,
      f.status,
      f.rangeStart ? f.rangeStart.toISOString() : null,
      f.rangeEnd ? f.rangeEnd.toISOString() : null,
      f.windowsTotal ?? 0,
      f.windowsOk ?? 0,
      f.windowsFailed ?? 0,
      f.rowsSeen ?? 0,
      f.rowsNew ?? 0,
      f.rowsInRange ?? 0,
      f.candidates ?? 0,
      f.markedMissing ?? 0,
      f.tombstoned ?? 0,
      f.cleared ?? 0,
      f.breakerLimit ?? null,
      f.abortReason ?? null,
      f.sample == null ? null : JSON.stringify(f.sample),
    ]
  );
}

export async function getMaxKnownDate(): Promise<Date | null> {
  const r = await pool.query(`select max(date) as max_date from financial_transactions`);
  const v = r.rows[0]?.max_date;
  return v ? new Date(v) : null;
}

const toDate = (v: any): Date | null => (v == null ? null : new Date(v));

/** Mirror state used by the decision: raw row + normalized `date`. */
export async function loadMirror(): Promise<MirrorRow[]> {
  const r = await pool.query(
    `
    select r.id, r.store_id, r.financial_transaction_id,
           ft.date, r.missing_since, r.deleted_at_source, r.received_at
    from financial_transactions_raw r
    left join financial_transactions ft
      on ft.provider = r.provider
     and ft.store_id = r.store_id
     and ft.financial_transaction_id = r.financial_transaction_id
    where r.provider = 'saipos'
    `
  );
  return r.rows.map((x: any) => ({
    id: Number(x.id),
    key: rowKey(String(x.store_id), String(x.financial_transaction_id)),
    date: toDate(x.date),
    missingSince: toDate(x.missing_since),
    deletedAtSource: toDate(x.deleted_at_source),
    receivedAt: toDate(x.received_at),
  }));
}

/**
 * Writes strikes in one transaction. The WHERE clauses re-check the state so
 * a row received by any pass after the sweep started is never marked.
 */
export async function applyStrikes(args: {
  sweepStartedAt: Date;
  strike1Ids: number[];
  strike2Ids: number[];
  strike2Cutoff: Date;
}): Promise<{ markedMissing: number; tombstoned: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const s1 = await client.query(
      `
      update financial_transactions_raw
      set missing_since = $2
      where id = any($1::bigint[])
        and missing_since is null
        and deleted_at_source is null
        and received_at < $2
        and (last_swept_at is null or last_swept_at < $2)
      `,
      [args.strike1Ids, args.sweepStartedAt.toISOString()]
    );

    const s2 = await client.query(
      `
      with tomb as (
        update financial_transactions_raw
        set deleted_at_source = now()
        where id = any($1::bigint[])
          and missing_since is not null
          and missing_since <= $3
          and deleted_at_source is null
          and received_at < $2
          and (last_swept_at is null or last_swept_at < $2)
        returning provider, store_id, financial_transaction_id, deleted_at_source
      )
      update financial_transactions ft
      set deleted_at_source = tomb.deleted_at_source
      from tomb
      where ft.provider = tomb.provider
        and ft.store_id = tomb.store_id
        and ft.financial_transaction_id = tomb.financial_transaction_id
      `,
      [args.strike2Ids, args.sweepStartedAt.toISOString(), args.strike2Cutoff.toISOString()]
    );

    await client.query("COMMIT");
    return { markedMissing: s1.rowCount ?? 0, tombstoned: s2.rowCount ?? 0 };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
