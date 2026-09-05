// Opportunity verification engine (spec §6).
//
// Runs a deterministic set of authenticity / sanity checks over each
// opportunity and rolls them into a 0..100 `verificationScore`. The score
// bands map to a 3-tier verdict:
//
//   0 – 30  → SUSPICIOUS  (do not pursue without human review)
//   31 – 60 → UNVERIFIED  (research agent should look closer)
//   61 – 100→ VERIFIED    (safe to enqueue for planning)
//
// Like the scam detector, this module is a pure function — no I/O, no side
// effects, no LLM calls. The LLM is free to recommend additional verification
// steps, but these checks always have final authority (spec §6).

import type {
  VerificationCheck,
  VerificationResult,
  VerificationTier,
} from "@/lib/agent/types";
import type { NormalizedOpportunity } from "@/lib/agent/normalize";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run deterministic verification checks against a normalized opportunity.
 *
 * @param opportunity normalized opportunity to inspect
 * @returns a {@link VerificationResult} with `tier`, `verificationScore`,
 *          `riskScore` (100 − verificationScore), `confidence`, and a list of
 *          `checks` explaining the verdict.
 */
export function verifyOpportunity(
  opportunity: NormalizedOpportunity
): VerificationResult {
  const checks: VerificationCheck[] = [];

  // Source authenticity
  checks.push(checkSourceHttps(opportunity));
  checks.push(checkTrustedHost(opportunity));
  checks.push(checkOrganizationAuthenticity(opportunity));

  // Reward + deadline + payment
  checks.push(checkRewardExistence(opportunity));
  checks.push(checkDeadlineValid(opportunity));
  checks.push(checkPaymentMethodSpecified(opportunity));

  // Red flags
  checks.push(checkCapitalRequired(opportunity));
  checks.push(checkPrivateKeyRequired(opportunity));

  const verificationScore = computeScore(checks);
  const tier = scoreToTier(verificationScore);
  const riskScore = clamp(100 - verificationScore, 0, 100);
  const confidence = clamp(verificationScore / 100, 0, 1);

  return { tier, verificationScore, riskScore, confidence, checks };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkSourceHttps(op: NormalizedOpportunity): VerificationCheck {
  if (!op.sourceUrl) {
    return fail("source_https", "critical", "Source URL is missing.");
  }
  try {
    const u = new URL(op.sourceUrl);
    if (u.protocol === "https:") {
      return pass("source_https", "Source URL uses HTTPS.");
    }
    return fail(
      "source_https",
      "critical",
      `Source URL is not HTTPS (protocol=${u.protocol}).`
    );
  } catch {
    return fail("source_https", "critical", "Source URL is malformed.");
  }
}

function checkTrustedHost(op: NormalizedOpportunity): VerificationCheck {
  if (!op.sourceUrl) {
    return fail("trusted_host", "warn", "No source URL to verify host.");
  }
  try {
    const host = new URL(op.sourceUrl).hostname.toLowerCase();
    const isTrusted = Array.from(TRUSTED_HOSTS).some(
      (t) => host === t || host.endsWith(`.${t}`)
    );
    if (isTrusted) {
      return pass("trusted_host", `Source host ${host} is on the trusted-hosts list.`);
    }
    return fail(
      "trusted_host",
      "warn",
      `Source host ${host} is not on the trusted-hosts list (review manually).`
    );
  } catch {
    return fail("trusted_host", "warn", "Malformed source URL — cannot verify host.");
  }
}

function checkOrganizationAuthenticity(
  op: NormalizedOpportunity
): VerificationCheck {
  const org = (op.organization ?? "").trim();
  if (org.length === 0) {
    return fail(
      "organization_authenticity",
      "warn",
      "Organization name is empty."
    );
  }
  if (org.length < 3) {
    return fail(
      "organization_authenticity",
      "warn",
      `Organization name '${org}' is suspiciously short (<3 chars).`
    );
  }
  // If the source URL is on a trusted host, we accept the org as-is.
  try {
    const host = new URL(op.sourceUrl).hostname.toLowerCase();
    const trusted = Array.from(TRUSTED_HOSTS).some(
      (t) => host === t || host.endsWith(`.${t}`)
    );
    if (trusted) {
      return pass(
        "organization_authenticity",
        `Organization '${org}' publishes on a trusted host.`
      );
    }
  } catch {
    // ignore — already covered by source_https check
  }
  // Otherwise require the org slug to appear in the host.
  const orgSlug = org.toLowerCase().replace(/[^a-z0-9]+/g, "");
  try {
    const host = new URL(op.sourceUrl).hostname.toLowerCase();
    const sld = host.split(".").slice(-2, -1)[0] ?? "";
    if (orgSlug && sld && (sld.includes(orgSlug) || orgSlug.includes(sld))) {
      return pass(
        "organization_authenticity",
        `Organization '${org}' aligns with source host '${host}'.`
      );
    }
    return fail(
      "organization_authenticity",
      "warn",
      `Organization '${org}' does not match source host '${host}'.`
    );
  } catch {
    return fail(
      "organization_authenticity",
      "warn",
      "Cannot parse source URL to validate organization alignment."
    );
  }
}

function checkRewardExistence(op: NormalizedOpportunity): VerificationCheck {
  const amount = Number(op.reward?.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail(
      "reward_existence",
      "warn",
      "No reward amount declared — value is unknown."
    );
  }
  if (amount > 50_000) {
    return fail(
      "reward_existence",
      "warn",
      `Reward amount $${amount} is implausibly large — manual review required.`
    );
  }
  return pass("reward_existence", `Reward declared: ${amount} ${op.reward.currency}.`);
}

function checkDeadlineValid(op: NormalizedOpportunity): VerificationCheck {
  if (!op.deadline) {
    // Null deadline is allowed but flagged as info — verification treats it as
    // an open-ended opportunity rather than a scam signal.
    return {
      name: "deadline_valid",
      passed: true,
      severity: "info",
      detail: "No deadline declared — opportunity is open-ended.",
    };
  }
  const t = Date.parse(op.deadline);
  if (!Number.isFinite(t)) {
    return fail("deadline_valid", "warn", "Deadline is not a parseable date.");
  }
  const now = Date.now();
  if (t < now) {
    return fail(
      "deadline_valid",
      "critical",
      `Deadline ${op.deadline} is in the past.`
    );
  }
  return pass("deadline_valid", `Deadline ${op.deadline} is in the future.`);
}

function checkPaymentMethodSpecified(
  op: NormalizedOpportunity
): VerificationCheck {
  const method = (op.paymentMethod ?? "").trim();
  if (method.length === 0) {
    return fail(
      "payment_method_specified",
      "warn",
      "No payment method declared."
    );
  }
  if (/private\s*key|seed\s*phrase/i.test(method)) {
    return fail(
      "payment_method_specified",
      "critical",
      `Payment method '${method}' requests secrets.`
    );
  }
  return pass(
    "payment_method_specified",
    `Payment method: ${method}.`
  );
}

function checkCapitalRequired(op: NormalizedOpportunity): VerificationCheck {
  if (op.capitalRequired) {
    return fail(
      "capital_required",
      "warn",
      "Opportunity requires upfront capital — flagged for review."
    );
  }
  return pass("capital_required", "Opportunity requires no upfront capital.");
}

function checkPrivateKeyRequired(
  op: NormalizedOpportunity
): VerificationCheck {
  const haystack = [
    op.description,
    op.paymentMethod,
    ...(op.requirements ?? []),
    ...(op.eligibility ?? []),
  ]
    .join("\n")
    .toLowerCase();
  if (/private\s*key|seed\s*phrase|mnemonic/.test(haystack)) {
    return fail(
      "private_key_required",
      "critical",
      "Opportunity requests a private key or seed phrase — hard reject signal."
    );
  }
  return pass(
    "private_key_required",
    "Opportunity does not request private keys or seed phrases."
  );
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHT: Record<VerificationCheck["severity"], number> = {
  critical: 25,
  warn: 12,
  info: 4,
};

/**
 * Compute the verification score (0..100) from the checks list. Each check
 * contributes its weight when it passes; failing critical checks pull the
 * score down harder than failing info checks.
 */
function computeScore(checks: VerificationCheck[]): number {
  let earned = 0;
  let maxPossible = 0;
  for (const c of checks) {
    const weight = SEVERITY_WEIGHT[c.severity];
    maxPossible += weight;
    if (c.passed) earned += weight;
  }
  if (maxPossible === 0) return 0;
  return clamp(Math.round((earned / maxPossible) * 100), 0, 100);
}

function scoreToTier(score: number): VerificationTier {
  if (score <= 30) return "SUSPICIOUS";
  if (score <= 60) return "UNVERIFIED";
  return "VERIFIED";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pass(name: string, detail: string): VerificationCheck {
  return { name, passed: true, severity: "info", detail };
}

function fail(
  name: string,
  severity: VerificationCheck["severity"],
  detail: string
): VerificationCheck {
  return { name, passed: false, severity, detail };
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

const TRUSTED_HOSTS = new Set([
  "github.com",
  "gitcoin.co",
  "onlydust.com",
  "optimism.io",
  "ethereum.foundation",
  "esp.ethereum.foundation",
  "dune.com",
  "mirror.xyz",
  "replit.com",
  "vercel.com",
  "polygon.technology",
  "0xpolygon.github.io",
  "solana.com",
  "solana-foundation.github.io",
  "hackathon.com",
  "juicebox.money",
  "lens.xyz",
  "lens-protocol.github.io",
]);
