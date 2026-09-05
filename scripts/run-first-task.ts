#!/usr/bin/env bun
/**
 * scripts/run-first-task.ts — drive ONE opportunity through its full
 * lifecycle (the operator-guided "first task" run).
 *
 * Usage: bun run scripts/run-first-task.ts [opportunityId]
 * Default target: the fibonacci bounty (abk-coding-test issue #1).
 */
import { bootstrapAgent } from "../src/lib/orchestrator/bootstrap";
import { processOpportunity } from "../src/lib/orchestrator/orchestrator";
import { db } from "../src/lib/db";

const FIBONACCI_ID = "cmtmr32lv003qsgwdih4x1h8d";

async function main() {
  await bootstrapAgent();

  const id = process.argv[2] ?? FIBONACCI_ID;
  const before = await db.opportunity.findUnique({
    where: { id },
    select: { id: true, title: true, status: true, sourceUrl: true },
  });
  if (!before) {
    console.error("[first-task] opportunity not found:", id);
    process.exit(1);
  }
  console.log("[first-task] target:", JSON.stringify(before, null, 2));

  const result = await processOpportunity(id);

  console.log("\n[first-task] === RESULT ===");
  console.log(
    JSON.stringify(
      {
        initialStatus: result.initialStatus,
        finalStatus: result.finalStatus,
        aborted: result.aborted,
        abortReason: result.abortReason ?? null,
        steps: result.steps.map((s) => ({
          agent: s.agent,
          success: s.success,
          notes: s.notes,
        })),
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error("[first-task] fatal:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
