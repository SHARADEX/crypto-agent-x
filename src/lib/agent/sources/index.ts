// Source registry + V2 discovery cycle (Phase-2 spec §18, §19).
//
// This module is the new home of the discovery cycle:
//
//   - `SOURCES`           — array of every OpportunitySource instance
//                            (GitHub x2, mock, Gitcoin, Devpost, OnlyDust,
//                            Hashnode, + RSS aggregator).
//   - `getConfiguredSources()` — returns only sources whose `healthCheck()`
//                            passed (mocks always included).
//   - `runDiscoveryCycleV2()`   — the new discovery cycle:
//       1. Kill-switch / state / budget gate (same as V1).
//       2. For each configured source, call `discover()` in parallel
//          via `Promise.allSettled`.
//       3. Normalize each result via the source's `normalize()`.
//       4. Deduplicate via `deduplicateOpportunities`.
//       5. For each NEW opportunity: scam-detect → verify → score (same
//          pipeline as V1 — `detectScam` / `verifyOpportunity` /
//          `scoreOpportunity`).
//       6. Persist to DB (insert-only keyed by canonicalId).
//       7. Update `SourceReputation` counters.
//       8. Log the cycle outcome via `logEvent`.
//       9. Return a summary identical in shape to V1's `DiscoverySummary`.
//
// The OLD `runDiscoveryCycle` in `scanners/index.ts` is now a thin wrapper
// that delegates here so the orchestrator + API routes work unchanged.

import { db } from "@/lib/db";
import { SOURCES as SOURCE_CONFIGS } from "@/config/sources";
import type { Opportunity } from "@/lib/agent/types";
import { logEvent } from "@/lib/agent/events";
import { canRun } from "@/lib/agent/state";
import { BudgetManager } from "@/lib/budget/manager";
import {
  deduplicateOpportunities,
  normalizeOpportunity,
  type NormalizedOpportunity,
  type RawOpportunityInput,
} from "@/lib/agent/normalize";
import { detectScam } from "@/lib/security/scam-detection";
import { verifyOpportunity } from "@/lib/agent/verification";
import { scoreOpportunity } from "@/lib/agent/scorer";

import type { OpportunitySource } from "@/lib/agent/sources/types";
import { GithubBountiesSource } from "@/lib/agent/sources/github-bounties";
import { MockSource } from "@/lib/agent/sources/mock-source";
import { GitcoinSource } from "@/lib/agent/sources/gitcoin-source";
import { DevpostSource } from "@/lib/agent/sources/devpost-source";
import { OnlyDustSource } from "@/lib/agent/sources/onlydust-source";
import { HashnodeSource } from "@/lib/agent/sources/hashnode-source";
import { BountyRssAggregatorSource } from "@/lib/agent/sources/rssac-source";

// ---------------------------------------------------------------------------
// Public types (re-exported for scanners/index.ts backward compat)
// ---------------------------------------------------------------------------

export interface DiscoverySummary {
  /** Total raw opportunities surfaced across all sources (post-dedup). */
  discovered: number;
  /** Newly inserted into the DB this cycle. */
  new: number;
  /** Already existed (skipped — do not overwrite scoring). */
  duplicates: number;
  /** Rejected (scam-flagged or persistence error). */
  rejected: number;
  /** Per-category counts of newly-inserted opportunities. */
  byCategory: Record<string, number>;
  /** ISO timestamps bounding the cycle. */
  startedAt: string;
  finishedAt: string;
  /** True if the cycle declined to run (kill switch / budget). */
  skipped: boolean;
  /** Populated when `skipped` is true. */
  skipReason?: string;
  /** Per-source error messages for sources that failed. */
  scannerErrors: Record<string, string>;
  /** Per-source count of opportunities discovered (post-dedup, pre-persist). */
  perSource: Record<string, number>;
}

// ---------------------------------------------------------------------------
// SOURCE INSTANCES
// ---------------------------------------------------------------------------

/**
 * Build the canonical list of source instances from the config.
 *
 * Two GithubBountiesSource instances are created (one per GitHub endpoint
 * defined in the config) — this preserves the existing `github_issues` +
 * `github_help_wanted` semantics.
 *
 * Mock sources are always instantiated for both `mock_bounties` and
 * `mock_hackathons` config entries.
 */
function buildSources(): OpportunitySource[] {
  const out: OpportunitySource[] = [];

  for (const cfg of SOURCE_CONFIGS) {
    if (!cfg.enabled) continue;
    switch (cfg.type) {
      case "github": {
        if (!cfg.endpoint) break;
        out.push(
          new GithubBountiesSource({
            id: cfg.id,
            name: cfg.name,
            endpoint: cfg.endpoint,
            reliabilitySeed: cfg.reliabilitySeed,
            defaultMaxResults: 30,
          })
        );
        break;
      }
      case "mock": {
        out.push(new MockSource({ id: cfg.id, name: cfg.name }));
        break;
      }
      // rss / api / web types from the legacy config are ignored — the
      // explicit adapters below cover those.
      default:
        break;
    }
  }

  // Real adapters — always registered. getConfiguredSources() filters
  // by healthCheck() so dead adapters don't burn cycle time.
  out.push(new GitcoinSource());
  out.push(new DevpostSource());
  out.push(new OnlyDustSource());
  out.push(new HashnodeSource());
  out.push(new BountyRssAggregatorSource());

  return out;
}

/**
 * The canonical list of OpportunitySource instances. Built once at module
 * load. Activated sources (via source-discovery.ts `activateSource()`) are
 * appended to this array at runtime — see {@link activateRuntimeSource}.
 */
export const SOURCES: OpportunitySource[] = buildSources();

// ---------------------------------------------------------------------------
// Runtime activation (used by Source Discovery — §19)
// ---------------------------------------------------------------------------

/**
 * Append a runtime-activated source to the SOURCES array. Used by the
 * Source Discovery subsystem when the operator approves a discovered source
 * via the dashboard. The source is added to the in-memory SOURCES array —
 * it will NOT persist across restarts unless the operator adds it to
 * `src/config/sources.ts`.
 *
 * Returns `true` if the source was newly registered, `false` if a source
 * with the same id is already registered.
 */
export function activateRuntimeSource(source: OpportunitySource): boolean {
  if (SOURCES.some((s) => s.id === source.id)) {
    return false;
  }
  SOURCES.push(source);
  return true;
}

/**
 * Remove a runtime-activated source from the SOURCES array. Used by the
 * dashboard to deactivate a previously-approved source. Built-in sources
 * (loaded from config) cannot be removed this way — they must be disabled
 * in `src/config/sources.ts`.
 */
export function deactivateRuntimeSource(sourceId: string): boolean {
  const idx = SOURCES.findIndex((s) => s.id === sourceId);
  if (idx < 0) return false;
  SOURCES.splice(idx, 1);
  return true;
}

// ---------------------------------------------------------------------------
// getConfiguredSources — health-gated subset
// ---------------------------------------------------------------------------

/**
 * Health-gated subset of SOURCES. Runs `healthCheck()` on each non-mock
 * source in parallel; returns only the sources that reported `ok: true`
 * (mock sources are always included).
 *
 * Caches the result for 60 seconds so we don't burn budget on every cycle.
 */
let _configuredCache: {
  sources: OpportunitySource[];
  expiresAt: number;
} | null = null;
const CONFIGURED_CACHE_TTL_MS = 60_000;

export async function getConfiguredSources(): Promise<OpportunitySource[]> {
  if (_configuredCache && _configuredCache.expiresAt > Date.now()) {
    return _configuredCache.sources;
  }

  const verdicts = await Promise.allSettled(
    SOURCES.map(async (s) => {
      if (s.type === "mock") return { s, ok: true };
      try {
        const r = await s.healthCheck();
        return { s, ok: r.ok };
      } catch {
        return { s, ok: false };
      }
    })
  );

  const ok: OpportunitySource[] = [];
  for (const v of verdicts) {
    if (v.status === "fulfilled" && v.value.ok) {
      ok.push(v.value.s);
    }
  }

  _configuredCache = {
    sources: ok,
    expiresAt: Date.now() + CONFIGURED_CACHE_TTL_MS,
  };
  return ok;
}

/**
 * Invalidate the configured-sources cache. Called by Source Discovery when
 * a source is activated / deactivated so the next cycle sees the change.
 */
export function invalidateConfiguredSourcesCache(): void {
  _configuredCache = null;
}

// ---------------------------------------------------------------------------
// runDiscoveryCycleV2
// ---------------------------------------------------------------------------

/**
 * Run a full discovery cycle over the new OpportunitySource architecture.
 *
 * Flow:
 *   1. Kill switch / state / budget gate.
 *   2. Discover from each configured source in parallel (Promise.allSettled).
 *   3. Normalize + dedup.
 *   4. For each NEW opportunity: scam-detect → verify → score.
 *   5. Persist to DB (insert-only).
 *   6. Update SourceReputation counters.
 *   7. Log + record budget.
 *   8. Return a DiscoverySummary (backward compat with V1).
 */
export async function runDiscoveryCycleV2(): Promise<DiscoverySummary> {
  const startedAt = new Date().toISOString();
  const summary: DiscoverySummary = {
    discovered: 0,
    new: 0,
    duplicates: 0,
    rejected: 0,
    byCategory: {},
    startedAt,
    finishedAt: startedAt,
    skipped: false,
    scannerErrors: {},
    perSource: {},
  };

  // -- 1. Kill switch / state / budget gate ------------------------------
  const gate = await canRun();
  if (!gate.canRun) {
    summary.skipped = true;
    summary.skipReason = gate.reason;
    summary.finishedAt = new Date().toISOString();
    await logEvent(
      "scout",
      "info",
      "discovery_cycle_skipped",
      { reason: gate.reason },
      {}
    );
    return summary;
  }

  try {
    await BudgetManager.getInstance().assertWithinBudget();
  } catch (err) {
    summary.skipped = true;
    summary.skipReason =
      err instanceof Error ? `Budget gate: ${err.message}` : "Budget exceeded.";
    summary.finishedAt = new Date().toISOString();
    await logEvent(
      "scout",
      "warn",
      "discovery_cycle_budget_skipped",
      { reason: summary.skipReason },
      {}
    );
    return summary;
  }

  // -- 2. Discover from each configured source in parallel ---------------
  const configured = await getConfiguredSources();
  const settled = await Promise.allSettled(
    configured.map((src) => src.discover())
  );

  const allRaws: { raw: RawOpportunityInput; source: string }[] = [];
  configured.forEach((src, idx) => {
    const result = settled[idx];
    if (result.status === "fulfilled") {
      summary.perSource[src.id] = result.value.length;
      for (const raw of result.value) {
        allRaws.push({ raw, source: src.id });
      }
    } else {
      const msg =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      summary.scannerErrors[src.id] = msg;
      summary.perSource[src.id] = 0;
    }
  });

  // -- 3. Normalize + dedup ---------------------------------------------
  const normalized: NormalizedOpportunity[] = allRaws.map(({ raw, source }) => {
    // Each raw item already carries a `source` field (set by the adapter).
    // Pass it through to normalizeOpportunity so canonicalId is computed
    // against the adapter's source id, not the discovery-cycle source label.
    const rawWithSource: RawOpportunityInput = { ...raw, source: raw.source ?? source };
    return normalizeOpportunity(rawWithSource, source);
  });
  const deduped = deduplicateOpportunities(normalized);
  summary.discovered = deduped.length;
  summary.duplicates = Math.max(0, normalized.length - deduped.length);

  // -- 4 + 5 + 6. Verify / score / persist ------------------------------
  for (const op of deduped) {
    try {
      const scam = detectScam(op);
      const verification = verifyOpportunity(op);

      const opportunity: Opportunity = {
        id: "",
        canonicalId: op.canonicalId,
        title: op.title,
        description: op.description,
        source: op.source,
        sourceUrl: op.sourceUrl,
        organization: op.organization,
        category: op.category,
        reward: op.reward,
        deadline: op.deadline,
        requirements: op.requirements,
        skillsRequired: op.skillsRequired,
        estimatedHours: op.estimatedHours,
        difficulty: op.difficulty,
        competition: op.competition,
        eligibility: op.eligibility,
        paymentMethod: op.paymentMethod,
        paymentVerified: false,
        sourceVerified: false,
        // v0.4.1 watchlist fields — new opportunities start unwatched.
        watched: false,
        watchedAt: null,
        riskScore: 0,
        verificationScore: 0,
        confidence: 0,
        status: scam.isScam ? "rejected" : "discovered",
        expectedValue: 0,
        expectedHourly: 0,
        riskAdjustedHourly: 0,
        capitalRequired: op.capitalRequired,
        createdAt: startedAt,
        updatedAt: startedAt,
      };
      scoreOpportunity(opportunity, verification, scam);

      const inserted = await persistOpportunity(op, opportunity, scam.isScam);
      if (inserted === "inserted") {
        summary.new += 1;
        summary.byCategory[op.category] =
          (summary.byCategory[op.category] ?? 0) + 1;
      } else if (inserted === "duplicate") {
        summary.duplicates += 1;
      } else {
        summary.rejected += 1;
      }

      await bumpSourceReputation(op.source, {
        discovered: inserted !== "error",
        scam: scam.isScam,
      });
    } catch (err) {
      summary.rejected += 1;
      console.error("[sources] failed to process opportunity:", err);
    }
  }

  // -- 7. Event log + budget record ------------------------------------
  summary.finishedAt = new Date().toISOString();
  await logEvent(
    "scout",
    summary.new > 0 ? "info" : "debug",
    "discovery_cycle_complete",
    {
      discovered: summary.discovered,
      new: summary.new,
      duplicates: summary.duplicates,
      rejected: summary.rejected,
      byCategory: summary.byCategory,
      perSource: summary.perSource,
      scannerErrors: summary.scannerErrors,
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
    },
    {}
  );

  try {
    const elapsedMs =
      Date.parse(summary.finishedAt) - Date.parse(summary.startedAt);
    if (Number.isFinite(elapsedMs) && elapsedMs > 0) {
      await BudgetManager.getInstance().recordExecutionTime(elapsedMs);
    }
  } catch (err) {
    console.warn("[sources] budget recordExecutionTime failed:", err);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Persistence (moved verbatim from scanners/index.ts)
// ---------------------------------------------------------------------------

type PersistOutcome = "inserted" | "duplicate" | "error";

async function persistOpportunity(
  normalized: NormalizedOpportunity,
  scored: Opportunity,
  isScam: boolean
): Promise<PersistOutcome> {
  try {
    const existing = await db.opportunity.findUnique({
      where: { canonicalId: normalized.canonicalId },
      select: { id: true },
    });
    if (existing) return "duplicate";

    await db.opportunity.create({
      data: {
        canonicalId: normalized.canonicalId,
        title: scored.title,
        description: scored.description,
        source: scored.source,
        sourceUrl: scored.sourceUrl,
        organization: scored.organization,
        category: scored.category,
        rewardAmount: scored.reward.amount,
        rewardCurrency: scored.reward.currency,
        rewardUsd: scored.reward.estimated_usd,
        deadline: scored.deadline ? new Date(scored.deadline) : null,
        requirements: JSON.stringify(scored.requirements),
        skillsRequired: JSON.stringify(scored.skillsRequired),
        estimatedHours: scored.estimatedHours,
        difficulty: scored.difficulty,
        competition: scored.competition,
        eligibility: JSON.stringify(scored.eligibility),
        paymentMethod: scored.paymentMethod,
        paymentVerified: scored.paymentVerified,
        sourceVerified: scored.sourceVerified,
        capitalRequired: scored.capitalRequired,
        riskScore: scored.riskScore,
        verificationScore: scored.verificationScore,
        confidence: scored.confidence,
        status: scored.status,
        dedupHash: normalized.dedupHash,
      },
    });
    return "inserted";
  } catch (err) {
    console.error("[sources] persistOpportunity failed:", err);
    return "error";
  }
}

async function bumpSourceReputation(
  source: string,
  opts: { discovered: boolean; scam: boolean }
): Promise<void> {
  try {
    const update: Record<string, unknown> = {};
    if (opts.discovered && !opts.scam) update.successfulOps = { increment: 1 };
    if (opts.scam) update.scamDetections = { increment: 1 };

    await db.sourceReputation.upsert({
      where: { source },
      create: {
        source,
        successfulOps: opts.discovered && !opts.scam ? 1 : 0,
        scamDetections: opts.scam ? 1 : 0,
      },
      update: update as never,
    });

    // Phase-2 P2-3 — recompute the `reliability` field (0..100) from the
    // raw counters after every bump. Previously `reliability` stayed at its
    // seed value forever; now it reflects the actual observed behaviour.
    await recomputeSourceReliability(source);
  } catch (err) {
    console.error(
      `[sources] bumpSourceReputation failed for source '${source}':`,
      err
    );
  }
}

/**
 * Recompute a source's `reliability` score (0..100) from its raw counters.
 *
 * Formula (documented in docs/ARCHITECTURE.md §Source Reputation):
 *   base           = 50  (neutral start)
 *   + successfulOps * 1.5       (each legit find adds 1.5, capped at +35)
 *   - scamDetections * 12       (each scam is a strong negative signal)
 *   - fakeOps * 8               (claimed-but-not-real)
 *   - deadLinks * 2             (minor — links rot)
 *   - paymentFailures * 5       (real opportunity, payment didn't land)
 *   + avgRewardUsd * 0.02       (small bonus for high-value sources, capped +10)
 *
 * Clamped to [0, 100]. When a source has 0 events, reliability stays at its
 * seed value (the upsert preserves it).
 *
 * Phase-2 P2-3 — closed.
 */
export async function recomputeSourceReliability(source: string): Promise<number> {
  try {
    const row = await db.sourceReputation.findUnique({ where: { source } });
    if (!row) return 50;

    const successful = row.successfulOps ?? 0;
    const scams = row.scamDetections ?? 0;
    const fake = row.fakeOps ?? 0;
    const dead = row.deadLinks ?? 0;
    const payFails = row.paymentFailures ?? 0;
    const avgReward = row.avgRewardUsd ?? 0;

    // Don't recompute until there's at least one signal — preserve the seed.
    const totalSignals = successful + scams + fake + dead + payFails;
    if (totalSignals === 0) return row.reliability ?? 50;

    let score = 50;
    score += Math.min(35, successful * 1.5);
    score -= scams * 12;
    score -= fake * 8;
    score -= dead * 2;
    score -= payFails * 5;
    score += Math.min(10, avgReward * 0.02);

    score = Math.max(0, Math.min(100, Math.round(score)));

    await db.sourceReputation.update({
      where: { source },
      data: { reliability: score },
    });

    return score;
  } catch (err) {
    console.error(
      `[sources] recomputeSourceReliability failed for source '${source}':`,
      err
    );
    return 50;
  }
}

/**
 * Recompute reliability for ALL known sources. Used by the scheduled
 * maintenance cycle + the dashboard's "Recompute reputations" button.
 */
export async function recomputeAllSourceReliability(): Promise<{
  recomputed: number;
  results: Array<{ source: string; reliability: number }>;
}> {
  try {
    const rows = await db.sourceReputation.findMany({ select: { source: true } });
    const results: Array<{ source: string; reliability: number }> = [];
    for (const row of rows) {
      const reliability = await recomputeSourceReliability(row.source);
      results.push({ source: row.source, reliability });
    }
    return { recomputed: rows.length, results };
  } catch (err) {
    console.error("[sources] recomputeAllSourceReliability failed:", err);
    return { recomputed: 0, results: [] };
  }
}
