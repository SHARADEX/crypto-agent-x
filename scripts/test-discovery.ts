import { runDiscoveryCycleV2 } from "@/lib/agent/sources";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";

async function main() {
  await bootstrapAgent();
  const summary = await runDiscoveryCycleV2();
  console.log("discovered:", summary.discovered);
  console.log("perSource:", JSON.stringify(summary.perSource, null, 2));
  console.log("scannerErrors:", JSON.stringify(summary.scannerErrors, null, 2));
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
