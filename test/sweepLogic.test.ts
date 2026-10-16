import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWindows,
  computeSweepRange,
  DAY_MS,
  keyWindowRows,
  MirrorRow,
  nextRunAt,
  parseSweepConfig,
  planSweep,
  readWindow,
  rowKey,
  SweepWindow,
  WindowResult,
} from "../src/financialSweep/logic";

const T0 = new Date("2026-10-16T07:30:00Z"); // sweep start
const HOUR = 60 * 60 * 1000;
const W: SweepWindow = { start: new Date("2026-01-01T00:00:00Z"), end: new Date("2026-01-15T23:59:59Z") };

function apiRow(store: string, id: string) {
  return { id_store: store, id_store_fin_transaction: id, amount: -1 };
}

function okWindow(...ids: string[]): WindowResult {
  return { window: W, ok: true, attempts: 1, rows: keyWindowRows(ids.map((id) => apiRow("1", id))) };
}

function failedWindow(error = "DATA API HTTP 504"): WindowResult {
  return { window: W, ok: false, attempts: 5, error };
}

let nextId = 1;
function mirrorRow(id: string, o: Partial<MirrorRow> = {}): MirrorRow {
  return {
    id: nextId++,
    key: rowKey("1", id),
    date: new Date("2026-01-05T00:00:00Z"),
    missingSince: null,
    deletedAtSource: null,
    receivedAt: new Date(T0.getTime() - 3 * DAY_MS),
    ...o,
  };
}

function plan(windows: WindowResult[], mirror: MirrorRow[], extra: Partial<Parameters<typeof planSweep>[0]> = {}) {
  return planSweep({
    windows,
    mirror,
    sweepStartedAt: T0,
    candidateStart: new Date("2025-09-02T00:00:00Z"),
    candidateEnd: new Date("2030-01-01T00:00:00Z"),
    breakerMin: 50,
    breakerPct: 5,
    minStrikeGapMs: 20 * HOUR,
    ...extra,
  });
}

const ids = (rows: MirrorRow[]) => rows.map((r) => r.key.split("|")[1]).sort();

// --- strikes --------------------------------------------------------------

test("first complete miss → strike 1 only (missing_since), no tombstone", () => {
  const p = plan([okWindow("a")], [mirrorRow("a"), mirrorRow("gone")]);
  assert.equal(p.status, "complete");
  assert.deepEqual(ids(p.candidates), ["gone"]);
  assert.deepEqual(ids(p.strike1), ["gone"]);
  assert.deepEqual(p.strike2, []);
});

test("second later complete miss → strike 2 (tombstone)", () => {
  const p = plan(
    [okWindow("a")],
    [mirrorRow("a"), mirrorRow("gone", { missingSince: new Date(T0.getTime() - DAY_MS) })]
  );
  assert.deepEqual(p.strike1, []);
  assert.deepEqual(ids(p.strike2), ["gone"]);
});

test("strike 2 needs the first miss to be older than the min gap (not the same day)", () => {
  const p = plan(
    [okWindow("a")],
    [mirrorRow("a"), mirrorRow("gone", { missingSince: new Date(T0.getTime() - 2 * HOUR) })]
  );
  assert.deepEqual(ids(p.candidates), ["gone"]);
  assert.deepEqual(p.strike1, []);
  assert.deepEqual(p.strike2, []);
});

test("already tombstoned and still missing → not a candidate again", () => {
  const p = plan([okWindow("a")], [mirrorRow("a"), mirrorRow("dead", { deletedAtSource: new Date("2026-10-01") })]);
  assert.deepEqual(p.candidates, []);
  assert.deepEqual(p.clear, []);
});

// --- clear on reappear ----------------------------------------------------

test("row seen again clears missing_since and deleted_at_source", () => {
  const p = plan(
    [okWindow("back1", "back2", "fine")],
    [
      mirrorRow("back1", { missingSince: new Date("2026-10-10") }),
      mirrorRow("back2", { missingSince: new Date("2026-10-10"), deletedAtSource: new Date("2026-10-11") }),
      mirrorRow("fine"),
    ]
  );
  assert.equal(p.status, "complete");
  assert.deepEqual(ids(p.clear), ["back1", "back2"]);
  assert.deepEqual(p.candidates, []);
});

test("row received by a short pass after the sweep started is treated as alive", () => {
  const p = plan(
    [okWindow("a")],
    [mirrorRow("a"), mirrorRow("racing", { receivedAt: new Date(T0.getTime() + 1000) })]
  );
  assert.deepEqual(p.candidates, []);
});

// --- all-or-nothing -------------------------------------------------------

test("any failed window aborts: nothing marked, nothing cleared", () => {
  const p = plan(
    [okWindow("a"), failedWindow()],
    [
      mirrorRow("a", { missingSince: new Date("2026-10-10") }),
      mirrorRow("gone"),
      mirrorRow("gone2", { missingSince: new Date("2026-10-01") }),
    ]
  );
  assert.equal(p.status, "aborted");
  assert.match(p.abortReason!, /1\/2 window\(s\) failed/);
  assert.deepEqual(p.strike1, []);
  assert.deepEqual(p.strike2, []);
  assert.deepEqual(p.clear, []);
  assert.deepEqual(p.seen, []);
  assert.equal(p.windowsFailed, 1);
});

test("zero windows aborts", () => {
  const p = plan([], [mirrorRow("a")]);
  assert.equal(p.status, "aborted");
  assert.deepEqual(p.strike1, []);
});

test("readWindow: window failing after all retries → ok=false (never throws)", async () => {
  let calls = 0;
  const waits: number[] = [];
  const r = await readWindow(
    W,
    async () => {
      calls++;
      throw new Error("DATA API HTTP 504: PGRST003");
    },
    { attempts: 5, backoffMs: [15_000, 30_000, 45_000, 60_000], sleep: async (ms) => void waits.push(ms) }
  );
  assert.equal(r.ok, false);
  assert.equal(calls, 5);
  assert.deepEqual(waits, [15_000, 30_000, 45_000, 60_000]);
});

test("readWindow: transient failure then success → ok", async () => {
  let calls = 0;
  const r = await readWindow(
    W,
    async () => {
      if (++calls === 1) throw new Error("timeout");
      return [apiRow("1", "x")];
    },
    { attempts: 5, backoffMs: [1], sleep: async () => undefined }
  );
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
});

test("readWindow: row without ids makes the window fail", async () => {
  const r = await readWindow(W, async () => [apiRow("1", "x"), { id_store: "1" }], {
    attempts: 2,
    backoffMs: [0],
    sleep: async () => undefined,
  });
  assert.equal(r.ok, false);
});

test("readWindow: page limit / non-array errors from the client fail the window", async () => {
  for (const msg of ["page limit hit: 100 full pages", "unexpected non-array response: {}"]) {
    const r = await readWindow(
      W,
      async () => {
        throw new Error(msg);
      },
      { attempts: 2, backoffMs: [0], sleep: async () => undefined }
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /page limit|non-array/);
  }
});

// --- null response (API returns null for a window with no rows) ----------

import { NullResponseError } from "../src/saipos/paginate";

const nullOpts = (n: number | (() => never)) => ({
  attempts: 2,
  backoffMs: [0],
  sleep: async () => undefined,
  mirrorRowsInWindow: async () => (typeof n === "number" ? n : n()),
});

test("readWindow: null + no mirror rows in window → complete empty window", async () => {
  const r = await readWindow(W, async () => { throw new NullResponseError(); }, nullOpts(0));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.rows.length, 0);
    assert.equal(r.emptyByNull, true);
  }
});

test("readWindow: null + mirror has rows in window → failure (abort)", async () => {
  const r = await readWindow(W, async () => { throw new NullResponseError(); }, nullOpts(3));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /mirror has 3 row/);
  const plan = planSweep({
    windows: [r],
    mirror: [],
    sweepStartedAt: T0,
    candidateStart: new Date("2025-01-01Z"),
    candidateEnd: new Date("2027-01-01Z"),
    breakerMin: 50,
    breakerPct: 5,
    minStrikeGapMs: 20 * HOUR,
  });
  assert.equal(plan.status, "aborted");
  assert.equal(plan.strike1.length + plan.strike2.length, 0);
});

test("readWindow: null with failing mirror check → failure", async () => {
  const r = await readWindow(W, async () => { throw new NullResponseError(); }, nullOpts(() => { throw new Error("db down"); }));
  assert.equal(r.ok, false);
});

test("readWindow: object / string response is a failure even with zero mirror rows", async () => {
  for (const msg of ["unexpected non-array response: {}", 'unexpected non-array response: "x"']) {
    const r = await readWindow(W, async () => { throw new Error(msg); }, nullOpts(0));
    assert.equal(r.ok, false);
  }
});

test("planSweep: counts windows accepted as empty-by-null", () => {
  const e: WindowResult = { window: W, ok: true, attempts: 2, rows: [], emptyByNull: true };
  const plan = planSweep({
    windows: [okWindow("a"), e],
    mirror: [mirrorRow("a")],
    sweepStartedAt: T0,
    candidateStart: new Date("2025-01-01Z"),
    candidateEnd: new Date("2027-01-01Z"),
    breakerMin: 50,
    breakerPct: 5,
    minStrikeGapMs: 20 * HOUR,
  });
  assert.equal(plan.status, "complete");
  assert.equal(plan.windowsEmptyNull, 1);
});

// --- circuit breaker ------------------------------------------------------

function bigMirror(nLive: number, nGone: number): { mirror: MirrorRow[]; seen: string[] } {
  const mirror: MirrorRow[] = [];
  const seen: string[] = [];
  for (let i = 0; i < nLive; i++) {
    mirror.push(mirrorRow(`l${i}`));
    seen.push(`l${i}`);
  }
  for (let i = 0; i < nGone; i++) mirror.push(mirrorRow(`g${i}`));
  return { mirror, seen };
}

test("breaker: candidates > max(50, 5%) → abort marking", () => {
  const { mirror, seen } = bigMirror(100, 51);
  const p = plan([okWindow(...seen)], mirror);
  assert.equal(p.status, "aborted");
  assert.equal(p.breakerTripped, true);
  assert.equal(p.breakerLimit, 50);
  assert.match(p.abortReason!, /circuit breaker/);
  assert.equal(p.candidates.length, 51);
  assert.deepEqual(p.strike1, []);
  assert.deepEqual(p.strike2, []);
});

test("breaker: exactly at limit still marks", () => {
  const { mirror, seen } = bigMirror(100, 50);
  const p = plan([okWindow(...seen)], mirror);
  assert.equal(p.status, "complete");
  assert.equal(p.strike1.length, 50);
});

test("breaker: limit scales to 5% of rows in range", () => {
  const { mirror, seen } = bigMirror(1950, 100); // 2050 in range → 5% = 103
  const p = plan([okWindow(...seen)], mirror);
  assert.equal(p.breakerLimit, 103);
  assert.equal(p.status, "complete");
  assert.equal(p.strike1.length, 100);
});

test("breaker: --force overrides", () => {
  const { mirror, seen } = bigMirror(100, 51);
  const p = plan([okWindow(...seen)], mirror, { force: true });
  assert.equal(p.status, "complete");
  assert.equal(p.breakerTripped, true);
  assert.equal(p.strike1.length, 51);
});

test("breaker trip still clears rows seen alive (read was complete)", () => {
  const { mirror, seen } = bigMirror(100, 51);
  mirror.push(mirrorRow("back", { missingSince: new Date("2026-10-10") }));
  const p = plan([okWindow(...seen, "back")], mirror);
  assert.equal(p.status, "aborted");
  assert.deepEqual(ids(p.clear), ["back"]);
});

// --- range ----------------------------------------------------------------

test("row with date outside the candidate range (or no date) is never a candidate", () => {
  const p = plan(
    [okWindow("a")],
    [
      mirrorRow("a"),
      mirrorRow("old", { date: new Date("2025-09-01T12:00:00Z") }),
      mirrorRow("far", { date: new Date("2031-01-01T00:00:00Z") }),
      mirrorRow("nodate", { date: null }),
    ]
  );
  assert.deepEqual(p.candidates, []);
});

test("rows_new counts rows in the API but not in the mirror", () => {
  const p = plan([okWindow("a", "new1", "new2")], [mirrorRow("a")]);
  assert.equal(p.rowsNew, 2);
  assert.equal(p.rowsSeen, 3);
});

test("computeSweepRange: max known date + forward days, candidates one day inside", () => {
  const r = computeSweepRange({
    rangeStart: new Date("2025-09-01T00:00:00Z"),
    maxKnownDate: new Date("2029-12-30T03:00:00Z"),
    now: T0,
    forwardDays: 31,
  });
  assert.equal(r.start.toISOString(), "2025-09-01T00:00:00.000Z");
  assert.equal(r.endExclusive.toISOString(), "2030-01-31T00:00:00.000Z");
  assert.equal(r.candidateStart.toISOString(), "2025-09-02T00:00:00.000Z");
  assert.equal(r.candidateEnd.toISOString(), "2030-01-30T00:00:00.000Z");
});

test("buildWindows: contiguous ≤15-day windows, end = next start − 1s", () => {
  const ws = buildWindows(new Date("2025-09-01T00:00:00Z"), new Date("2025-10-05T00:00:00Z"));
  assert.equal(ws.length, 3);
  for (let i = 0; i < ws.length; i++) {
    assert.ok(ws[i].end.getTime() - ws[i].start.getTime() <= 15 * DAY_MS);
    if (i > 0) assert.equal(ws[i].start.getTime(), ws[i - 1].end.getTime() + 1000);
  }
  assert.equal(ws[2].end.toISOString(), "2025-10-04T23:59:59.000Z");
});

// --- config / schedule ----------------------------------------------------

test("config: mode defaults to dry_run and rejects junk", () => {
  assert.equal(parseSweepConfig({}).mode, "dry_run");
  assert.equal(parseSweepConfig({ FINANCIAL_SWEEP_MODE: "apply" }).mode, "apply");
  assert.throws(() => parseSweepConfig({ FINANCIAL_SWEEP_MODE: "yes" }));
  assert.deepEqual(parseSweepConfig({}).at, { hour: 4, minute: 30 });
  assert.throws(() => parseSweepConfig({ FINANCIAL_SWEEP_AT: "25:00" }));
});

test("nextRunAt: 04:30 America/Sao_Paulo (UTC−3) → 07:30Z", () => {
  assert.equal(
    nextRunAt(new Date("2026-10-16T05:00:00Z"), 4, 30, "America/Sao_Paulo").toISOString(),
    "2026-10-16T07:30:00.000Z"
  );
  // already past today's run → tomorrow
  assert.equal(
    nextRunAt(new Date("2026-10-16T07:30:00Z"), 4, 30, "America/Sao_Paulo").toISOString(),
    "2026-10-17T07:30:00.000Z"
  );
  // local date differs from UTC date (23:00 local = 02:00Z next day)
  assert.equal(
    nextRunAt(new Date("2026-10-17T02:00:00Z"), 4, 30, "America/Sao_Paulo").toISOString(),
    "2026-10-17T07:30:00.000Z"
  );
});
