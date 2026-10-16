/**
 * Pure decision logic for the daily financial deletion sweep.
 *
 * No config / DB / HTTP imports here: everything is passed in, so the rules
 * (window completeness, two strikes, clear-on-reappear, circuit breaker) are
 * unit-testable. See docs/2026-10-16-deletion-propagation-design.md §3.
 */

import { NullResponseError } from "../saipos/paginate";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const SAIPOS_MAX_WINDOW_DAYS = 15;

export type SweepMode = "off" | "dry_run" | "apply";

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

export type SweepConfig = {
  mode: SweepMode;
  /** Local time of the daily run, "HH:MM". */
  at: { hour: number; minute: number };
  timeZone: string;
  /** First `date` covered by the sweep (UTC midnight). */
  rangeStart: Date;
  /** Range end = max(known date, now) + forwardDays. */
  forwardDays: number;
  sleepBetweenWindowsMs: number;
  windowAttempts: number;
  windowBackoffMs: number[];
  breakerMin: number;
  breakerPct: number;
  /** Strike 2 needs missing_since to be at least this old (different sweep, different day). */
  minStrikeGapMs: number;
  maxPagesPerWindow: number;
};

export function parseSweepMode(v: string | undefined, fallback: SweepMode = "dry_run"): SweepMode {
  const s = (v ?? "").trim();
  if (!s) return fallback;
  if (s === "off" || s === "dry_run" || s === "apply") return s;
  throw new Error(`Invalid FINANCIAL_SWEEP_MODE=${v} (expected off|dry_run|apply)`);
}

function envNum(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const v = env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number env var: ${name}=${v}`);
  return n;
}

export function parseSweepConfig(env: Record<string, string | undefined>): SweepConfig {
  const atStr = (env.FINANCIAL_SWEEP_AT || "04:30").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(atStr);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new Error(`Invalid FINANCIAL_SWEEP_AT=${atStr} (expected HH:MM)`);
  }

  const timeZone = (env.FINANCIAL_SWEEP_TZ || "America/Sao_Paulo").trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(`Invalid FINANCIAL_SWEEP_TZ=${timeZone}`);
  }

  const rangeStartStr = (env.FINANCIAL_SWEEP_RANGE_START || "2025-09-01").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rangeStartStr)) {
    throw new Error(`Invalid FINANCIAL_SWEEP_RANGE_START=${rangeStartStr} (expected YYYY-MM-DD)`);
  }

  return {
    mode: parseSweepMode(env.FINANCIAL_SWEEP_MODE),
    at: { hour: Number(m[1]), minute: Number(m[2]) },
    timeZone,
    rangeStart: new Date(`${rangeStartStr}T00:00:00.000Z`),
    forwardDays: envNum(env, "FINANCIAL_SWEEP_FORWARD_DAYS", 31),
    sleepBetweenWindowsMs: envNum(env, "FINANCIAL_SWEEP_SLEEP_MS", 400),
    windowAttempts: 5,
    windowBackoffMs: [15_000, 30_000, 45_000, 60_000],
    breakerMin: envNum(env, "FINANCIAL_SWEEP_BREAKER_MIN", 50),
    breakerPct: envNum(env, "FINANCIAL_SWEEP_BREAKER_PCT", 5),
    minStrikeGapMs: envNum(env, "FINANCIAL_SWEEP_MIN_STRIKE_GAP_HOURS", 20) * 60 * 60 * 1000,
    maxPagesPerWindow: 100,
  };
}

// ---------------------------------------------------------------------------
// Range and windows
// ---------------------------------------------------------------------------

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Sweep range: [rangeStart, startOfDay(max(maxKnownDate, now)) + forwardDays + 1d).
 * Candidate range (rows that may be marked): one day inside each edge.
 */
export function computeSweepRange(args: {
  rangeStart: Date;
  maxKnownDate: Date | null;
  now: Date;
  forwardDays: number;
}): { start: Date; endExclusive: Date; candidateStart: Date; candidateEnd: Date } {
  const anchor =
    args.maxKnownDate && args.maxKnownDate.getTime() > args.now.getTime() ? args.maxKnownDate : args.now;
  const start = startOfUtcDay(args.rangeStart);
  const endExclusive = new Date(startOfUtcDay(anchor).getTime() + (Math.floor(args.forwardDays) + 1) * DAY_MS);
  return {
    start,
    endExclusive,
    candidateStart: new Date(start.getTime() + DAY_MS),
    candidateEnd: new Date(endExclusive.getTime() - DAY_MS),
  };
}

export type SweepWindow = { start: Date; end: Date };

/** Contiguous windows of `windowDays`; each ends 1s before the next starts. */
export function buildWindows(start: Date, endExclusive: Date, windowDays = SAIPOS_MAX_WINDOW_DAYS): SweepWindow[] {
  if (windowDays <= 0 || windowDays > SAIPOS_MAX_WINDOW_DAYS) {
    throw new Error(`windowDays must be in (0, ${SAIPOS_MAX_WINDOW_DAYS}]`);
  }
  const out: SweepWindow[] = [];
  for (let cur = start.getTime(); cur < endExclusive.getTime(); ) {
    const next = Math.min(cur + windowDays * DAY_MS, endExclusive.getTime());
    out.push({ start: new Date(cur), end: new Date(next - 1000) });
    cur = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Window reading
// ---------------------------------------------------------------------------

export function rowKey(storeId: string, financialTransactionId: string): string {
  return `${storeId}|${financialTransactionId}`;
}

export type SeenRow = { key: string; storeId: string; financialTransactionId: string; payload: any };

/** Window rows must all carry ids; otherwise the window is not trustworthy. */
export function keyWindowRows(rows: any[]): SeenRow[] {
  if (!Array.isArray(rows)) throw new Error("window rows is not an array");
  return rows.map((row, i) => {
    const storeId = row?.id_store != null ? String(row.id_store) : "";
    const ftId = row?.id_store_fin_transaction != null ? String(row.id_store_fin_transaction) : "";
    if (!storeId || !ftId) {
      throw new Error(`row ${i} without id_store/id_store_fin_transaction`);
    }
    return { key: rowKey(storeId, ftId), storeId, financialTransactionId: ftId, payload: row };
  });
}

export type WindowResult =
  | { window: SweepWindow; ok: true; rows: SeenRow[]; attempts: number; emptyByNull?: boolean }
  | { window: SweepWindow; ok: false; error: string; attempts: number };

/**
 * Reads one window with retries. Never throws: a window that does not fully
 * succeed (exception, non-array, page limit, row without ids) is ok=false.
 */
export async function readWindow(
  window: SweepWindow,
  fetchWindow: (w: SweepWindow) => Promise<any[]>,
  opts: {
    attempts: number;
    backoffMs: number[];
    sleep: (ms: number) => Promise<void>;
    /**
     * Number of mirror rows dated inside the window. Only consulted when the
     * API answered `null` on every attempt: null is then a complete EMPTY
     * window iff this is 0; otherwise (or if the check throws) it stays a
     * failure. Without this option null is always a failure.
     */
    mirrorRowsInWindow?: (w: SweepWindow) => Promise<number>;
  }
): Promise<WindowResult> {
  let lastError = "";
  let lastWasNull = false;
  const attempts = Math.max(1, Math.floor(opts.attempts));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      const wait = opts.backoffMs[Math.min(attempt - 2, opts.backoffMs.length - 1)] ?? 0;
      if (wait > 0) await opts.sleep(wait);
    }
    try {
      const rows = keyWindowRows(await fetchWindow(window));
      return { window, ok: true, rows, attempts: attempt };
    } catch (e: any) {
      lastError = String(e?.message || e);
      lastWasNull = e instanceof NullResponseError;
    }
  }
  if (lastWasNull && opts.mirrorRowsInWindow) {
    try {
      const n = await opts.mirrorRowsInWindow(window);
      if (n === 0) return { window, ok: true, rows: [], attempts, emptyByNull: true };
      lastError = `${lastError}; mirror has ${n} row(s) in this window, so null is not accepted as empty`;
    } catch (e: any) {
      lastError = `${lastError}; mirror check failed: ${String(e?.message || e)}`;
    }
  }
  return { window, ok: false, error: lastError, attempts };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type MirrorRow = {
  id: number;
  key: string;
  /** financial_transactions.date (null if never normalized → never a candidate). */
  date: Date | null;
  missingSince: Date | null;
  deletedAtSource: Date | null;
  /** Last time any pass (2-min passes, backfill, sweep) received the row. */
  receivedAt: Date | null;
};

export type SweepPlan = {
  status: "complete" | "aborted";
  abortReason: string | null;
  windowsTotal: number;
  windowsOk: number;
  windowsFailed: number;
  /** Windows accepted as empty because the API returned null and the mirror had no rows there. */
  windowsEmptyNull: number;
  rowsSeen: number;
  rowsNew: number;
  rowsInRange: number;
  breakerLimit: number;
  breakerTripped: boolean;
  /** Live mirror rows in the candidate range that the API did not return. */
  candidates: MirrorRow[];
  /** Strike 1: set missing_since. */
  strike1: MirrorRow[];
  /** Strike 2: set deleted_at_source (raw + normalized). */
  strike2: MirrorRow[];
  /** Seen again: clear missing_since / deleted_at_source (and renormalize). */
  clear: MirrorRow[];
  /** Seen rows (deduped by key), to be upserted in apply mode. */
  seen: SeenRow[];
};

export function planSweep(input: {
  windows: WindowResult[];
  mirror: MirrorRow[];
  sweepStartedAt: Date;
  candidateStart: Date;
  candidateEnd: Date;
  breakerMin: number;
  breakerPct: number;
  minStrikeGapMs: number;
  force?: boolean;
}): SweepPlan {
  const windowsTotal = input.windows.length;
  const failed = input.windows.filter((w) => !w.ok);
  const windowsOk = windowsTotal - failed.length;

  const seenMap = new Map<string, SeenRow>();
  for (const w of input.windows) {
    if (!w.ok) continue;
    for (const r of w.rows) seenMap.set(r.key, r);
  }
  const seen = [...seenMap.values()];
  const mirrorKeys = new Set(input.mirror.map((m) => m.key));
  const rowsNew = seen.filter((s) => !mirrorKeys.has(s.key)).length;

  const empty = {
    windowsTotal,
    windowsOk,
    windowsFailed: failed.length,
    windowsEmptyNull: input.windows.filter((w) => w.ok && w.emptyByNull).length,
    rowsSeen: seen.length,
    rowsNew,
  };

  // All-or-nothing: an incomplete read must never mark or clear anything.
  if (windowsTotal === 0 || failed.length > 0) {
    const reason =
      windowsTotal === 0
        ? "no windows to read"
        : `${failed.length}/${windowsTotal} window(s) failed; first: ` +
          `${failed[0].window.start.toISOString()}..${failed[0].window.end.toISOString()}: ${(failed[0] as any).error}`;
    return {
      status: "aborted",
      abortReason: reason,
      ...empty,
      rowsInRange: 0,
      breakerLimit: 0,
      breakerTripped: false,
      candidates: [],
      strike1: [],
      strike2: [],
      clear: [],
      seen: [],
    };
  }

  const startedMs = input.sweepStartedAt.getTime();
  const isSeen = (m: MirrorRow) =>
    seenMap.has(m.key) || (m.receivedAt != null && m.receivedAt.getTime() >= startedMs);

  const clear = input.mirror.filter((m) => seenMap.has(m.key) && (m.missingSince != null || m.deletedAtSource != null));

  const inRange = input.mirror.filter(
    (m) =>
      m.deletedAtSource == null &&
      m.date != null &&
      m.date.getTime() >= input.candidateStart.getTime() &&
      m.date.getTime() <= input.candidateEnd.getTime()
  );
  const candidates = inRange.filter((m) => !isSeen(m));

  const breakerLimit = Math.max(input.breakerMin, Math.ceil((input.breakerPct / 100) * inRange.length));
  const breakerTripped = candidates.length > breakerLimit;

  if (breakerTripped && !input.force) {
    return {
      status: "aborted",
      abortReason: `circuit breaker: ${candidates.length} candidates > limit ${breakerLimit} (max(${input.breakerMin}, ${input.breakerPct}% of ${inRange.length})); rerun manually with --force after review`,
      ...empty,
      rowsInRange: inRange.length,
      breakerLimit,
      breakerTripped,
      candidates,
      strike1: [],
      strike2: [],
      // The read was complete, so rows seen alive are still revived.
      clear,
      seen,
    };
  }

  const strike1 = candidates.filter((m) => m.missingSince == null);
  const strike2 = candidates.filter(
    (m) => m.missingSince != null && m.missingSince.getTime() <= startedMs - input.minStrikeGapMs
  );

  return {
    status: "complete",
    abortReason: null,
    ...empty,
    rowsInRange: inRange.length,
    breakerLimit,
    breakerTripped,
    candidates,
    strike1,
    strike2,
    clear,
    seen,
  };
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

function zonedParts(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}

function tzOffsetMs(d: Date, timeZone: string): number {
  const p = zonedParts(d, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** Next instant strictly after `now` whose wall-clock time in `timeZone` is hour:minute. */
export function nextRunAt(now: Date, hour: number, minute: number, timeZone: string): Date {
  const p = zonedParts(now, timeZone);
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const localAsUtc = Date.UTC(p.y, p.m - 1, p.d + dayOffset, hour, minute, 0);
    let guess = localAsUtc - tzOffsetMs(now, timeZone);
    guess = localAsUtc - tzOffsetMs(new Date(guess), timeZone);
    if (guess > now.getTime()) return new Date(guess);
  }
  throw new Error("nextRunAt: could not compute next run");
}
