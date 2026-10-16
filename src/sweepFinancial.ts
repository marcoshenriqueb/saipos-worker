import { pool } from "./db";
import { runFinancialSweep } from "./financialSweep/run";
import { parseSweepMode } from "./financialSweep/logic";
import { config } from "./config";

/**
 * Runs one financial deletion sweep on demand.
 *
 *   npm run sweep:financial -- --mode=dry_run
 *   node dist/sweepFinancial.js --mode=apply [--force]
 *
 * --mode defaults to FINANCIAL_SWEEP_MODE (default dry_run).
 * --force overrides the circuit breaker (only after reviewing a dry_run).
 * Exit code: 0 complete, 2 aborted/skipped, 1 failed.
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const modeArg = args.find((a) => a.startsWith("--mode="))?.slice("--mode=".length);
  const force = args.includes("--force");
  const unknown = args.filter((a) => !a.startsWith("--mode=") && a !== "--force");
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(" ")}`);

  const mode = parseSweepMode(modeArg, config.financialSweep.mode);
  if (mode === "off") {
    console.log("Sweep mode is off; nothing to do. Pass --mode=dry_run or --mode=apply.");
    return 0;
  }

  const r = await runFinancialSweep({ mode, force });
  console.log(`sweep id=${r.sweepId ?? "-"} status=${r.status}`);
  return r.status === "complete" ? 0 : r.status === "failed" ? 1 : 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: any) => {
    console.error("❌ sweep:financial failed:", e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
