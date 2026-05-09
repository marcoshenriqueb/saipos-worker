import { pingDb } from "./db";
import { runWorkerForever } from "./worker";
import { runNormalizerForever } from "./normalizer";
import { runFinancialWorkerForever } from "./financialWorker";
import { runFinancialNormalizerForever } from "./financialNormalizer";

/**
 * Application entrypoint. Performs a DB health-check then starts the
 * worker and normalizer loops. Both loops are designed to run forever.
 */
async function main() {
  await pingDb();
  console.log("🚀 Worker iniciado.");
  runWorkerForever();

  console.log("💰 Financial worker iniciado.");
  runFinancialWorkerForever();

  console.log("🧱 Normalizer iniciado.");
  runNormalizerForever();

  console.log("🧾 Financial normalizer iniciado.");
  runFinancialNormalizerForever();

}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
