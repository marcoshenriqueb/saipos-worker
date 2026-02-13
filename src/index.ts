import { pingDb } from "./db";
import { runWorkerForever } from "./worker";
import { runNormalizerForever } from "./normalizer";

async function main() {
  await pingDb();
  await runWorkerForever();
  await runNormalizerForever();

}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
