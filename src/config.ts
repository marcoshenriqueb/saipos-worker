import "dotenv/config";

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number env var: ${name}=${v}`);
  return n;
}

export const config = {
  databaseUrl: must("DATABASE_URL"),

  batchSize: num("BATCH_SIZE", 10),
  pollIntervalMs: num("POLL_INTERVAL_MS", 2000),

  saipos: {
    baseUrl: must("SAIPOS_BASE_URL"),
    authUrl: must("SAIPOS_AUTH_URL"),
    idPartner: must("SAIPOS_ID_PARTNER"),
    secret: must("SAIPOS_SECRET"),
    codStore: must("SAIPOS_COD_STORE"),
  },

  retry: {
    maxAttempts: num("MAX_ATTEMPTS", 5),
    baseBackoffMs: num("BASE_BACKOFF_MS", 2000),
    maxBackoffMs: num("MAX_BACKOFF_MS", 60000),
  },
};