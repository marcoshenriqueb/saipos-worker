import "dotenv/config";
import { parseSweepConfig } from "./financialSweep/logic";

/**
 * Ensures an environment variable exists.
 * Throws an error if missing.
 */
function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/**
 * Reads an environment variable as number.
 * Uses fallback if not defined.
 */
function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number env var: ${name}=${v}`);
  return n;
}

/**
 * Main application configuration.
 *
 * Everything here comes from environment variables.
 * This ensures deploys are reproducible across environments.
 */
export const config = {

  /**
   * PostgreSQL connection string
   *
   * Example:
   * postgres://user:password@postgres:5432/saipos
   */
  databaseUrl: must("DATABASE_URL"),


  /**
   * Worker mode selector.
   *
   * idle     → worker disabled (safe mode)
   * ingest   → fetch sales from Saipos Data API and save into orders_raw
   * normalize → normalize orders_raw into BI tables
   *
   * You can run both ingest + normalize in same process later.
   */
  workerMode: process.env.WORKER_MODE || "idle",

  /**
   * Financial worker mode selector.
   *
   * idle   → financial ingest disabled (safe mode)
   * ingest → fetch financial transactions from Saipos Data API
   *
   * Default keeps the current sales pipeline unchanged.
   */
  financialWorkerMode: process.env.FINANCIAL_WORKER_MODE || "idle",


  /**
   * How often the worker runs (milliseconds)
   *
   * 60000 = 60 seconds
   *
   * Example:
   * every minute fetch new sales
   */
  pollIntervalMs: num("POLL_INTERVAL_MS", 60000),


  /**
   * Saipos API configuration
   */
  saipos: {
    /**
     * Data API base URL
     * Ex: https://data.saipos.io
     */
    dataApiUrl: must("SAIPOS_DATA_API_URL"),

    /**
     * Data API token (Bearer)
     */
    dataToken: must("SAIPOS_DATA_TOKEN"),
  },


  /**
   * Ingest configuration
   */
  ingest: {

    /**
     * How many days back to fetch sales from Saipos Data API
     *
     * Example:
     *
     * daysBack = 2
     *
     * fetch:
     * today
     * yesterday
     *
     * This prevents missing delayed sales.
     */
    daysBack: num("INGEST_DAYS_BACK", 2),

  },

  /**
   * Normalizer configuration
   */
  normalize: {
    /**
     * Max raw orders processed per loop
     */
    batchSize: num("NORMALIZER_BATCH_SIZE", 100),
  },

  /**
   * Financial ingest configuration
   */
  financialIngest: {
    /**
     * Worker faz dois passes por ciclo. Saipos limita cada request a 15 dias.
     *
     * Pass `updated_at` — pega edições e lançamentos recém-criados/editados
     * (inclui recorrências futuras criadas agora). Janela termina em "agora".
     */
    daysBack: num("FINANCIAL_INGEST_DAYS_BACK", 7),

    /**
     * Lookback hours do pass `updated_at`, margem pra re-fetch seguro.
     */
    lookbackHours: num("FINANCIAL_INGEST_LOOKBACK_HOURS", 26),

    /**
     * Pass `date` — janela operacional (passado recente + futuro próximo).
     * Garante que boletos/impostos/recorrências que VENCEM na janela estão
     * sincronizados, mesmo criados meses atrás (updated_at antigo).
     * dateDaysBack + dateDaysForward não pode passar de 15.
     */
    dateDaysBack: num("FINANCIAL_INGEST_DATE_DAYS_BACK", 8),
    dateDaysForward: num("FINANCIAL_INGEST_DATE_DAYS_FORWARD", 6),
  },

  /**
   * Financial normalizer configuration
   */
  financialNormalize: {
    batchSize: num("FINANCIAL_NORMALIZER_BATCH_SIZE", 100),
  },

  /**
   * Daily financial deletion sweep (docs/2026-10-16-deletion-propagation-design.md).
   *
   * FINANCIAL_SWEEP_MODE=off|dry_run|apply (default dry_run)
   * FINANCIAL_SWEEP_AT=HH:MM (default 04:30), FINANCIAL_SWEEP_TZ (default America/Sao_Paulo)
   * FINANCIAL_SWEEP_RANGE_START (default 2025-09-01), FINANCIAL_SWEEP_FORWARD_DAYS (default 31)
   * FINANCIAL_SWEEP_SLEEP_MS (default 400), FINANCIAL_SWEEP_BREAKER_MIN (50),
   * FINANCIAL_SWEEP_BREAKER_PCT (5), FINANCIAL_SWEEP_MIN_STRIKE_GAP_HOURS (20)
   */
  financialSweep: parseSweepConfig(process.env),

};
