// Scam detection engine (spec §7).
//
// The agent's default posture (spec §7) is "when uncertain, do not execute."
// This module applies a deterministic set of scam-signal detectors over the
// normalized opportunity's title, description, requirements, eligibility,
// source URL, organization, and reward. Each triggered signal adds weighted
// risk points; if the cumulative `riskScore` crosses 70 the opportunity is
// flagged as a scam (`isScam = true`) and the policy engine will refuse to
// execute it.
//
// Signal weights:
//   critical → +40  (seed phrase / private key / wallet drainer / prohibited)
//   warn     → +15  (upfront payment / guaranteed profit / pyramid / domain
//                    mismatch / new account / unrealistic reward)
//   info     → +5   (capital required / etc.)
//
// The function is pure: same input → same output, no I/O, no side effects.

import { PROHIBITED_PATTERNS } from "@/config/sources";
import type {
  OpportunityCategory,
  ScamDetectionResult,
  ScamSignal,
} from "@/lib/agent/types";
import type { NormalizedOpportunity } from "@/lib/agent/normalize";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the deterministic scam-detection rules over a normalized opportunity.
 *
 * @param opportunity the normalized opportunity to inspect
 * @returns a {@link ScamDetectionResult} with `riskScore`, `signals[]`, and
 *          `isScam` flag. `riskScore` is clamped to 0..100.
 */
export function detectScam(
  opportunity: NormalizedOpportunity
): ScamDetectionResult {
  const signals: ScamSignal[] = [];
  const notes: string[] = [];
  let riskScore = 0;

  // Build a single lower-cased haystack across every text field an attacker
  // could influence.
  const haystack = buildHaystack(opportunity);

  // -- Critical signals (each +40) ----------------------------------------
  for (const rule of CRITICAL_RULES) {
    if (rule.test(haystack)) {
      if (!signals.includes(rule.signal)) {
        signals.push(rule.signal);
        riskScore += 40;
        notes.push(rule.note);
      }
    }
  }

  // -- Prohibited patterns (each +40, critical) ----------------------------
  for (const pattern of PROHIBITED_PATTERNS) {
    if (pattern.test(haystack)) {
      const signal: ScamSignal = "phishing";
      if (!signals.includes(signal)) {
        signals.push(signal);
        riskScore += 40;
        notes.push(
          `matched prohibited pattern: ${pattern.source} — content prohibited by spec §3.`
        );
      }
      // Don't break — keep scanning so notes capture every pattern.
    }
  }

  // -- Warn signals (each +15) --------------------------------------------
  for (const rule of WARN_RULES) {
    if (rule.test(opportunity, haystack)) {
      if (!signals.includes(rule.signal)) {
        signals.push(rule.signal);
        riskScore += 15;
        notes.push(rule.note);
      }
    }
  }

  // -- Info signals (each +5) ---------------------------------------------
  for (const rule of INFO_RULES) {
    if (rule.test(opportunity)) {
      if (!signals.includes(rule.signal)) {
        signals.push(rule.signal);
        riskScore += 5;
        notes.push(rule.note);
      }
    }
  }

  // Clamp + verdict
  riskScore = clamp(riskScore, 0, 100);
  const isScam = riskScore >= 70;

  return { isScam, riskScore, signals, notes };
}

// ---------------------------------------------------------------------------
// Haystack
// ---------------------------------------------------------------------------

function buildHaystack(op: NormalizedOpportunity): string {
  return [
    op.title,
    op.description,
    op.organization,
    op.paymentMethod,
    ...(op.requirements ?? []),
    ...(op.eligibility ?? []),
    ...(op.skillsRequired ?? []),
  ]
    .filter((s) => typeof s === "string" && s.length > 0)
    .join("\n")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

interface CriticalRule {
  signal: ScamSignal;
  test: (haystack: string) => boolean;
  note: string;
}

interface WarnRule {
  signal: ScamSignal;
  test: (op: NormalizedOpportunity, haystack: string) => boolean;
  note: string;
}

interface InfoRule {
  signal: ScamSignal;
  test: (op: NormalizedOpportunity) => boolean;
  note: string;
}

const CRITICAL_RULES: CriticalRule[] = [
  {
    signal: "seed_phrase_request",
    test: (h) =>
      /seed\s*phrase|mnemonic|12[-\s]?word|24[-\s]?word|recovery\s*phrase/.test(h),
    note: "Requests seed phrase / mnemonic — critical scam signal.",
  },
  {
    signal: "private_key_request",
    test: (h) =>
      /private\s*key|priv_key|paste\s*your\s*key|email\s*your\s*key|send\s*your\s*key/.test(
        h
      ),
    note: "Requests private key — critical scam signal.",
  },
  {
    signal: "wallet_drainer",
    test: (h) =>
      /wallet\s*drainer|connect\s*wallet\s*to\s*claim|approve.*claim.*transaction|sign.*to\s*claim/.test(
        h
      ),
    note: "Wallet-drainer pattern (connect/sign to claim) — critical scam signal.",
  },
  {
    signal: "guaranteed_profit",
    test: (h) =>
      /guaranteed\s*profit|guaranteed\s*return|risk[-\s]?free\s*profit|100%?\s*(free|profit|return)/.test(
        h
      ),
    note: "Guaranteed-profit / risk-free-return promise — critical scam signal.",
  },
];

const WARN_RULES: WarnRule[] = [
  {
    signal: "upfront_payment",
    test: (_op, h) =>
      /upfront\s*payment|deposit\s*required|gas\s*fee\s*required\s*upfront|registration\s*fee|activation\s*fee|verification\s*fee/.test(
        h
      ),
    note: "Upfront payment / deposit required — warn signal.",
  },
  {
    signal: "referral_pyramid",
    test: (_op, h) =>
      /invite\s*friends|referral\s*bonus|referral\s*link|pyramid|multi[-\s]?level|mlm\b/.test(
        h
      ),
    note: "Referral-pyramid / MLM pattern — warn signal.",
  },
  {
    signal: "fake_airdrop",
    test: (_op, h) =>
      /free\s*airdrop|free\s*eth\b|free\s*sol\b|free\s*btc|free\s*money|free\s*token/.test(
        h
      ),
    note: "Free-airdrop / free-money promise — warn signal.",
  },
  {
    signal: "domain_mismatch",
    test: (op, _h) => hasDomainMismatch(op),
    note: "Source URL host does not match the organization's claimed domain.",
  },
  {
    signal: "new_account",
    test: (op) => isSuspiciousOrg(op.organization),
    note: "Organization name is empty or suspiciously short (<3 chars).",
  },
  {
    signal: "unrealistic_reward",
    test: (op) => hasUnrealisticReward(op),
    note: "Reward size is implausible for the declared category.",
  },
];

const INFO_RULES: InfoRule[] = [
  {
    signal: "suspicious_signing",
    test: (op) =>
      /sign\s+transaction|sign\s+message|approve\s+transaction/i.test(
        op.paymentMethod
      ),
    note: "Payment method requires wallet signing — info (review).",
  },
  {
    signal: "impersonation",
    test: (op) =>
      /official|foundation|protocol/i.test(op.organization) === false &&
      op.organization.length > 0 &&
      op.organization.length < 4,
    note: "Organization name is unusually short — info (possible impersonation).",
  },
];

// ---------------------------------------------------------------------------
// Heuristic helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the source URL host clearly does not align with the
 * organization name. Examples:
 *   - org "Lens Protocol" but URL host `airdrop-eth-claim-free.xyz`
 *   - org empty / placeholder
 */
function hasDomainMismatch(op: NormalizedOpportunity): boolean {
  if (!op.sourceUrl) return false;
  let host: string;
  try {
    host = new URL(op.sourceUrl).hostname.toLowerCase();
  } catch {
    return true; // malformed URL → treat as suspicious
  }
  if (!host) return true;
  // Allow trusted platforms regardless of org name.
  for (const trusted of TRUSTED_HOSTS) {
    if (host === trusted || host.endsWith(`.${trusted}`)) return false;
  }
  // Compare the org slug to the host's second-level domain.
  const orgSlug = op.organization
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  if (!orgSlug) return true;
  const sld = host
    .split(".")
    .slice(-2, -1)[0]
    ?.toLowerCase();
  if (!sld) return false;
  // If the org slug is a substring of the SLD or vice-versa, it's a match.
  if (sld.includes(orgSlug) || orgSlug.includes(sld)) return false;
  // Single-char orgs + obscure TLDs are very suspicious.
  if (orgSlug.length < 4) return true;
  return true;
}

/** True when the organization name is missing or trivially short. */
function isSuspiciousOrg(organization: string): boolean {
  const trimmed = (organization ?? "").trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < 3) return true;
  // All-numeric or single-char repeated
  if (/^[0-9]+$/.test(trimmed)) return true;
  if (/^(.)\1{2,}$/.test(trimmed)) return true;
  return false;
}

/** True when the declared reward is implausibly large for the category. */
function hasUnrealisticReward(op: NormalizedOpportunity): boolean {
  const usd = op.reward?.estimated_usd ?? 0;
  if (!Number.isFinite(usd) || usd <= 0) return false;
  // Per-category caps above which the reward becomes implausible.
  const cap = REWARD_CAP_BY_CATEGORY[op.category] ?? DEFAULT_REWARD_CAP;
  if (usd > cap) return true;
  // Any task (any category) promising > $50k USD is implausible.
  if (usd > 50_000) return true;
  return false;
}

const REWARD_CAP_BY_CATEGORY: Record<OpportunityCategory, number> = {
  bounty: 30_000, // generic bounty — same cap as github_bounty
  github_bounty: 30_000,
  docs: 10_000,
  content: 10_000,
  oss_contribution: 10_000,
  data_task: 15_000,
  coding_task: 20_000,
  developer_task: 25_000,
  ecosystem: 30_000,
  freelance: 40_000,
  bug_bounty: 100_000, // legit bug bounties can be very large
  hackathon: 100_000, // prize pools can be large
  grant: 250_000, // grants are typically large
  referral: 1_000, // referral rewards above $1k are very suspicious
};

const DEFAULT_REWARD_CAP = 50_000;

const TRUSTED_HOSTS = new Set([
  "github.com",
  "gitcoin.co",
  "onlydust.com",
  "optimism.io",
  "ethereum.foundation",
  "dune.com",
  "mirror.xyz",
  "replit.com",
  "vercel.com",
  "polygon.technology",
  "solana.com",
  "hackathon.com",
]);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}
