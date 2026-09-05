// Quick end-to-end smoke test for the strategy allocator (Phase 3 §16–§26).
// Verifies that bootstrapAllocations / getAllocations / selectFamilyForCycle /
// setAllocation / setAllocationLimits / disableFamily / enableFamily /
// autoOptimize / rebalanceAllocations / getAllocationChangeLog all work
// against a real DB.
//
// Run with:
//   DATABASE_URL=file:/tmp/cryptoearn-strat-test.db bun run scripts/test-strategy-allocator.ts

import { db } from "@/lib/db";
import {
  bootstrapAllocations,
  getAllocations,
  selectFamilyForCycle,
  setAllocation,
  setAllocationLimits,
  disableFamily,
  enableFamily,
  autoOptimize,
  rebalanceAllocations,
  getAllocationChangeLog,
} from "@/lib/economics/strategy-allocator";
import { bootstrapStrategies } from "@/lib/economics/strategy-stats";
import { recordStrategyOutcome } from "@/lib/economics/strategy-stats";

async function main(): Promise<number> {
  console.log("→ Resetting test DB...");
  // Wipe every table.
  const tables = [
    "StrategyAllocationChangeLog",
    "StrategyAllocation",
    "StrategyStat",
  ];
  for (const t of tables) {
    try {
      await (db as any)[t].deleteMany({});
    } catch (err) {
      console.warn(`  [test] wipe ${t} failed:`, err);
    }
  }

  console.log("→ bootstrapStrategies + bootstrapAllocations...");
  await bootstrapStrategies();
  const seed = await bootstrapAllocations();
  console.log(`  seeded=${seed.seeded} skipped=${seed.skipped}`);

  console.log("→ getAllocations()...");
  const allocs1 = await getAllocations();
  console.log(`  count=${allocs1.length}`);
  for (const a of allocs1) {
    console.log(
      `  ${a.family.padEnd(15)} target=${a.targetAllocation.toFixed(0)}% ` +
        `min=${a.minAllocation.toFixed(0)}% max=${a.maxAllocation.toFixed(0)}% ` +
        `disabled=${a.disabled} trend=${a.trend}`
    );
  }
  const totalTarget = allocs1.reduce(
    (sum, a) => sum + (a.disabled ? 0 : a.targetAllocation),
    0
  );
  console.log(`  total target = ${totalTarget}%`);
  if (Math.abs(totalTarget - 100) > 0.01) {
    console.error(`✗ total target should be 100, got ${totalTarget}`);
    return 1;
  }

  console.log("→ Simulate 5 paid github_bounty + 5 paid freelance outcomes...");
  for (let i = 0; i < 5; i++) {
    await recordStrategyOutcome("github_bounty", {
      attempted: true,
      completed: true,
      netUsd: 100 + i * 10,
      hoursSpent: 5,
    });
  }
  for (let i = 0; i < 5; i++) {
    await recordStrategyOutcome("freelance", {
      attempted: true,
      completed: true,
      netUsd: 500 + i * 50,
      hoursSpent: 8,
    });
  }

  console.log("→ selectFamilyForCycle() x5...");
  const picks: Record<string, number> = {};
  for (let i = 0; i < 5; i++) {
    const family = await selectFamilyForCycle();
    if (family) picks[family] = (picks[family] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(picks)) {
    console.log(`  ${k}: ${v}`);
  }

  console.log("→ setAllocation('freelance', 20)...");
  const setResult = await setAllocation("freelance", 20);
  if (!setResult.ok) {
    console.error(`✗ setAllocation failed: ${setResult.error}`);
    return 1;
  }
  console.log(`  changes=${setResult.changes?.length ?? 0}`);
  for (const c of setResult.changes ?? []) {
    console.log(`  ${c.family}: ${c.previous.toFixed(1)}% → ${c.next.toFixed(1)}% (${c.reason})`);
  }

  console.log("→ getAllocations() (verify total still 100)...");
  const allocs2 = await getAllocations();
  const total2 = allocs2.reduce(
    (sum, a) => sum + (a.disabled ? 0 : a.targetAllocation),
    0
  );
  console.log(`  total target = ${total2.toFixed(2)}%`);
  if (Math.abs(total2 - 100) > 0.01) {
    console.error(`✗ total target drifted from 100, got ${total2}`);
    return 1;
  }

  console.log("→ setAllocationLimits('bounty', 50, 80)...");
  const limitsResult = await setAllocationLimits("bounty", 50, 80);
  if (!limitsResult.ok) {
    console.error(`✗ setAllocationLimits failed: ${limitsResult.error}`);
    return 1;
  }
  console.log(`  newTarget=${limitsResult.newTarget}`);

  console.log("→ rebalanceAllocations()...");
  const rebalanceResult = await rebalanceAllocations();
  console.log(`  rebalanced=${rebalanceResult.rebalanced}`);
  console.log(`  changes=${rebalanceResult.changes.length}`);
  console.log(`  skippedReason=${rebalanceResult.skippedReason ?? "(none)"}`);
  for (const c of rebalanceResult.changes) {
    console.log(`  ${c.family}: ${c.previous.toFixed(1)}% → ${c.next.toFixed(1)}%`);
  }

  console.log("→ disableFamily('hackathon')...");
  const disableResult = await disableFamily("hackathon");
  console.log(`  ok=${disableResult.ok}`);
  if (!disableResult.ok) {
    console.error(`✗ disableFamily failed: ${disableResult.error}`);
    return 1;
  }
  const allocs3 = await getAllocations();
  const total3 = allocs3.reduce(
    (sum, a) => sum + (a.disabled ? 0 : a.targetAllocation),
    0
  );
  console.log(`  total target = ${total3.toFixed(2)}%`);
  if (Math.abs(total3 - 100) > 0.01) {
    console.error(`✗ total target drifted after disable, got ${total3}`);
    return 1;
  }

  console.log("→ enableFamily('hackathon')...");
  const enableResult = await enableFamily("hackathon");
  console.log(`  ok=${enableResult.ok}`);
  if (!enableResult.ok) {
    console.error(`✗ enableFamily failed: ${enableResult.error}`);
    return 1;
  }

  console.log("→ autoOptimize()...");
  const autoResult = await autoOptimize();
  console.log(`  ok=${autoResult.ok} changes=${autoResult.changes.length}`);
  if (!autoResult.ok) {
    console.error(`✗ autoOptimize failed: ${autoResult.error}`);
    return 1;
  }

  console.log("→ getAllocationChangeLog()...");
  const log = await getAllocationChangeLog(50);
  console.log(`  entries=${log.length}`);
  for (const e of log.slice(0, 5)) {
    console.log(
      `  [${e.triggeredBy}] ${e.family}: ` +
        `${e.previousAllocation.toFixed(1)}% → ${e.newAllocation.toFixed(1)}% ` +
        `(${e.reason.slice(0, 80)})`
    );
  }
  if (log.length === 0) {
    console.error("✗ change log is empty");
    return 1;
  }

  console.log("");
  console.log("✓ strategy-allocator end-to-end smoke test PASSED.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[test-strategy-allocator] uncaught:", err);
    process.exit(1);
  });
