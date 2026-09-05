// Verification Agent (spec §4B).
//
// Combines the deterministic `verifyOpportunity` engine with the Security
// Agent's `analyzeOpportunity` to produce a unified VerificationResult.
// Persists `riskScore` / `verificationScore` / `confidence` to the
// Opportunity row and decides the opportunity's tier (VERIFIED /
// UNVERIFIED / SUSPICIOUS).
//
// Hard rule (spec §21): "Security Agent recommendations must never override
// deterministic security policies." Concretely, if the combined `riskScore`
// crosses 70, the opportunity is marked `rejected` regardless of what the
// LLM-based analysis says.
//
// Spec §6 tier thresholds:
//   0 – 30  → SUSPICIOUS  (do not pursue without human review)
//   31 – 60 → UNVERIFIED  (research agent should look closer)
//   61 – 100→ VERIFIED    (safe to enqueue for planning)

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import { verifyOpportunity } from "@/lib/agent/verification";
import { analyzeOpportunity } from "@/lib/agents/security-agent";
import type {
  Opportunity as OpportunityType,
  VerificationResult,
  VerificationTier,
} from "@/lib/agent/types";
import type { NormalizedOpportunity } from "@/lib/agent/normalize";
import type { AgentInput, AgentOutput } from "@/lib/agents/types";
import { fail, fieldStringArray, ok } from "@/lib/agents/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VerificationAgentResult {
  tier: VerificationTier;
  verificationScore: number;
  riskScore: number;
  confidence: number;
  securitySafe: boolean;
  securityShouldBlock: boolean;
  securityRecommendations: string[];
  nextStatus: "verified" | "rejected" | "discovered";
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

export async function execute(input: AgentInput): Promise<AgentOutput> {
  const taskId = (input.task?.id as string | undefined) ?? undefined;
  const opportunityId =
    (input.opportunity?.id as string | undefined) ?? undefined;

  if (!opportunityId) {
    return fail("verification agent requires an opportunity id");
  }

  try {
    const op = await db.opportunity.findUnique({
      where: { id: opportunityId },
    });
    if (!op) {
      return fail(`opportunity ${opportunityId} not found`);
    }

    // Build the NormalizedOpportunity shape that `verifyOpportunity` expects.
    const normalized: NormalizedOpportunity = {
      canonicalId: op.canonicalId,
      title: op.title,
      description: op.description,
      source: op.source,
      sourceUrl: op.sourceUrl,
      organization: op.organization,
      category: op.category as NormalizedOpportunity["category"],
      reward: {
        amount: op.rewardAmount,
        currency: op.rewardCurrency,
        estimated_usd: op.rewardUsd,
      },
      deadline: op.deadline ? op.deadline.toISOString() : null,
      requirements: fieldStringArray({ requirements: op.requirements }, "requirements"),
      skillsRequired: fieldStringArray({ skillsRequired: op.skillsRequired }, "skillsRequired"),
      estimatedHours: op.estimatedHours,
      difficulty: op.difficulty,
      competition: op.competition,
      eligibility: fieldStringArray({ eligibility: op.eligibility }, "eligibility"),
      paymentMethod: op.paymentMethod,
      capitalRequired: op.capitalRequired,
      dedupHash: op.dedupHash ?? "",
    };

    // --- 1. Deterministic verification checks (spec §6) --------------------
    const verification: VerificationResult = verifyOpportunity(normalized);

    // --- 2. Security Agent analysis (spec §21) -----------------------------
    const securityInput: Pick<
      OpportunityType,
      "id" | "title" | "description" | "sourceUrl" | "requirements" | "riskScore"
    > = {
      id: op.id,
      title: op.title,
      description: op.description,
      sourceUrl: op.sourceUrl,
      requirements: fieldStringArray({ requirements: op.requirements }, "requirements"),
      riskScore: op.riskScore,
    };
    const security = await analyzeOpportunity(securityInput);

    // --- 3. Combine into the final riskScore ------------------------------
    // Deterministic policy: scam-detection riskScore dominates; security
    // analysis can ADD but never reduce (spec §21).
    const combinedRisk = clamp(
      Math.max(op.riskScore, security.riskScore),
      0,
      100
    );
    const finalVerificationScore = clamp(
      verification.verificationScore,
      0,
      100
    );
    const finalConfidence = clamp(
      verification.confidence * (1 - combinedRisk / 100),
      0,
      1
    );
    const tier = scoreToTier(finalVerificationScore);

    // --- 4. Persist the verdict to the opportunity ------------------------
    // Hard cap (spec §7, §11): riskScore >= 70 → REJECT.
    const nextStatus: "verified" | "rejected" | "discovered" =
      combinedRisk >= 70
        ? "rejected"
        : tier === "VERIFIED"
        ? "verified"
        : "discovered";

    try {
      await db.opportunity.update({
        where: { id: opportunityId },
        data: {
          status: nextStatus,
          riskScore: combinedRisk,
          verificationScore: finalVerificationScore,
          confidence: finalConfidence,
        },
      });
    } catch (err) {
      console.error("[verification-agent] DB update failed:", err);
    }

    if (nextStatus === "rejected") {
      await logEvent(
        "verification",
        "critical",
        "opportunity_rejected_high_risk",
        {
          opportunityId,
          riskScore: combinedRisk,
          verificationScore: finalVerificationScore,
          tier,
          securityRecommendations: security.recommendations,
        },
        { taskId, opportunityId }
      );
    } else {
      await logEvent(
        "verification",
        tier === "VERIFIED" ? "info" : "warn",
        "opportunity_verified",
        {
          opportunityId,
          tier,
          riskScore: combinedRisk,
          verificationScore: finalVerificationScore,
          confidence: finalConfidence,
          securitySafe: security.safe,
          securityShouldBlock: security.shouldBlock,
        },
        { taskId, opportunityId }
      );
    }

    const result: VerificationAgentResult = {
      tier,
      verificationScore: finalVerificationScore,
      riskScore: combinedRisk,
      confidence: finalConfidence,
      securitySafe: security.safe,
      securityShouldBlock: security.shouldBlock,
      securityRecommendations: security.recommendations,
      nextStatus,
    };

    return ok(
      result as unknown as Record<string, unknown>,
      {
        qualityScore: clamp(finalVerificationScore / 10, 0, 10),
        nextAgent:
          nextStatus === "rejected"
            ? undefined
            : nextStatus === "verified"
            ? "economics"
            : "research",
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[verification-agent] execute threw:", err);
    await logEvent(
      "verification",
      "error",
      "verification_failed",
      { opportunityId, error: message },
      { taskId, opportunityId }
    );
    return fail(`verification agent crashed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreToTier(score: number): VerificationTier {
  if (score <= 30) return "SUSPICIOUS";
  if (score <= 60) return "UNVERIFIED";
  return "VERIFIED";
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
