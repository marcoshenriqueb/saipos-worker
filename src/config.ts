import "dotenv/config";

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
     * Days back for financial transactions lookup.
     * Saipos financial endpoint supports at most 15 days per request.
     */
    daysBack: num("FINANCIAL_INGEST_DAYS_BACK", 7),

    /**
     * Date column used for incremental fetches.
     * Recommended default: updated_at
     */
    dateColumnFilter:
      process.env.FINANCIAL_INGEST_DATE_COLUMN_FILTER || "updated_at",

    /**
     * Lookback hours to re-fetch recent updates safely.
     */
    lookbackHours: num("FINANCIAL_INGEST_LOOKBACK_HOURS", 26),
  },

  /**
   * Financial normalizer configuration
   */
  financialNormalize: {
    batchSize: num("FINANCIAL_NORMALIZER_BATCH_SIZE", 100),
  },

};
