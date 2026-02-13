import { pingDb } from "./db";
import { runWorkerForever } from "./worker";
import { runNormalizerForever } from "./normalizer";

/**
 * Application entrypoint. Performs a DB health-check then starts the
 * worker and normalizer loops. Both loops are designed to run forever.
 */
async function main() {
  await pingDb();
  console.log("🚀 Worker iniciado.");
  runWorkerForever();

  console.log("🧱 Normalizer iniciado.");
  runNormalizerForever();

}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
