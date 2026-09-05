// Opportunity normalization + deduplication (spec §5, §6, §23).
//
// Scanners return raw opportunity objects that vary in shape (GitHub issues,
// mock seeds, RSS items, future adapters). Before persistence each raw item is
// funneled through `normalizeOpportunity` so the rest of the pipeline (scam
// detection, verification, scoring, persistence) deals with one canonical
// shape.
//
// Deduplication (spec §23):
//   The same bounty may appear in multiple sources — GitHub + Twitter + a
//   bounty platform's RSS feed. We compute a stable `canonicalId` (sha-256 of
//   `source|sourceUrl|title`) and a `dedupHash` (sha-256 of `title|sourceUrl`)
//   so two scanners reporting the same bounty collapse to one DB row. When two
//   variants differ in reward, the higher-reward variant wins.

import { createHash } from "node:crypto";
import type { OpportunityCategory, Reward } from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// Raw input shape (returned by every scanner)
// ---------------------------------------------------------------------------

/**
 * Raw opportunity shape that every scanner emits before normalization.
 *
 * Only `title`, `sourceUrl`, and `organization` are strictly required — all
 * other fields have sensible defaults applied during normalization.
 */
export interface RawOpportunityInput {
  title: string;
  description: string;
  sourceUrl: string;
  /** Optional source override; if absent, the scanner's `source` arg is used. */
  source?: string;
  organization: string;
  category: OpportunityCategory;
  reward?: Partial<Reward> | null;
  /** ISO date string or null. */
  deadline?: string | null;
  requirements?: string[];
  skillsRequired?: string[];
  estimatedHours?: number;
  difficulty?: number;
  competition?: number;
  eligibility?: string[];
  paymentMethod?: string;
  capitalRequired?: boolean;
}

// ---------------------------------------------------------------------------
// Normalized shape (input to scam-detection, verification, scoring, persistence)
// ---------------------------------------------------------------------------

/**
 * Normalized opportunity — the canonical in-memory shape used by every
 * downstream agent. Mirrors the persistent `Opportunity` row but does NOT
 * include database-generated fields (id, createdAt, updatedAt, status) or
 * computed scores (riskScore, verificationScore, confidence, expectedValue,
 * expectedHourly, riskAdjustedHourly). Those are filled in by the scorer /
 * persistence layer.
 */
export interface NormalizedOpportunity {
  canonicalId: string;
  dedupHash: string;
  title: string;
  description: string;
  source: string;
  sourceUrl: string;
  organization: string;
  category: OpportunityCategory;
  reward: Reward;
  deadline: string | null;
  requirements: string[];
  skillsRequired: string[];
  estimatedHours: number;
  difficulty: number; // 1..10
  competition: number; // 1..10
  eligibility: string[];
  paymentMethod: string;
  capitalRequired: boolean;
}

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of an arbitrary string. */
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Compute the stable canonical id for a raw opportunity (spec §23).
 *
 * Combines `source + sourceUrl + title` so the same bounty surfaced by two
 * different scanners collapses to a single row. Two raw inputs that disagree
 * only on cosmetic fields (description whitespace, casing of the org name)
 * still share a canonicalId.
 */
export function canonicalIdOf(
  source: string,
  sourceUrl: string,
  title: string
): string {
  const key = `${source}|${sourceUrl}|${title.trim()}`.toLowerCase();
  return sha256(key);
}

/**
 * Compute the deduplication hash. Used as a secondary fingerprint: it ignores
 * the `source` and is computed over `title + sourceUrl`. Two raw items with
 * the same dedupHash but different sources are treated as cross-source
 * duplicates of the same opportunity.
 *
 * @param raw the raw opportunity to hash
 */
export function dedupHash(raw: RawOpportunityInput): string {
  const key = `${raw.title.trim()}|${raw.sourceUrl.trim()}`.toLowerCase();
  return sha256(key);
}

// ---------------------------------------------------------------------------
// Defaults & sanitization
// ---------------------------------------------------------------------------

const DEFAULT_REWARD: Reward = {
  amount: 0,
  currency: "USDC",
  estimated_usd: 0,
};

/**
 * Conservative USD-estimation for a reward. If the reward currency is already
 * USD-pegged (USD, USDC, USDT, DAI) we treat 1 unit ≈ $1. Otherwise we
 * conservatively estimate the USD value at 0 (the economics engine will refine
 * this later).
 */
function estimateUsd(reward: Partial<Reward> | null | undefined): number {
  if (!reward) return 0;
  const amount = Number(reward.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const currency = (reward.currency ?? "").toUpperCase();
  if (["USD", "USDC", "USDT", "DAI"].includes(currency)) return amount;
  // Unknown / volatile currency — defer precise conversion to economics engine.
  return 0;
}

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function sanitizeStringArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => (typeof x === "string" ? x.trim() : String(x ?? "").trim()))
    .filter((x) => x.length > 0);
}

// ---------------------------------------------------------------------------
// normalizeOpportunity
// ---------------------------------------------------------------------------

/**
 * Convert a raw opportunity (scanner output) into the canonical
 * {@link NormalizedOpportunity} shape used by every downstream agent.
 *
 * Computes the stable `canonicalId` and `dedupHash`, fills in defaults for
 * missing fields, and clamps numeric ranges to their valid bands.
 *
 * @param raw    raw opportunity emitted by a scanner
 * @param source scanner identifier (e.g. `"github_issues"`, `"mock_bounties"`)
 */
export function normalizeOpportunity(
  raw: RawOpportunityInput,
  source: string
): NormalizedOpportunity {
  const src = (raw.source ?? source).trim() || source;
  const title = (raw.title ?? "").trim();
  const sourceUrl = (raw.sourceUrl ?? "").trim();
  const organization = (raw.organization ?? "").trim();

  const reward: Reward = {
    amount: Number(raw.reward?.amount ?? 0) || 0,
    currency: (raw.reward?.currency ?? "USDC").trim() || "USDC",
    estimated_usd:
      raw.reward?.estimated_usd ?? estimateUsd(raw.reward ?? null),
  };
  // Defensive: never let estimated_usd disagree with amount when currency is USD-pegged.
  if (
    reward.estimated_usd <= 0 &&
    ["USD", "USDC", "USDT", "DAI"].includes(reward.currency.toUpperCase())
  ) {
    reward.estimated_usd = reward.amount;
  }

  const deadline = raw.deadline ? raw.deadline.trim() : null;

  return {
    canonicalId: canonicalIdOf(src, sourceUrl, title),
    dedupHash: dedupHash(raw),
    title,
    description: (raw.description ?? "").trim(),
    source: src,
    sourceUrl,
    organization,
    category: raw.category,
    reward,
    deadline,
    requirements: sanitizeStringArray(raw.requirements),
    skillsRequired: sanitizeStringArray(raw.skillsRequired),
    estimatedHours: Number(raw.estimatedHours ?? 0) || 0,
    difficulty: clampInt(raw.difficulty, 1, 10, 5),
    competition: clampInt(raw.competition, 1, 10, 5),
    eligibility: sanitizeStringArray(raw.eligibility),
    paymentMethod: (raw.paymentMethod ?? "").trim(),
    capitalRequired: Boolean(raw.capitalRequired),
  };
}

// ---------------------------------------------------------------------------
// deduplicateOpportunities
// ---------------------------------------------------------------------------

/**
 * Collapse a list of normalized opportunities to a deduplicated list.
 *
 * Two opportunities are considered duplicates if they share the same
 * `canonicalId`. When two duplicates exist, the higher-reward variant wins
 * (spec §23 — never spend multiple execution attempts on the same opportunity).
 *
 * @param ops normalized opportunities (any source)
 * @returns   deduplicated list, preserving the first-seen order for stable IDs
 */
export function deduplicateOpportunities(
  ops: NormalizedOpportunity[]
): NormalizedOpportunity[] {
  const byCanonical = new Map<string, NormalizedOpportunity>();
  for (const op of ops) {
    const existing = byCanonical.get(op.canonicalId);
    if (!existing) {
      byCanonical.set(op.canonicalId, op);
      continue;
    }
    // Keep the higher-reward variant; tie-break on longer description (more
    // detail is generally more useful for downstream agents).
    const incumbentReward = existing.reward.estimated_usd;
    const challengerReward = op.reward.estimated_usd;
    if (
      challengerReward > incumbentReward ||
      (challengerReward === incumbentReward &&
        op.description.length > existing.description.length)
    ) {
      byCanonical.set(op.canonicalId, op);
    }
  }
  return Array.from(byCanonical.values());
}
