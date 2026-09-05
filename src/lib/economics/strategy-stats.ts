// Strategy learning subsystem (spec §15, §16).
//
// Every time the agent discovers, attempts, completes, fails, or rejects an
// opportunity, it records the outcome against the matching `StrategyStat` row
// (keyed by `strategy` = the opportunity category). Over time these rows
// accumulate `avgHourly` and `successRate` derived fields that drive the
// exploration-vs-exploitation strategy selector.
//
// All writes are atomic (Prisma `upsert` + `{ increment: N }`) so concurrent
// workers cannot lose updates. The derived fields (`avgHourly`, `successRate`)
// are recomputed after every increment because Prisma cannot express
// "set avgHourly = totalNetUsd / totalHours" as an atomic SQL update.

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";

// ---------------------------------------------------------------------------
// Canonical strategies (spec §15, §16 — mirrors OpportunityCategory)
// ---------------------------------------------------------------------------

/**
 * The canonical strategy keys the agent tracks. These mirror the legitimate
 * `OpportunityCategory` values from `src/lib/agent/types.ts` (excluding
 * `bounty`, `bug_bounty`, and `referral` which are rolled up into
 * `github_bounty` / `ecosystem` / `referral`-is-prohibited-anyway).
 *
 * `bug_bounty` and `bounty` are intentionally omitted because the spec
 * categorises them under `github_bounty` for strategy-learning purposes
 * (the same skills, time horizon, and risk profile apply).
 */
export const CANONICAL_STRATEGIES = [
  "github_bounty",
  "hackathon",
  "docs",
  "developer_task",
  "coding_task",
  "data_task",
  "freelance",
  "grant",
  "ecosystem",
  "content",
  "oss_contribution",
] as const;

export type CanonicalStrategy = (typeof CANONICAL_STRATEGIES)[number];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StrategyOutcome {
  /** Set when a new opportunity is discovered for this strategy. */
  discovered?: boolean;
  /** Set when the agent rejects the opportunity (scam / out-of-policy / etc). */
  rejected?: boolean;
  /** Set when the agent begins execution (planning → executing). */
  attempted?: boolean;
  /** Set when execution succeeds and a verified payment is received. */
  completed?: boolean;
  /** Set when execution fails (no payment, broken submission, etc). */
  failed?: boolean;
  /** Net USD earned (gross - fees - expenses). Negative for failed attempts with costs. */
  netUsd?: number;
  /** Hours spent on this attempt. */
  hoursSpent?: number;
}

export interface StrategyStatRow {
  id: string;
  strategy: string;
  discovered: number;
  rejected: number;
  attempted: number;
  completed: number;
  failed: number;
  totalGrossUsd: number;
  totalNetUsd: number;
  totalHours: number;
  /** Derived: `totalNetUsd / totalHours` (0 when totalHours is 0). */
  avgHourly: number;
  /** Derived: `completed / attempted` (0 when attempted is 0). */
  successRate: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// getStrategyStats
// ---------------------------------------------------------------------------

/**
 * Read all `StrategyStat` rows, computing the derived `avgHourly` and
 * `successRate` fields from the raw counters. Rows are returned in
 * alphabetical order by `strategy` for deterministic display.
 *
 * DB failures degrade to an empty array (logged to console) so the
 * orchestrator can continue without crashing.
 */
export async function getStrategyStats(): Promise<StrategyStatRow[]> {
  try {
    const rows = await db.strategyStat.findMany({
      orderBy: { strategy: "asc" },
    });
    return rows.map(rowToStrategyStat);
  } catch (err) {
    console.error("[strategy-stats] getStrategyStats failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// recordStrategyOutcome
// ---------------------------------------------------------------------------

/**
 * Atomically increment a `StrategyStat` row for an outcome (spec §15).
 *
 * The write is a two-step Prisma operation:
 *   1. `upsert` with `{ increment: N }` for the raw counters (discovered,
 *      rejected, attempted, completed, failed, totalGrossUsd, totalNetUsd,
 *      totalHours).
 *   2. `update` to recompute the derived fields `avgHourly` and `successRate`
 *      from the freshly-incremented totals (Prisma cannot express
 *      "set X = col_a / col_b" atomically).
 *
 * Both steps run in a try/catch — a transient DB outage is logged but never
 * propagated to the caller (the orchestrator must keep running).
 *
 * @param strategy  the strategy key (typically `opportunity.category`)
 * @param outcome   which counters to increment + the financial/hour figures
 */
export async function recordStrategyOutcome(
  strategy: string,
  outcome: StrategyOutcome
): Promise<StrategyStatRow | null> {
  if (!strategy || typeof strategy !== "string") {
    console.warn("[strategy-stats] recordStrategyOutcome: empty strategy");
    return null;
  }

  const incDiscovered = outcome.discovered ? 1 : 0;
  const incRejected = outcome.rejected ? 1 : 0;
  const incAttempted = outcome.attempted ? 1 : 0;
  const incCompleted = outcome.completed ? 1 : 0;
  const incFailed = outcome.failed ? 1 : 0;
  const netUsd = finiteOr(outcome.netUsd, 0);
  const grossUsd = Math.max(0, netUsd); // gross ≥ 0 even when net is negative
  const hoursSpent = Math.max(finiteOr(outcome.hoursSpent, 0), 0);

  try {
    // Step 1: atomic upsert with increments.
    const after = await db.strategyStat.upsert({
      where: { strategy },
      create: {
        strategy,
        discovered: incDiscovered,
        rejected: incRejected,
        attempted: incAttempted,
        completed: incCompleted,
        failed: incFailed,
        totalGrossUsd: grossUsd,
        totalNetUsd: netUsd,
        totalHours: hoursSpent,
        avgHourly: hoursSpent > 0 ? netUsd / hoursSpent : 0,
        successRate: incAttempted > 0 ? incCompleted / incAttempted : 0,
      },
      update: {
        discovered: { increment: incDiscovered },
        rejected: { increment: incRejected },
        attempted: { increment: incAttempted },
        completed: { increment: incCompleted },
        failed: { increment: incFailed },
        totalGrossUsd: { increment: grossUsd },
        totalNetUsd: { increment: netUsd },
        totalHours: { increment: hoursSpent },
      },
    });

    // Step 2: recompute derived fields from the new totals.
    const totalHoursNow = finiteOr(after.totalHours, 0);
    const totalNetUsdNow = finiteOr(after.totalNetUsd, 0);
    const attemptedNow = finiteOr(after.attempted, 0);
    const completedNow = finiteOr(after.completed, 0);

    const avgHourly = totalHoursNow > 0 ? totalNetUsdNow / totalHoursNow : 0;
    const successRate = attemptedNow > 0 ? completedNow / attemptedNow : 0;

    const finalRow = await db.strategyStat.update({
      where: { strategy },
      data: { avgHourly, successRate },
    });

    return rowToStrategyStat(finalRow);
  } catch (err) {
    console.error(
      `[strategy-stats] recordStrategyOutcome failed for '${strategy}':`,
      err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// rankStrategies
// ---------------------------------------------------------------------------

/**
 * Rank strategies by `avgHourly` (descending). Strategies with fewer than
 * `MIN_ATTEMPTS` attempts get an *exploration bonus* (spec §16) so newly-
 * seeded strategies still get tried while their stats are still being
 * gathered.
 *
 * The bonus is a synthetic floor on `avgHourly`: if a strategy has <3
 * attempts, its effective `avgHourly` for ranking purposes is at least
 * `EXPLORATION_BONUS_HOURLY` (default $5/hr). This is enough to put a
 * brand-new strategy somewhere in the middle of the pack — exploitable
 * enough to be tried, but not so high it displaces a proven winner.
 *
 * @returns the ranked list (best first). Each row carries both the raw
 *          `avgHourly` and the exploration-boosted `effectiveAvgHourly`.
 */
export async function rankStrategies(): Promise<
  Array<StrategyStatRow & { effectiveAvgHourly: number }>
> {
  const stats = await getStrategyStats();
  return stats
    .map((s) => {
      const explorationBonus =
        s.attempted < MIN_ATTEMPTS
          ? Math.max(s.avgHourly, EXPLORATION_BONUS_HOURLY)
          : s.avgHourly;
      return { ...s, effectiveAvgHourly: explorationBonus };
    })
    .sort((a, b) => b.effectiveAvgHourly - a.effectiveAvgHourly);
}

// ---------------------------------------------------------------------------
// selectStrategyForCycle
// ---------------------------------------------------------------------------

/**
 * Select a strategy for the next cycle using exploration vs exploitation
 * (spec §16):
 *
 *   - 70% exploit: pick the top-ranked strategy (best `effectiveAvgHourly`)
 *   - 20% explore:  pick a mid-ranked strategy (25–75 percentile of the pack)
 *   - 10% experimental: pick a low-attempts strategy (to gather data)
 *
 * The exploit/explore split is parametric via `explorationRatio` (default
 * `0.3` = 70/30 exploit/explore). The explore portion is further split 2:1
 * between "explore mid-ranked" and "experimental low-attempts".
 *
 * The selection uses `Math.random()` — this is the ONE place in the
 * economics subsystem where randomness is allowed, because exploration vs
 * exploitation is inherently stochastic. The `computeEconomics` math is
 * still 100% deterministic.
 *
 * @returns the chosen strategy key, or `null` if the table is empty.
 */
export async function selectStrategyForCycle(
  explorationRatio = 0.3
): Promise<string | null> {
  const ranked = await rankStrategies();
  if (ranked.length === 0) return null;
  if (ranked.length === 1) return ranked[0].strategy;

  // Clamp exploration ratio to [0, 1].
  const expRatio = clamp(explorationRatio, 0, 1);
  const exploitThreshold = 1 - expRatio; // 0.7 by default
  const exploreThreshold = exploitThreshold + expRatio * (2 / 3); // 0.9 by default
  // Anything >= exploreThreshold is "experimental" (last 1/3 of the explore budget).

  const roll = Math.random();

  if (roll < exploitThreshold) {
    // Exploit: pick the top-ranked strategy.
    return ranked[0].strategy;
  }

  if (roll < exploreThreshold) {
    // Explore: pick a mid-ranked strategy (between 25% and 75% of the list).
    const midStart = Math.max(1, Math.floor(ranked.length * 0.25));
    const midEnd = Math.max(midStart + 1, Math.ceil(ranked.length * 0.75));
    const idx = midStart + Math.floor(Math.random() * (midEnd - midStart));
    return ranked[Math.min(idx, ranked.length - 1)].strategy;
  }

  // Experimental: pick a strategy with fewer than MIN_ATTEMPTS attempts.
  const lowAttempts = ranked.filter((s) => s.attempted < MIN_ATTEMPTS);
  if (lowAttempts.length > 0) {
    const idx = Math.floor(Math.random() * lowAttempts.length);
    return lowAttempts[idx].strategy;
  }

  // Fallback: if every strategy has ≥3 attempts, pick from the bottom half
  // (the under-performers — they may have improved since their last attempt).
  const bottomHalf = ranked.slice(Math.floor(ranked.length / 2));
  if (bottomHalf.length === 0) return ranked[ranked.length - 1].strategy;
  const idx = Math.floor(Math.random() * bottomHalf.length);
  return bottomHalf[idx].strategy;
}

// ---------------------------------------------------------------------------
// bootstrapStrategies
// ---------------------------------------------------------------------------

/**
 * Seed initial `StrategyStat` rows for the canonical strategies if they don't
 * already exist. Idempotent — safe to call on every startup. All counts start
 * at zero; the exploration bonus in {@link rankStrategies} ensures they get
 * tried at least 3 times before being ranked on raw `avgHourly`.
 */
export async function bootstrapStrategies(): Promise<void> {
  try {
    await Promise.all(
      CANONICAL_STRATEGIES.map((strategy) =>
        db.strategyStat.upsert({
          where: { strategy },
          create: { strategy },
          update: {},
        })
      )
    );
    await logEvent("economics", "info", "strategy_stats_bootstrapped", {
      strategies: [...CANONICAL_STRATEGIES],
    });
  } catch (err) {
    console.error("[strategy-stats] bootstrapStrategies failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Strategies with fewer than this many attempts get an exploration bonus. */
const MIN_ATTEMPTS = 3;

/** Synthetic avgHourly floor for under-explored strategies (spec §16). */
const EXPLORATION_BONUS_HOURLY = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToStrategyStat(row: {
  id: string;
  strategy: string;
  discovered: number;
  rejected: number;
  attempted: number;
  completed: number;
  failed: number;
  totalGrossUsd: number;
  totalNetUsd: number;
  totalHours: number;
  avgHourly: number;
  successRate: number;
  updatedAt: Date;
}): StrategyStatRow {
  const attempted = finiteOr(row.attempted, 0);
  const completed = finiteOr(row.completed, 0);
  const totalNetUsd = finiteOr(row.totalNetUsd, 0);
  const totalHours = finiteOr(row.totalHours, 0);

  // Always recompute the derived fields from the raw counters — never trust
  // a stale value left in the column by a crashed prior update.
  return {
    id: row.id,
    strategy: row.strategy,
    discovered: finiteOr(row.discovered, 0),
    rejected: finiteOr(row.rejected, 0),
    attempted,
    completed,
    failed: finiteOr(row.failed, 0),
    totalGrossUsd: finiteOr(row.totalGrossUsd, 0),
    totalNetUsd,
    totalHours,
    avgHourly: totalHours > 0 ? totalNetUsd / totalHours : finiteOr(row.avgHourly, 0),
    successRate:
      attempted > 0 ? completed / attempted : finiteOr(row.successRate, 0),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function finiteOr(n: number | null | undefined, fallback: number): number {
  if (n === null || n === undefined || !Number.isFinite(n)) return fallback;
  return n;
}
