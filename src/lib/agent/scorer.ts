// Opportunity scorer (spec §7, §8 — economics layer is a separate task).
//
// The scorer is the deterministic combine step that takes the verification
// result + scam-detection result and writes them onto the canonical
// `Opportunity` row. The economic expected-value / hourly-return / unified
// score calculations (spec §8) are deliberately left for Task ID 4 — this
// module only sets the risk / verification / confidence fields so that the
// policy engine has everything it needs to make an allow/deny decision.
//
// The scorer mutates and returns the same opportunity object (cheap, no
// defensive copy needed since the orchestrator owns the only reference).

import type {
  Opportunity,
  ScamDetectionResult,
  VerificationResult,
} from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply the verification + scam-detection verdicts to an opportunity, filling
 * in its `riskScore`, `verificationScore`, `confidence`, `paymentVerified`,
 * and `sourceVerified` fields.
 *
 * Combination rules:
 *   - `riskScore`         ← scam.riskScore (this is the field the policy
 *                            engine checks against the >70 hard cap).
 *   - `verificationScore` ← verification.verificationScore.
 *   - `confidence`        ← verification.confidence × (1 − scam.riskScore/100),
 *                            clamped to [0, 1]. A high-confidence verification
 *                            means little if the scam engine is also firing.
 *   - `paymentVerified`   ← true iff the verification engine's
 *                            `payment_method_specified` check passed AND the
 *                            scam engine did NOT flag private-key / seed /
 *                            upfront-payment signals.
 *   - `sourceVerified`    ← true iff both `source_https` and
 *                            `organization_authenticity` checks passed.
 *
 * @param opportunity the opportunity to update (mutated in place)
 * @param verification result from `verifyOpportunity`
 * @param scam         result from `detectScam`
 * @returns the same opportunity reference, with scores updated
 */
export function scoreOpportunity(
  opportunity: Opportunity,
  verification: VerificationResult,
  scam: ScamDetectionResult
): Opportunity {
  opportunity.riskScore = clampInt(scam.riskScore, 0, 100);
  opportunity.verificationScore = clampInt(verification.verificationScore, 0, 100);

  const safetyFactor = 1 - opportunity.riskScore / 100;
  opportunity.confidence = clamp(
    verification.confidence * safetyFactor,
    0,
    1
  );

  opportunity.paymentVerified = computePaymentVerified(verification, scam);
  opportunity.sourceVerified = computeSourceVerified(verification);

  return opportunity;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computePaymentVerified(
  verification: VerificationResult,
  scam: ScamDetectionResult
): boolean {
  const check = verification.checks.find(
    (c) => c.name === "payment_method_specified"
  );
  if (!check || !check.passed) return false;
  // Even if the method looks fine, if the scam engine flagged a key/seed/
  // upfront signal we cannot trust the payment pathway.
  const blockingSignals = new Set<ScamDetectionResult["signals"][number]>([
    "seed_phrase_request",
    "private_key_request",
    "upfront_payment",
    "wallet_drainer",
    "credential_harvesting",
  ]);
  if (scam.signals.some((s) => blockingSignals.has(s))) return false;
  return true;
}

function computeSourceVerified(verification: VerificationResult): boolean {
  const https = verification.checks.find((c) => c.name === "source_https");
  const org = verification.checks.find(
    (c) => c.name === "organization_authenticity"
  );
  const trusted = verification.checks.find((c) => c.name === "trusted_host");
  return Boolean(https?.passed && org?.passed && trusted?.passed);
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
