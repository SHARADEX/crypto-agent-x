#!/usr/bin/env bun
/**
 * scripts/run-cycle.ts — trigger N autonomous cycles from the command line.
 *
 * Usage:
 *   bun run agent:cycle              # 1 cycle
 *   bun run agent:cycle 3            # 3 cycles
 *   bun run agent:cycle --delay 2000 # 1 cycle, 2s delay before
 *
 * This is the same endpoint the dashboard's "Run Cycle" button hits, but
 * runnable from CI / cron / the operator's terminal.
 */

import { bootstrapAgent } from "../src/lib/orchestrator/bootstrap";
import { runCycles } from "../src/lib/orchestrator/loop";

async function main() {
  const args = process.argv.slice(2);
  const cyclesArg = args.find((a) => /^\d+$/.test(a));
  const delayArgIdx = args.indexOf("--delay");
  const delayMs = delayArgIdx >= 0 ? Number(args[delayArgIdx + 1] ?? "0") : 0;

  const cycles = cyclesArg ? Math.min(20, Math.max(1, Number(cyclesArg))) : 1;

  console.log(`[agent:cycle] bootstrapping…`);
  await bootstrapAgent();

  console.log(`[agent:cycle] running ${cycles} cycle(s)${delayMs ? ` (delay ${delayMs}ms)` : ""}…`);
  const summaries = await runCycles(cycles, { delayMs });

  let verifiedEarnings = 0;
  let processed = 0;
  let errors = 0;
  for (const c of summaries) {
    if (c.processed) processed++;
    if (c.skipReason) errors++;
    if (c.paymentsVerified > 0) verifiedEarnings += c.paymentsVerified;
  }

  console.log(`[agent:cycle] done — cycles=${summaries.length} processed=${processed} skipped=${errors}`);
  for (const c of summaries) {
    const p = c.processed;
    const sr = c.skipReason ? ` SKIP(${c.skipReason.slice(0, 60)})` : "";
    const fin = p?.finalStatus ? ` → ${p.finalStatus} (${p.steps.length} steps)` : "";
    console.log(`  cycle ${c.cycle}: ${c.discovered} discovered, ${c.discoveredNew} new${fin}${sr}`);
  }
}

main().catch((err) => {
  console.error("[agent:cycle] fatal:", err);
  process.exit(1);
});
