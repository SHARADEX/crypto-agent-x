// Deterministic policy engine (spec §11, §18, §21).
//
// The agent's pipeline is:
//
//     LLM proposes action → deterministic validator → policy engine → executor
//
// The LLM is never allowed to override the decisions made here. The rules
// below are pure, deterministic functions of (opportunity, autonomyMode,
// action). They are intentionally conservative: when in doubt, require a
// higher ExecutionLevel + human approval rather than auto-proceeding.
//
// ExecutionLevel mapping (spec §11):
//   - Level 0  — read-only observation (no side effects)
//   - Level 1  — autonomous allowed in `full` autonomy mode
//   - Level 2  — requires `semi`/`full` autonomy OR a human approval
//   - Level 3  — ALWAYS requires a human approval, regardless of autonomy

import type {
  AutonomyMode,
  ExecutionLevel,
  Opportunity,
  RiskLevel,
} from "@/lib/agent/types";
import { getState } from "@/lib/agent/state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolicyVerdict {
  allowed: boolean;
  requiredLevel: ExecutionLevel;
  reason: string;
}

export interface PolicyAction {
  /** Short stable identifier, e.g. `web_request`, `rpc_call`, `submission`. */
  type: string;
  /** Determined by the deterministic validator (spec §18 step 2). */
  riskLevel: RiskLevel;
  opportunityId?: string;
  details?: Record<string, unknown>;
}

export interface PolicyContext {
  /** Defaults to the persistent AgentState.autonomyMode if omitted. */
  autonomyMode?: AutonomyMode;
  opportunity?: Opportunity;
  taskId?: string;
}

export class PolicyError extends Error {
  readonly verdict: PolicyVerdict;
  constructor(verdict: PolicyVerdict) {
    super(verdict.reason);
    this.name = "PolicyError";
    this.verdict = verdict;
  }
}

// ---------------------------------------------------------------------------
// Risk → ExecutionLevel mapping (spec §11)
// ---------------------------------------------------------------------------

/**
 * Map a `RiskLevel` to the minimum required `ExecutionLevel`.
 *
 *   read       → 0  (observation only)
 *   low        → 1  (autonomous in `full`)
 *   moderate   → 2  (semi/full or approval)
 *   high       → 3  (approval ALWAYS required)
 */
export function riskLevelToExecutionLevel(risk: RiskLevel): ExecutionLevel {
  switch (risk) {
    case "read":
      return 0;
    case "low":
      return 1;
    case "moderate":
      return 2;
    case "high":
      return 3;
  }
}

// ---------------------------------------------------------------------------
// evaluateRisk(opportunity)
// ---------------------------------------------------------------------------

const REFERRAL_OR_AIRDROP = /referral|airdrop/i;
const LARGE_REWARD_THRESHOLD = 1000; // USD-equivalent in opportunity.reward.amount

/**
 * Evaluate the deterministic policy verdict for a given opportunity.
 *
 * Rules (applied in priority order — first rejection wins):
 *   1. riskScore > 70 → reject
 *   2. capitalRequired && autonomyMode === 'observe' → reject
 *   3. reward.amount > $1000 && !paymentVerified → reject (financial risk)
 *   4. category includes "referral" or "airdrop" → require level 3
 *
 * Otherwise the required ExecutionLevel is derived from the opportunity's
 * riskScore band:
 *   - 0..30 → level 1
 *   - 31..55 → level 2
 *   - 56..70 → level 3
 *
 * @param opportunity  the normalized opportunity to evaluate
 * @param opts.autonomyMode override of the persistent autonomy mode
 */
export function evaluateRisk(
  opportunity: Opportunity,
  opts?: { autonomyMode?: AutonomyMode }
): PolicyVerdict {
  const autonomyMode: AutonomyMode =
    opts?.autonomyMode ?? "observe";

  // Rule 1: hard risk cap
  if (opportunity.riskScore > 70) {
    return {
      allowed: false,
      requiredLevel: 3,
      reason: `riskScore ${opportunity.riskScore} exceeds 70 (scam-risk hard cap).`,
    };
  }

  // Rule 2: capital-requiring opportunities are off-limits in observe mode
  if (opportunity.capitalRequired && autonomyMode === "observe") {
    return {
      allowed: false,
      requiredLevel: 3,
      reason:
        "opportunity requires capital and agent is in observe autonomy mode.",
    };
  }

  // Rule 3: large reward from unverified payment source
  // Be defensive: the DB Opportunity has flat `rewardAmount` while the
  // canonical Opportunity type has nested `reward.amount`. Accept either.
  const rewardAmount =
    (opportunity as Opportunity).reward?.amount ??
    (opportunity as unknown as { rewardAmount?: number }).rewardAmount ??
    0;
  if (
    rewardAmount > LARGE_REWARD_THRESHOLD &&
    !opportunity.paymentVerified
  ) {
    return {
      allowed: false,
      requiredLevel: 3,
      reason:
        "reward > $1000 from an unverified payment source (financial risk).",
    };
  }

  // Rule 4: referral / airdrop categories always need human approval (level 3)
  const isReferralOrAirdrop =
    REFERRAL_OR_AIRDROP.test(opportunity.category) ||
    REFERRAL_OR_AIRDROP.test(opportunity.organization ?? "") ||
    REFERRAL_OR_AIRDROP.test(opportunity.title ?? "");
  if (isReferralOrAirdrop) {
    return {
      allowed: true,
      requiredLevel: 3,
      reason:
        "referral/airdrop category requires human approval (spec §3 prohibition perimeter).",
    };
  }

  // Default banding on riskScore
  let requiredLevel: ExecutionLevel;
  if (opportunity.riskScore <= 30) {
    requiredLevel = 1;
  } else if (opportunity.riskScore <= 55) {
    requiredLevel = 2;
  } else {
    requiredLevel = 3;
  }

  // In observe mode everything above read-only requires human approval.
  if (autonomyMode === "observe" && requiredLevel > 0) {
    requiredLevel = 3;
  }

  return {
    allowed: true,
    requiredLevel,
    reason: `riskScore=${opportunity.riskScore}, autonomyMode=${autonomyMode}`,
  };
}

// ---------------------------------------------------------------------------
// assertPolicy(action, ctx)
// ---------------------------------------------------------------------------

/**
 * Decide whether a proposed external `action` may be executed, given the
 * current policy context. Throws a `PolicyError` if the action is denied.
 *
 * This is the final gate before any external side effect (web request, RPC,
 * submission, transaction). The LLM is never given a path around it (spec §21).
 *
 * Decision matrix:
 *   - read actions: always allowed
 *   - level 1 actions: require autonomyMode in [semi, full]
 *   - level 2 actions: require autonomyMode in [semi, full]
 *   - level 3 actions: require an existing approved Approval row OR `full`
 *     autonomy (the executor is expected to have called `requestApproval`
 *     first; this gate only verifies it landed)
 *
 * @param action  the proposed external action
 * @param ctx     policy context (autonomyMode, opportunity, taskId)
 */
export async function assertPolicy(
  action: PolicyAction,
  ctx?: PolicyContext
): Promise<PolicyVerdict> {
  const autonomyMode: AutonomyMode =
    ctx?.autonomyMode ?? (await getState()).autonomyMode;

  const requiredLevel = riskLevelToExecutionLevel(action.riskLevel);

  // Level 0 — pure observation. Always allowed.
  if (requiredLevel === 0) {
    return {
      allowed: true,
      requiredLevel: 0,
      reason: `read-only action '${action.type}' always permitted.`,
    };
  }

  // Level 3 — always requires human approval (even in `full` autonomy we
  // require an explicit Approval row). The caller is expected to have created
  // one via `requestApproval` prior to calling `assertPolicy`.
  if (requiredLevel === 3) {
    // We do not query the Approval table here directly — that's the
    // executor's responsibility. We just refuse to green-light the action
    // unless an approval token was supplied in the context.
    return {
      allowed: false,
      requiredLevel: 3,
      reason: `action '${action.type}' is risk-level 'high'; requires a human-approved Approval row.`,
    };
  }

  // Levels 1–2 — gated by autonomy mode.
  if (autonomyMode === "observe" || autonomyMode === "assist") {
    return {
      allowed: false,
      requiredLevel,
      reason: `autonomy mode '${autonomyMode}' does not permit level ${requiredLevel} actions.`,
    };
  }

  // `semi` permits level 1 only; `full` permits 1 and 2.
  if (requiredLevel === 2 && autonomyMode !== "full") {
    return {
      allowed: false,
      requiredLevel: 2,
      reason: `autonomy mode '${autonomyMode}' does not permit level 2 actions.`,
    };
  }

  return {
    allowed: true,
    requiredLevel,
    reason: `autonomy mode '${autonomyMode}' permits level ${requiredLevel} action '${action.type}'.`,
  };
}
