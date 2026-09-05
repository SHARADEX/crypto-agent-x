// Economics Agent (spec §4B, §8).
//
// Computes the opportunity's economic estimate via the deterministic
// `computeEconomics` engine (spec §8 — the LLM is NEVER given a path to do
// final arithmetic). Persists `expectedValue`, `expectedHourly`, and
// `riskAdjustedHourly` to the Opportunity row and returns the full
// `EconomicsEstimate` for the orchestrator to compare opportunities.
//
// Inputs sourced from the DB:
//   - opportunity fields (reward, hours, difficulty, risk, verification,
//     capitalRequired, deadline)
//   - SourceReputation.reliability for the opportunity's `source` (default 50)
//   - agentSkillMatch = |skillsRequired ∩ AGENT_CAPABLE_SKILLS| / max(1, |skillsRequired|)
//
// The agent never throws. Failures return `{ success: false, result: { error } }`.

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import { computeEconomics, scoreOpportunity } from "@/lib/economics/engine";
import { AGENT_CAPABLE_SKILLS } from "@/config/sources";
import type { AgentInput, AgentOutput } from "@/lib/agents/types";
import { fail, fieldStringArray, ok } from "@/lib/agents/types";

// ---------------------------------------------------------------------------
// Default source reliability when no `SourceReputation` row exists.
// ---------------------------------------------------------------------------

const DEFAULT_SOURCE_RELIABILITY = 50;

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

export async function execute(input: AgentInput): Promise<AgentOutput> {
  const taskId = (input.task?.id as string | undefined) ?? undefined;
  const opportunityId =
    (input.opportunity?.id as string | undefined) ?? undefined;

  if (!opportunityId) {
    return fail("economics agent requires an opportunity id");
  }

  try {
    const op = await db.opportunity.findUnique({
      where: { id: opportunityId },
    });
    if (!op) {
      return fail(`opportunity ${opportunityId} not found`);
    }

    // --- 1. Look up source reliability (default 50 if missing) -----------
    let sourceReliability = DEFAULT_SOURCE_RELIABILITY;
    try {
      const rep = await db.sourceReputation.findUnique({
        where: { source: op.source },
        select: { reliability: true },
      });
      if (rep && Number.isFinite(rep.reliability)) {
        sourceReliability = clamp(rep.reliability, 0, 100);
      }
    } catch (err) {
      console.warn(
        `[economics-agent] SourceReputation lookup failed for '${op.source}':`,
        err
      );
    }

    // --- 2. Compute agent skill match -------------------------------------
    const skillsRequired = fieldStringArray(
      { skillsRequired: op.skillsRequired },
      "skillsRequired"
    );
    const skillMatch = computeAgentSkillMatch(skillsRequired);

    // --- 3. Run the deterministic economics engine (spec §8) -------------
    const { estimate, patch } = scoreOpportunity(
      {
        id: op.id,
        rewardUsd: op.rewardUsd,
        estimatedHours: op.estimatedHours,
        difficulty: op.difficulty,
        competition: op.competition,
        riskScore: op.riskScore,
        verificationScore: op.verificationScore,
        capitalRequired: op.capitalRequired,
        deadline: op.deadline,
        source: op.source,
      },
      sourceReliability,
      skillMatch
    );

    // --- 4. Persist the patch ---------------------------------------------
    try {
      await db.opportunity.update({
        where: { id: opportunityId },
        data: patch,
      });
    } catch (err) {
      console.error("[economics-agent] DB update failed:", err);
    }

    await logEvent(
      "economics",
      "info",
      "economics_estimate_computed",
      {
        opportunityId,
        sourceReliability,
        agentSkillMatch: skillMatch,
        expectedValue: estimate.expected_value,
        expectedHourly: estimate.expected_hourly_return,
        riskAdjustedHourly: estimate.risk_adjusted_hourly_return,
        unifiedScore: estimate.unified_score,
        probabilityOfSuccess: estimate.probability_of_success,
        paymentProbability: estimate.payment_probability,
      },
      { taskId, opportunityId }
    );

    return ok(
      {
        estimate,
        patch,
        sourceReliability,
        agentSkillMatch: skillMatch,
      } as unknown as Record<string, unknown>,
      {
        qualityScore: clamp(estimate.unified_score / 10, 0, 10),
        nextAgent: "orchestrator",
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[economics-agent] execute threw:", err);
    await logEvent(
      "economics",
      "error",
      "economics_estimate_failed",
      { opportunityId, error: message },
      { taskId, opportunityId }
    );
    return fail(`economics agent crashed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the agent's skill match (0..1) for an opportunity's required skills.
 *
 * Spec: `agentSkillMatch = |skillsRequired ∩ AGENT_CAPABLE_SKILLS| / max(1, |skillsRequired|)`.
 *
 * Empty `skillsRequired` returns 0.5 — we have no signal either way, so
 * we default to the neutral midpoint rather than pessimistically zero.
 */
export function computeAgentSkillMatch(skillsRequired: string[]): number {
  if (!Array.isArray(skillsRequired) || skillsRequired.length === 0) {
    return 0.5;
  }
  const capable = new Set(AGENT_CAPABLE_SKILLS.map((s) => s.toLowerCase()));
  const matched = skillsRequired.filter((s) =>
    capable.has(String(s).toLowerCase())
  ).length;
  return clamp(matched / skillsRequired.length, 0, 1);
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

// Re-export the pure engine functions for callers that want them.
export { computeEconomics, scoreOpportunity };
