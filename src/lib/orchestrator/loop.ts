// Autonomous main loop (spec §28, §29, §30).
//
// Resumable, idempotent, failure-tolerant. Every cycle:
//   1. Refresh kill switch (filesystem markers + DB + env var).
//   2. canRun() check — abort the cycle cleanly if paused / stopped.
//   3. BudgetManager.assertWithinBudget() — abort if caps are exceeded.
//   4. refreshWallets() — light-touch wallet balance refresh.
//   5. runDiscoveryCycle() — but THROTTLED: only if last discovery > 10min
//      ago (proxied via AgentState.lastCycleAt).
//   6. selectStrategyForCycle() — pick which strategy category to prioritise
//      (spec §16 exploration/exploitation).
//   7. selectNextOpportunity(strategy) — pick the highest-ranked opportunity
//      matching the selected strategy (or any if none match).
//   8. processOpportunity(id) — walk the opportunity through its lifecycle.
//   9. scanForIncomingPayments() — check for new payments on any
//      `awaiting_payment` opportunities.
//  10. markCycle(result) — increment the cycle counter + record last result.
//
// Failure handling (spec §29):
//   Every step is wrapped in try/catch — failures are recorded as cycle
//   `errors[]` but never abort the whole cycle. The loop keeps running so
//   a single broken scanner / RPC / agent can't prevent the rest of the
//   pipeline from making progress.
//
// Idempotency (spec §30):
//   Every external action goes through `IdempotencyRecord` — the
//   `executionId = ${opportunityId}:${action}` key guarantees a crash-
//   recovery scenario where the agent submitted a PR but crashed before
//   recording it will NOT result in a duplicate submission on the next
//   cycle.

import { db } from "@/lib/db";
import { logEvent, getProcessRunId } from "@/lib/agent/events";
import { canRun, markCycle, getState, setState } from "@/lib/agent/state";
import { refreshKillSwitchState } from "@/lib/kill-switch";
import { BudgetManager } from "@/lib/budget/manager";
import { refreshWallets } from "@/lib/wallet/monitor";
import { scanForIncomingPayments } from "@/lib/wallet/payment-verifier";
import { monitorSubmittedPRs } from "@/lib/execution-adapters/monitoring/pr-monitor";
import { recordLifecycleSnapshot } from "@/lib/analytics/lifecycle-snapshot";
import { runDiscoveryCycle } from "@/lib/agent/scanners";
import {
  selectFamilyForCycle,
  rebalanceAllocations,
} from "@/lib/economics/strategy-allocator";
import { familySubcategories } from "@/lib/economics/strategy-families";
import {
  processOpportunity,
  selectNextOpportunity,
} from "@/lib/orchestrator/orchestrator";
import type { ProcessOpportunityResult } from "@/lib/orchestrator/orchestrator";
import { recordMemory } from "@/lib/memory/agent-memory";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CycleSummary {
  cycle: number;
  startedAt: string;
  finishedAt: string;
  skipped: boolean;
  skipReason?: string;
  discovered: number;
  discoveredNew: number;
  selectedOpportunityId: string | null;
  strategy: string | null;
  processed: ProcessOpportunityResult | null;
  paymentsVerified: number;
  errors: string[];
}

export interface RunCyclesOptions {
  delayMs?: number;
  maxErrors?: number; // abort the batch if total errors exceed this
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCOVERY_THROTTLE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Minimum number of opportunities that must reach the `paid` terminal state
 * since the last adaptive rebalance before the loop triggers another
 * `rebalanceAllocations()` pass. Phase 3 §18: "Requires a minimum sample
 * size (e.g. 5 completed opportunities) before adjusting."
 */
const REBALANCE_MIN_NEW_COMPLETIONS = 5;

// ---------------------------------------------------------------------------
// runCycle — one autonomous cycle
// ---------------------------------------------------------------------------

/**
 * Run ONE autonomous cycle. See module docstring for the high-level flow.
 * Returns a `CycleSummary` describing what happened.
 *
 * Never throws — every step is wrapped in try/catch and failures are
 * recorded as `errors[]` so a single broken step can't abort the cycle.
 *
 * Phase-2 P2-21: every `logEvent` call inside this cycle (and every
 * `callLLM` call downstream of `processOpportunity`) carries the same
 * `runId` so the dashboard can correlate events across agents.
 */
export async function runCycle(): Promise<CycleSummary> {
  const startedAt = new Date().toISOString();
  // Mark the agent as running so the dashboard shows the correct status.
  try {
    await setState({ running: true });
  } catch {
    // Non-fatal — the cycle still runs.
  }
  // Phase-2 P2-21: a fresh runId per cycle. Passed to every logEvent so the
  // dashboard can group events by cycle. When callLLM is invoked downstream
  // via processOpportunity → specialist-agent → callLLM, the specialist
  // agents that pass `runId` along will share the same id.
  const runId = generateCycleRunId();
  const summary: CycleSummary = {
    cycle: 0,
    startedAt,
    finishedAt: startedAt,
    skipped: false,
    discovered: 0,
    discoveredNew: 0,
    selectedOpportunityId: null,
    strategy: null,
    processed: null,
    paymentsVerified: 0,
    errors: [],
  };

  // 1. Refresh kill switch (filesystem + DB + env).
  try {
    await refreshKillSwitchState();
  } catch (err) {
    summary.errors.push(
      `refreshKillSwitchState: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 2. canRun gate.
  try {
    const gate = await canRun();
    if (!gate.canRun) {
      summary.skipped = true;
      summary.skipReason = gate.reason;
      summary.finishedAt = new Date().toISOString();
      await logEvent(
        "orchestrator",
        "info",
        "cycle_skipped",
        { reason: gate.reason },
        { runId }
      );
      // Even skipped cycles bump the counter so the dashboard shows the
      // agent is alive and responsive.
      await safeMarkCycle(`skipped: ${gate.reason}`);
      summary.cycle = (await getState()).cycleCount;
      return summary;
    }
  } catch (err) {
    summary.errors.push(
      `canRun: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 3. Budget gate.
  try {
    await BudgetManager.getInstance().assertWithinBudget();
  } catch (err) {
    summary.skipped = true;
    summary.skipReason =
      err instanceof Error ? `Budget: ${err.message}` : "Budget exceeded.";
    summary.finishedAt = new Date().toISOString();
    await logEvent(
      "orchestrator",
      "warn",
      "cycle_skipped_budget",
      { reason: summary.skipReason },
      { runId }
    );
    await safeMarkCycle(`budget-skipped: ${summary.skipReason}`);
    summary.cycle = (await getState()).cycleCount;
    return summary;
  }

  // 4. Refresh wallets (light, every cycle).
  try {
    await refreshWallets();
  } catch (err) {
    summary.errors.push(
      `refreshWallets: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 5. Throttled discovery cycle.
  try {
    const state = await getState();
    const lastCycleAt = state.lastCycleAt
      ? Date.parse(state.lastCycleAt)
      : 0;
    const sinceLast = Date.now() - (Number.isFinite(lastCycleAt) ? lastCycleAt : 0);
    if (sinceLast >= DISCOVERY_THROTTLE_MS) {
      const discovery = await runDiscoveryCycle();
      summary.discovered = discovery.discovered;
      summary.discoveredNew = discovery.new;
    } else {
      // Skip discovery this cycle — the throttle hasn't expired.
      await logEvent(
        "scout",
        "debug",
        "discovery_throttled",
        {
          sinceLastMs: sinceLast,
          throttleMs: DISCOVERY_THROTTLE_MS,
        },
        { runId }
      );
    }
  } catch (err) {
    summary.errors.push(
      `runDiscoveryCycle: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 6. Strategy-family selection (Phase 3 §16, §18, §36).
  //
  // The legacy `selectStrategyForCycle()` (per-category 70/20/10 explore/
  // exploit picker) has been replaced by `selectFamilyForCycle()` (per-family
  // 65/20/15 adaptive allocator). The selected family's subcategories are
  // passed to `selectNextOpportunity` so the legacy filter still works.
  let strategy: string | null = null;
  let familyFilter: string[] | null = null;
  try {
    const family = await selectFamilyForCycle();
    if (family) {
      strategy = family;
      familyFilter = familySubcategories(family);
    }
    summary.strategy = strategy;
  } catch (err) {
    summary.errors.push(
      `selectFamilyForCycle: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 7. Pick the next opportunity (preferring the selected family's
  //    subcategories, then falling back to any).
  let opportunityId: string | null = null;
  try {
    // First try with the family's subcategories, then fall back to any.
    opportunityId = await selectNextOpportunity(familyFilter);
    if (!opportunityId) {
      opportunityId = await selectNextOpportunity(null);
    }
    summary.selectedOpportunityId = opportunityId;
  } catch (err) {
    summary.errors.push(
      `selectNextOpportunity: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 8. Process the opportunity (walk through its lifecycle).
  if (opportunityId) {
    try {
      const processed = await processOpportunity(opportunityId);
      summary.processed = processed;
    } catch (err) {
      summary.errors.push(
        `processOpportunity: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 9. Scan for incoming payments — check pending `awaiting_payment`
  // 9b. Monitor submitted PRs — check GitHub PR status for opportunities
  // in "awaiting_payment" status (Phase 3.1 §10, §27). Detects merges,
  // changes_requested, and closed-without-merge.
  try {
    const prResult = await monitorSubmittedPRs();
    if (prResult.checked > 0) {
      // v0.5.1: a routine "N checked, all quiet" poll is NOT an error — it
      // used to be pushed into summary.errors, which made every cycle_complete
      // event warn-level and polluted the error list the operator scans.
      // Only state CHANGES (merged / changes_requested / closed) are surfaced
      // as cycle items now; the quiet case logs a debug event instead.
      const quiet =
        prResult.merged === 0 &&
        prResult.changesRequested === 0 &&
        prResult.closed === 0;
      if (quiet) {
        await logEvent(
          "execution",
          "debug",
          "pr_monitor_quiet",
          {
            checked: prResult.checked,
            runId,
          },
          { runId }
        );
      } else {
        summary.errors.push(
          `PR monitor: ${prResult.checked} checked, ${prResult.merged} merged, ${prResult.changesRequested} changes_requested, ${prResult.closed} closed`
        );
      }
    }
  } catch (err) {
    summary.errors.push(
      `monitorSubmittedPRs: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 10. Scan for incoming payments on monitored wallets + re-verify
  //    opportunities for newly-arrived transactions.
  try {
    const scan = await scanForIncomingPayments();
    // Re-run payment verification for every awaiting_payment opportunity
    // so the agent picks up matches promptly.
    const pending = await db.opportunity.findMany({
      where: { status: "awaiting_payment" },
      select: { id: true },
    });
    let verified = 0;
    for (const op of pending) {
      try {
        // We invoke the payment agent via the orchestrator's tick path
        // by directly processing the opportunity — `decideNextSpecialist`
        // routes `awaiting_payment` to the payment agent.
        await processOpportunity(op.id);
        verified += 1;
      } catch (err) {
        summary.errors.push(
          `payment-retry ${op.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    summary.paymentsVerified = verified + (scan.newTransactions > 0 ? 1 : 0);
  } catch (err) {
    summary.errors.push(
      `scanForIncomingPayments: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 10. Mark the cycle done.
  summary.finishedAt = new Date().toISOString();
  const resultTag = summary.processed
    ? `processed:${summary.processed.finalStatus}`
    : summary.selectedOpportunityId
    ? "no-opportunity-processed"
    : "no-opportunity-selected";
  await safeMarkCycle(resultTag);
  summary.cycle = (await getState()).cycleCount;

  await logEvent(
    "orchestrator",
    summary.errors.length > 0 ? "warn" : "info",
    "cycle_complete",
    {
      cycle: summary.cycle,
      discovered: summary.discovered,
      discoveredNew: summary.discoveredNew,
      strategy: summary.strategy,
      selectedOpportunityId: summary.selectedOpportunityId,
      processedFinalStatus: summary.processed?.finalStatus ?? null,
      paymentsVerified: summary.paymentsVerified,
      errorCount: summary.errors.length,
      errors: summary.errors,
    },
    summary.selectedOpportunityId
      ? { opportunityId: summary.selectedOpportunityId, runId }
      : { runId }
  );

  // Phase-2 P3-2 — record a cross-cycle memory when an opportunity reached a
  // terminal state (paid / failed / rejected). The lesson generalizes the
  // outcome so future cycles can bias decisions toward proven approaches.
  if (summary.processed && summary.selectedOpportunityId) {
    try {
      await recordCycleLesson(summary.processed, summary.selectedOpportunityId, summary.strategy);
    } catch (err) {
      console.error("[loop] recordCycleLesson failed:", err);
    }
  }

  // 11. Adaptive strategy-family rebalance (Phase 3 §18, §35).
  //
  // After each cycle, if REBALANCE_MIN_NEW_COMPLETIONS (5) or more
  // opportunities have reached the `paid` terminal state since the last
  // adaptive rebalance pass, run `rebalanceAllocations()` so the
  // allocation can shift toward higher-performing families.
  try {
    const shouldRebalance = await shouldRunRebalance();
    if (shouldRebalance) {
      const result = await rebalanceAllocations();
      if (result.rebalanced) {
        await logEvent(
          "economics",
          "info",
          "cycle_rebalanced_allocations",
          {
            cycle: summary.cycle,
            changes: result.changes.length,
            runId,
          },
          { runId }
        );
      } else if (result.skippedReason) {
        await logEvent(
          "economics",
          "debug",
          "cycle_rebalance_skipped",
          {
            cycle: summary.cycle,
            reason: result.skippedReason,
            runId,
          },
          { runId }
        );
      }
    }
  } catch (err) {
    summary.errors.push(
      `rebalanceAllocations: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 12. Record a lifecycle snapshot (Phase-3 DEV-REVIEW-4, priority #2).
  //
  // Once per cycle, write a point-in-time snapshot of how many
  // opportunities are in each status + their avg/max hours in status.
  // The dashboard's Lifecycle tab renders a 7-day trend chart from
  // these rows so the operator can see whether bottlenecks are improving
  // or worsening over time. The snapshot is idempotent per hourly bucket
  // so running multiple cycles per hour is safe.
  try {
    const snap = await recordLifecycleSnapshot();
    // Only log when there are statuses to snapshot (skip the noisy
    // "0 statuses" log on a fresh DB).
    if (snap.count > 0) {
      await logEvent(
        "orchestrator",
        "debug",
        "lifecycle_snapshot_recorded",
        {
          cycle: summary.cycle,
          bucket: snap.bucket,
          statusCount: snap.count,
          runId,
        },
        { runId }
      );
    }
  } catch (err) {
    // Non-fatal — the snapshot is a monitoring nicety, not a correctness
    // requirement. Log + continue.
    console.error("[loop] recordLifecycleSnapshot failed:", err);
  }

  // Mark the agent as no longer running (cycle complete).
  try {
    await setState({ running: false });
  } catch {
    // Non-fatal.
  }

  return summary;
}

/**
 * Decide whether the loop should run an adaptive-rebalance pass this cycle.
 *
 * Returns true iff at least REBALANCE_MIN_NEW_COMPLETIONS opportunities have
 * reached the `paid` terminal state since the most recent
 * `adaptive_rebalancer` change-log entry (or since the dawn of time if no
 * rebalance has ever run).
 *
 * The function is defensive — every DB call is wrapped in try/catch so a
 * transient DB outage just defers the rebalance to the next cycle.
 */
async function shouldRunRebalance(): Promise<boolean> {
  try {
    // Find the most recent adaptive rebalance timestamp.
    let since = new Date(0);
    try {
      const lastRebalance = await db.strategyAllocationChangeLog.findFirst({
        where: { triggeredBy: "adaptive_rebalancer" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (lastRebalance) since = lastRebalance.createdAt;
    } catch (err) {
      console.error("[loop] shouldRunRebalance: changeLog lookup failed:", err);
    }

    // Count opportunities that reached the `paid` terminal state since then.
    let completedSince = 0;
    try {
      completedSince = await db.opportunity.count({
        where: { status: "paid", updatedAt: { gt: since } },
      });
    } catch (err) {
      console.error("[loop] shouldRunRebalance: opportunity count failed:", err);
      return false;
    }

    return completedSince >= REBALANCE_MIN_NEW_COMPLETIONS;
  } catch (err) {
    console.error("[loop] shouldRunRebalance failed:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// runCycles — N cycles with a delay between each
// ---------------------------------------------------------------------------

/**
 * Run N cycles with a configurable delay between each. Used by the API to
 * trigger a batch (e.g. POST /api/agent/run-cycles?n=5).
 *
 * The batch aborts early if the kill switch engages OR if the total error
 * count exceeds `opts.maxErrors` (default 10) — that's a sign something is
 * systematically broken.
 */
export async function runCycles(
  n: number,
  opts?: RunCyclesOptions
): Promise<CycleSummary[]> {
  const delayMs = opts?.delayMs ?? 1000;
  const maxErrors = opts?.maxErrors ?? 10;
  const summaries: CycleSummary[] = [];

  let totalErrors = 0;
  for (let i = 0; i < n; i++) {
    const summary = await runCycle();
    summaries.push(summary);
    totalErrors += summary.errors.length;

    if (summary.skipped && summary.skipReason?.includes("emergency")) {
      // Emergency stop — abort the batch immediately.
      break;
    }
    if (totalErrors > maxErrors) {
      await logEvent(
        "orchestrator",
        "error",
        "run_cycles_aborted_too_many_errors",
        { cyclesRun: i + 1, totalErrors, maxErrors },
        { runId: generateCycleRunId() }
      );
      break;
    }

    if (i < n - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeMarkCycle(result: string): Promise<void> {
  try {
    await markCycle(result);
  } catch (err) {
    console.error("[loop] markCycle failed:", err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a fresh runId for one orchestrator cycle. Prefers the Web
 * Crypto UUID (available in the Next.js 16 server runtime); falls back to
 * a small random string when unavailable. Re-uses the per-process runId
 * generator from `events.ts` when crypto is unavailable so the value is
 * always non-empty.
 */
function generateCycleRunId(): string {
  try {
    if (
      typeof globalThis !== "undefined" &&
      typeof globalThis.crypto?.randomUUID === "function"
    ) {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // ignore — fall through
  }
  return getProcessRunId();
}

// ---------------------------------------------------------------------------
// recordCycleLesson — Phase-2 P3-2
// ---------------------------------------------------------------------------

/**
 * Record a cross-cycle memory when an opportunity reaches a terminal state
 * (paid / failed / rejected). The lesson generalizes the outcome so future
 * cycles can bias decisions toward proven approaches + away from known-bad
 * ones.
 *
 * Categories recorded:
 *   - strategy_insight: "strategy X → paid Y% of the time"
 *   - execution_lesson: "category X → failed because <reason>"
 *   - scam_pattern: "source/title pattern X → rejected as scam"
 *
 * Corroborating evidence bumps the confidence EMA (see recordMemory).
 */
async function recordCycleLesson(
  processed: ProcessOpportunityResult,
  opportunityId: string,
  strategy: string | null
): Promise<void> {
  const finalStatus = processed.finalStatus;
  if (!finalStatus) return;

  // Load the opportunity to get the category + source for the lesson.
  const op = await db.opportunity.findUnique({
    where: { id: opportunityId },
    select: {
      title: true,
      category: true,
      source: true,
      sourceUrl: true,
      organization: true,
      riskScore: true,
      verificationScore: true,
      rewardAmount: true,
      rewardCurrency: true,
      expectedValue: true,
    },
  });
  if (!op) return;

  const tags = [op.category, op.source].filter(Boolean) as string[];

  // --- Paid → strategy insight ---
  if (finalStatus === "paid") {
    await recordMemory({
      category: "strategy_insight",
      title: `${op.category}: opportunity reached PAID state`,
      body: `An opportunity in category "${op.category}" from source "${op.source}" (org: ${op.organization}) reached the PAID terminal state. Expected value was $${(op.expectedValue ?? 0).toFixed(2)}; reward was ${op.rewardAmount} ${op.rewardCurrency}. This strategy works — bias future effort toward similar opportunities.`,
      payload: {
        category: op.category,
        source: op.source,
        organization: op.organization,
        expectedValue: op.expectedValue,
        rewardAmount: op.rewardAmount,
        rewardCurrency: op.rewardCurrency,
        stepCount: processed.steps.length,
      },
      tags,
      confidence: 0.8,
      opportunityId,
      agent: "orchestrator",
    });
    return;
  }

  // --- Rejected (scam) → scam pattern ---
  if (finalStatus === "rejected") {
    await recordMemory({
      category: "scam_pattern",
      title: `${op.source}: opportunity rejected (riskScore=${op.riskScore})`,
      body: `An opportunity from source "${op.source}" titled "${op.title.slice(0, 80)}" was rejected with riskScore=${op.riskScore}/100 + verificationScore=${op.verificationScore}/100. Watch for similar patterns from this source or organization.`,
      payload: {
        source: op.source,
        organization: op.organization,
        riskScore: op.riskScore,
        verificationScore: op.verificationScore,
        titleSnippet: op.title.slice(0, 120),
      },
      tags: [...tags, "scam", "rejected"],
      confidence: 0.7,
      opportunityId,
      agent: "orchestrator",
    });
    return;
  }

  // --- Failed → execution lesson ---
  if (finalStatus === "failed") {
    const failureReason = processed.abortReason ?? "unknown";
    await recordMemory({
      category: "execution_lesson",
      title: `${op.category}: opportunity FAILED — ${failureReason.slice(0, 80)}`,
      body: `An opportunity in category "${op.category}" from source "${op.source}" reached the FAILED terminal state. Reason: ${failureReason}. The approach for this category may need adjustment — consider a different specialist, model, or execution adapter.`,
      payload: {
        category: op.category,
        source: op.source,
        organization: op.organization,
        failureReason,
        stepCount: processed.steps.length,
        steps: processed.steps.map((s) => ({
          agent: s.agent,
          success: s.success,
          notes: s.notes,
        })),
      },
      tags: [...tags, "failed"],
      confidence: 0.6,
      opportunityId,
      agent: "orchestrator",
    });
    return;
  }

  // Non-terminal states (queued, executed, awaiting_payment, etc.) don't
  // generate a lesson yet — the outcome is still pending.
}
