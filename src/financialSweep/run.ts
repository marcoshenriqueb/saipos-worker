import { config } from "../config";
import { hasTombstoneSchema, upsertFinancialTransactionRaw } from "../db";
import { financialTransactionsAll } from "../saipos/dataApi";
import { fmtUtc, sleep } from "../utils/common";
import {
  applyStrikes,
  finishSweep,
  getMaxKnownDate,
  insertSweep,
  loadMirror,
  releaseSweepLock,
  tryAcquireSweepLock,
} from "./db";
import {
  buildWindows,
  computeSweepRange,
  MirrorRow,
  nextRunAt,
  planSweep,
  readWindow,
  SweepConfig,
  WindowResult,
} from "./logic";

const SAMPLE_SIZE = 50;

function sampleOf(rows: MirrorRow[]) {
  return rows.slice(0, SAMPLE_SIZE).map((m) => ({
    raw_id: m.id,
    key: m.key,
    date: m.date?.toISOString().slice(0, 10) ?? null,
    missing_since: m.missingSince?.toISOString() ?? null,
  }));
}

/**
 * One full financial sweep. dry_run reads the API and the mirror and records
 * what it WOULD do in financial_sweeps (no writes to raw/normalized tables).
 * apply upserts the rows seen and writes strikes.
 */
export async function runFinancialSweep(opts: {
  mode: "dry_run" | "apply";
  force?: boolean;
  cfg?: SweepConfig;
}): Promise<{ sweepId: number | null; status: string }> {
  const cfg = opts.cfg ?? config.financialSweep;
  const force = Boolean(opts.force);
  const tag = `🧹 Financial sweep [${opts.mode}${force ? ",force" : ""}]`;

  if (!(await hasTombstoneSchema())) {
    console.error(`${tag} skipped: migration 0014_financial_tombstones not applied`);
    return { sweepId: null, status: "skipped" };
  }

  const lock = await tryAcquireSweepLock();
  if (!lock) {
    console.warn(`${tag} skipped: another sweep is running`);
    return { sweepId: null, status: "skipped" };
  }

  const sweepStartedAt = new Date();
  let sweepId: number | null = null;

  try {
    sweepId = await insertSweep({ startedAt: sweepStartedAt, mode: opts.mode, forced: force });

    const range = computeSweepRange({
      rangeStart: cfg.rangeStart,
      maxKnownDate: await getMaxKnownDate(),
      now: sweepStartedAt,
      forwardDays: cfg.forwardDays,
    });
    const windows = buildWindows(range.start, range.endExclusive);
    console.log(
      `${tag} #${sweepId} range ${range.start.toISOString().slice(0, 10)}..${range.endExclusive
        .toISOString()
        .slice(0, 10)} (${windows.length} windows)`
    );

    const results: WindowResult[] = [];
    for (const w of windows) {
      const res = await readWindow(
        w,
        (win) =>
          financialTransactionsAll({
            p_date_column_filter: "date",
            p_filter_date_start: fmtUtc(win.start),
            p_filter_date_end: fmtUtc(win.end),
            p_limit: 300,
            maxPages: cfg.maxPagesPerWindow,
          }),
        { attempts: cfg.windowAttempts, backoffMs: cfg.windowBackoffMs, sleep }
      );
      results.push(res);
      if (!res.ok) {
        console.error(`${tag} window ${fmtUtc(w.start)}..${fmtUtc(w.end)} FAILED after ${res.attempts}: ${res.error}`);
        // All-or-nothing: no point reading further.
        break;
      }
      if (cfg.sleepBetweenWindowsMs > 0) await sleep(cfg.sleepBetweenWindowsMs);
    }
    // Windows not attempted after a failure count as failed too.
    for (const w of windows.slice(results.length)) {
      results.push({ window: w, ok: false, error: "not attempted (earlier window failed)", attempts: 0 });
    }

    const mirror = await loadMirror();
    const plan = planSweep({
      windows: results,
      mirror,
      sweepStartedAt,
      candidateStart: range.candidateStart,
      candidateEnd: range.candidateEnd,
      breakerMin: cfg.breakerMin,
      breakerPct: cfg.breakerPct,
      minStrikeGapMs: cfg.minStrikeGapMs,
      force,
    });

    console.log(
      `${tag} #${sweepId} windows ok=${plan.windowsOk}/${plan.windowsTotal} seen=${plan.rowsSeen} new=${plan.rowsNew} ` +
        `inRange=${plan.rowsInRange} candidates=${plan.candidates.length} (limit ${plan.breakerLimit}) ` +
        `strike1=${plan.strike1.length} strike2=${plan.strike2.length} clear=${plan.clear.length}` +
        (plan.abortReason ? ` | ABORT: ${plan.abortReason}` : "")
    );
    if (plan.candidates.length > 0) {
      console.log(`${tag} #${sweepId} candidate sample:`, JSON.stringify(sampleOf(plan.candidates)));
    }

    let markedMissing = plan.strike1.length;
    let tombstoned = plan.strike2.length;
    let cleared = plan.clear.length;

    if (opts.mode === "apply") {
      if (plan.windowsFailed === 0) {
        // Upsert every row seen (clears missing_since/deleted_at_source).
        const receivedAtIso = new Date().toISOString();
        for (const row of plan.seen) {
          await upsertFinancialTransactionRaw({
            provider: "saipos",
            store_id: row.storeId,
            financial_transaction_id: row.financialTransactionId,
            received_at: receivedAtIso,
            payload: row.payload,
            last_swept_at: sweepStartedAt.toISOString(),
          });
        }
      }
      if (plan.status === "complete") {
        const r = await applyStrikes({
          sweepStartedAt,
          strike1Ids: plan.strike1.map((m) => m.id),
          strike2Ids: plan.strike2.map((m) => m.id),
          strike2Cutoff: new Date(sweepStartedAt.getTime() - cfg.minStrikeGapMs),
        });
        markedMissing = r.markedMissing;
        tombstoned = r.tombstoned;
      } else {
        markedMissing = 0;
        tombstoned = 0;
      }
      if (plan.windowsFailed > 0) cleared = 0;
    } else if (plan.status !== "complete") {
      // dry_run: report what apply would do.
      markedMissing = 0;
      tombstoned = 0;
    }

    await finishSweep(sweepId, {
      status: plan.status,
      rangeStart: range.start,
      rangeEnd: range.endExclusive,
      windowsTotal: plan.windowsTotal,
      windowsOk: plan.windowsOk,
      windowsFailed: plan.windowsFailed,
      rowsSeen: plan.rowsSeen,
      rowsNew: plan.rowsNew,
      rowsInRange: plan.rowsInRange,
      candidates: plan.candidates.length,
      markedMissing,
      tombstoned,
      cleared,
      breakerLimit: plan.breakerLimit,
      abortReason: plan.abortReason,
      sample: sampleOf(plan.candidates),
    });

    const level = plan.status === "complete" ? console.log : console.error;
    level(
      `${tag} #${sweepId} ${plan.status}: marked_missing=${markedMissing} tombstoned=${tombstoned} cleared=${cleared}` +
        (opts.mode === "dry_run" ? " (dry_run: nothing written)" : "")
    );
    return { sweepId, status: plan.status };
  } catch (e: any) {
    const msg = String(e?.message || e);
    console.error(`${tag} #${sweepId ?? "?"} failed:`, msg);
    if (sweepId != null) {
      await finishSweep(sweepId, { status: "failed", abortReason: msg }).catch((err) =>
        console.error(`${tag} could not record failure:`, err?.message || err)
      );
    }
    return { sweepId, status: "failed" };
  } finally {
    await releaseSweepLock(lock);
  }
}

/** Daily schedule inside the worker process. */
export async function runFinancialSweepScheduler(): Promise<void> {
  const cfg = config.financialSweep;
  if (cfg.mode === "off") {
    console.log("🧹 Financial sweep disabled (FINANCIAL_SWEEP_MODE=off).");
    return;
  }
  if (config.financialWorkerMode !== "ingest") {
    console.log("🧹 Financial sweep not scheduled: FINANCIAL_WORKER_MODE is not 'ingest'.");
    return;
  }

  const hhmm = `${String(cfg.at.hour).padStart(2, "0")}:${String(cfg.at.minute).padStart(2, "0")}`;
  while (true) {
    try {
      const next = nextRunAt(new Date(), cfg.at.hour, cfg.at.minute, cfg.timeZone);
      console.log(`🧹 Financial sweep (${cfg.mode}) next run at ${next.toISOString()} (${hhmm} ${cfg.timeZone})`);
      await sleep(Math.max(0, next.getTime() - Date.now()));
      await runFinancialSweep({ mode: cfg.mode === "apply" ? "apply" : "dry_run" });
    } catch (e: any) {
      console.error("❌ Financial sweep scheduler error:", e?.message || e);
      await sleep(60_000);
    }
  }
}
