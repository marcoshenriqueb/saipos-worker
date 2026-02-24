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

    // Legacy Order API config kept for now (not used in Data API ingest)
    baseUrl: must("SAIPOS_BASE_URL"),
    authUrl: must("SAIPOS_AUTH_URL"),
    idPartner: must("SAIPOS_ID_PARTNER"),
    secret: must("SAIPOS_SECRET"),
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

};