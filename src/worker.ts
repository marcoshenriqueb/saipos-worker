import { config } from "./config";
import { consultOrder } from "./saipos";
import { markDead, markDone, markError, pickEvents, upsertOrdersRaw, InboxEvent } from "./db";

/**
 * Small promise-based sleep helper.
 * @param ms milliseconds to wait
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Compute exponential backoff in milliseconds (with light jitter).
 * `attempts` is expected to be 1-based (1,2,3...).
 */
function computeBackoffMs(attempts: number): number {
  // attempts já vem incrementado (1,2,3...)
  const base = config.retry.baseBackoffMs;
  const max = config.retry.maxBackoffMs;
  const ms = Math.min(max, base * Math.pow(2, Math.max(0, attempts - 1)));
  // jitter leve
  const jitter = Math.floor(ms * (0.15 * Math.random()));
  return ms + jitter;
}

/**
 * Compute the next retry timestamp based on number of attempts.
 * @param attempts number of attempts already made (1-based)
 * @returns Date for next retry
 */
function nextRetryDate(attempts: number): Date {
  const ms = computeBackoffMs(attempts);
  return new Date(Date.now() + ms);
}

/**
 * Heuristic to decide if an error is permanent (no retries).
 * Customize based on Saipos error messages/codes.
 */
function isPermanentError(e: any): boolean {
  // exemplo: “pedido não existe” pode ser permanente
  const msg = String(e?.message || "");
  if (msg.includes("Não existe pedido")) return true;
  // Saipos errorCode específico, se você quiser:
  const code = e?.saiposErrorCode;
  if (code === 404) return true;
  return false;
}

/**
 * Main worker loop: picks events, processes them, and handles errors/retries.
 * This function runs forever until the process is terminated.
 */
export async function runWorkerForever(): Promise<void> {
  console.log("🚀 Worker iniciado.");

  while (true) {
    try {
      const batch = await pickEvents(config.batchSize);

      if (batch.length === 0) {
        await sleep(config.pollIntervalMs);
        continue;
      }

      console.log(`📥 Picked ${batch.length} events`);

      for (const ev of batch) {
        await processOne(ev);
      }
    } catch (e: any) {
      console.error("❌ Worker loop error:", e?.message || e);
      await sleep(2000);
    }
  }
}

/**
 * Process a single `InboxEvent`: fetch order from Saipos, persist raw order,
 * and update event status (done / error / dead).
 */
async function processOne(ev: InboxEvent): Promise<void> {
  const { id, provider, store_id, order_id, event, attempts, received_at } = ev;

  try {
    const payload = await consultOrder(order_id, store_id);

    await upsertOrdersRaw({
      provider,
      store_id,
      order_id,
      status: event,
      received_at,
      payload,
    });

    // Depois a gente adiciona normalize() para orders e order_items
    await markDone(id);

    console.log(`✅ done event_id=${id} order_id=${order_id}`);
  } catch (e: any) {
    const msg = String(e?.message || e);
    console.warn(`⚠️ error event_id=${id} attempts=${attempts} msg=${msg.slice(0, 140)}`);

    if (attempts >= config.retry.maxAttempts) {
      await markDead(id, msg);
      console.warn(`🪦 dead event_id=${id}`);
      return;
    }

    if (isPermanentError(e)) {
      await markDead(id, msg);
      console.warn(`🪦 permanent -> dead event_id=${id}`);
      return;
    }

    const retryAt = nextRetryDate(attempts);
    await markError(id, msg, retryAt);
  }
}