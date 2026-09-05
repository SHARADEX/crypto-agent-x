// Scout Agent (spec §4B).
//
// The Scout is responsible for DISCOVERY ONLY — it monitors configured sources,
// detects newly published opportunities, normalises them, and persists them to
// the DB via `runDiscoveryCycle()`. It MUST NOT execute opportunities.
//
// This agent is a thin wrapper around the discovery cycle so the orchestrator
// can invoke discovery as a regular specialist step (creating a Task row,
// recording event logs, returning a structured summary). The cycle itself
// lives in `src/lib/agent/scanners/index.ts` so it can be called directly by
// the autonomous loop without going through this agent.

import { runDiscoveryCycle } from "@/lib/agent/scanners";
import { logEvent } from "@/lib/agent/events";
import type { AgentInput, AgentOutput } from "@/lib/agents/types";
import { fail, ok } from "@/lib/agents/types";

// ---------------------------------------------------------------------------
// execute — discovery-only entry point
// ---------------------------------------------------------------------------

/**
 * Run a discovery cycle. Returns a summary of what was discovered, deduped,
 * and persisted this cycle.
 *
 * The Scout never executes opportunities. It just surfaces them so the
 * orchestrator can hand them off to the Research → Verification → Economics
 * → Planning → Execution pipeline.
 *
 * Spec §4B: "It should NOT execute opportunities."
 */
export async function execute(input: AgentInput): Promise<AgentOutput> {
  const taskId = (input.task?.id as string | undefined) ?? undefined;
  const opportunityId =
    (input.opportunity?.id as string | undefined) ?? undefined;

  try {
    const summary = await runDiscoveryCycle();

    if (summary.skipped) {
      await logEvent(
        "scout",
        "info",
        "scout_cycle_skipped",
        { reason: summary.skipReason ?? "unknown" },
        { taskId, opportunityId }
      );
      return ok(
        {
          skipped: true,
          reason: summary.skipReason ?? "unknown",
          discovered: 0,
          new: 0,
          duplicates: 0,
          rejected: 0,
          byCategory: {},
          scannerErrors: summary.scannerErrors,
        },
        { notes: [`Scout cycle skipped: ${summary.skipReason}`] }
      );
    }

    await logEvent(
      "scout",
      summary.new > 0 ? "info" : "debug",
      "scout_cycle_complete",
      {
        discovered: summary.discovered,
        new: summary.new,
        duplicates: summary.duplicates,
        rejected: summary.rejected,
        byCategory: summary.byCategory,
        scannerErrors: summary.scannerErrors,
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
      },
      { taskId, opportunityId }
    );

    return ok(
      {
        skipped: false,
        discovered: summary.discovered,
        new: summary.new,
        duplicates: summary.duplicates,
        rejected: summary.rejected,
        byCategory: summary.byCategory,
        scannerErrors: summary.scannerErrors,
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
      },
      {
        notes: [
          `Discovered ${summary.discovered} (${summary.new} new, ${summary.duplicates} duplicates, ${summary.rejected} rejected).`,
        ],
        nextAgent: "research",
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[scout-agent] execute threw:", err);
    await logEvent(
      "scout",
      "error",
      "scout_cycle_failed",
      { error: message },
      { taskId, opportunityId }
    );
    return fail(`scout cycle crashed: ${message}`);
  }
}
