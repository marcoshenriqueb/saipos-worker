import { pingDb } from "./db";
import { runWorkerForever } from "./worker";

async function main() {
  await pingDb();
  await runWorkerForever();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});