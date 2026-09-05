// Strategy allocator — adaptive family allocation (Phase 3 §16–§26).
//
// This module is the strategy-diversification layer that sits ABOVE the
// legacy per-category `strategy-stats.ts`. The legacy subsystem still tracks
// per-category outcomes (github_bounty, freelance, hackathon, …) and still
// implements the 70/20/10 explore/exploit picker *within* a family. This
// module decides WHICH family to focus on for the next cycle, given the
// operator's allocation targets + the verified $/hr the agent has measured
// for each family so far.
//
// Public API:
//   - bootstrapAllocations()              — idempotent seed of the 7 families.
//   - getAllocations()                    — read all 7 families + their stats.
//   - selectFamilyForCycle()              — pick the next family (adaptive).
//   - rebalanceAllocations()              — adaptive rebalancer (Phase 3 §18).
//   - setAllocation(family, pct)          — operator override (Phase 3 §25).
//   - setAllocationLimits(family, min, max) — operator hard limits (Phase 3 §26).
//   - disableFamily(family) / enableFamily(family) — operator toggle.
//   - autoOptimize()                      — return control to the adaptive allocator.
//   - getAllocationChangeLog()            — audit trail (Phase 3 §23).
//
// Every write is wrapped in try/catch so transient DB failures degrade
// gracefully — the orchestrator must keep running.

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import {
  STRATEGY_FAMILIES,
  STRATEGY_FAMILY_KEYS,
  STRATEGY_FAMILY_MAP,
  familySubcategories,
  strategyKeyToFamily,
  type StrategyFamily,
  type StrategyFamilyConfig,
} from "@/lib/economics/strategy-families";
import { getStrategyStats } from "@/lib/economics/strategy-stats";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FamilyStatsRollup {
  /** Aggregate `discovered` across every subcategory's StrategyStat. */
  discovered: number;
  /** Aggregate `attempted`. */
  attempted: number;
  /** Aggregate `completed`. */
  completed: number;
  /** Aggregate `failed`. */
  failed: number;
  /** Aggregate `totalNetUsd`. */
  totalNetUsd: number;
  /** Aggregate `totalHours`. */
  totalHours: number;
  /** `totalNetUsd / totalHours` (0 when totalHours is 0). */
  avgHourly: number;
  /** `completed / attempted` (0 when attempted is 0). */
  successRate: number;
  /**
   * The number of StrategyStat rows that contributed to this rollup. Always
   * ≥ 0 (the `reward_program` family has no subcategories so this is 0 for
   * it).
   */
  subcategoryCount: number;
}

export interface AllocationRow {
  family: StrategyFamily;
  displayName: string;
  description: string;
  /** Current target % allocation (0-100). */
  targetAllocation: number;
  /** Phase 3 §34 default % (what the family starts at on bootstrap). */
  defaultAllocation: number;
  /** Hard floor (Phase 3 §26). */
  minAllocation: number;
  /** Hard ceiling (Phase 3 §26). */
  maxAllocation: number;
  disabled: boolean;
  scanFrequency: "high" | "medium" | "low";
  lastRebalancedAt: string | null;
  rebalanceReason: string | null;
  updatedAt: string;
  /** Aggregated stats across the family's subcategories (Phase 3 §40 rollup). */
  stats: FamilyStatsRollup;
  /** "up" | "down" | "flat" — direction of the most recent change (Phase 3 §39 trend). */
  trend: "up" | "down" | "flat";
}

export interface AllocationChangeLogEntry {
  id: string;
  family: StrategyFamily;
  previousAllocation: number;
  newAllocation: number;
  reason: string;
  triggeredBy:
    | "adaptive_rebalancer"
    | "operator"
    | "auto_optimize"
    | "limit_override"
    | "toggle";
  createdAt: string;
}

export interface RebalanceResult {
  rebalanced: boolean;
  changes: Array<{
    family: StrategyFamily;
    previous: number;
    next: number;
    delta: number;
    reason: string;
  }>;
  skippedReason?: string;
}

// ---------------------------------------------------------------------------
// Constants — adaptive rebalance policy (Phase 3 §18, §35)
// ---------------------------------------------------------------------------

/**
 * Minimum sample size (completed opportunities aggregated across a family's
 * subcategories) before the adaptive rebalancer will adjust that family.
 * Below this, the rebalancer leaves the family at its default allocation to
 * avoid over-fitting to a single lucky (or unlucky) attempt.
 */
const MIN_REBALANCE_SAMPLE = 5;

/**
 * Maximum % the adaptive rebalancer will shift to / from a single family in
 * one rebalance pass. Caps the rate of change so a single outlier payout
 * can't swing the allocation wildly.
 */
const MAX_REBALANCE_SHIFT_PCT = 5;

/**
 * The ratio threshold used to decide whether a family is outperforming the
 * baseline. If family A's verified hourly is `> 1.5x` the average, the
 * rebalancer will move allocation toward A. If it's `< 0.67x` (i.e. 1/1.5),
 * the rebalancer will move allocation away.
 */
const OUTPERFORM_RATIO = 1.5;

/**
 * The 65 / 20 / 15 exploit / explore / experimental split for family
 * selection (Phase 3 §18 — adaptive allocator). The numbers match the
 * spec's "65% exploit: pick from the families with the highest verified
 * hourly return. 20% explore: pick from mid-performing families. 15%
 * experimental: pick from families with <3 attempts".
 */
const EXPLOIT_RATIO = 0.65;
const EXPLORE_RATIO = 0.20;
const EXPERIMENTAL_RATIO = 0.15;

// ---------------------------------------------------------------------------
// bootstrapAllocations — idempotent seed of the 7 families
// ---------------------------------------------------------------------------

/**
 * Seed `StrategyAllocation` rows for every canonical family if they don't
 * already exist. Idempotent — safe to call on every startup (and after a
 * fresh DB push). Existing rows are NOT mutated — the operator's overrides +
 * the rebalancer's shifts are preserved.
 *
 * Also asserts that every `OpportunityCategory` value is mapped in
 * `CATEGORY_TO_FAMILY` — if a new category was added to `types.ts` without
 * updating the family map, this logs a warning (it does not throw).
 */
export async function bootstrapAllocations(): Promise<{
  seeded: number;
  skipped: number;
  unmappedCategories: string[];
}> {
  let seeded = 0;
  let skipped = 0;

  try {
    for (const cfg of STRATEGY_FAMILIES) {
      const result = await db.strategyAllocation.upsert({
        where: { family: cfg.family },
        create: {
          family: cfg.family,
          displayName: cfg.displayName,
          targetAllocation: cfg.defaultAllocation,
          minAllocation: cfg.minAllocation,
          maxAllocation: cfg.maxAllocation,
          disabled: cfg.defaultAllocation === 0 ? false : false, // never disable by default
          scanFrequency: cfg.scanFrequency,
        },
        update: {
          // Only refresh display-name + scan-frequency (which may have
          // changed in code). Preserve the operator's target/min/max +
          // the rebalancer's lastRebalancedAt + reason.
          displayName: cfg.displayName,
        },
      });
      if (result.createdAt.getTime() === result.updatedAt.getTime()) {
        seeded += 1;
      } else {
        skipped += 1;
      }
    }

    // Validate that every category is mapped.
    const { findUnmappedCategories } = await import(
      "@/lib/economics/strategy-families"
    );
    const unmapped = findUnmappedCategories();
    if (unmapped.length > 0) {
      console.warn(
        `[strategy-allocator] bootstrapAllocations: ${unmapped.length} ` +
          `unmapped categories: ${unmapped.join(", ")}. ` +
          `Update CATEGORY_TO_FAMILY in strategy-families.ts.`
      );
    }

    // Validate that the default allocations sum to 100 (Phase 3 §34 invariant).
    const { sumDefaultAllocations } = await import(
      "@/lib/economics/strategy-families"
    );
    const sum = sumDefaultAllocations();
    if (sum !== 100) {
      console.warn(
        `[strategy-allocator] bootstrapAllocations: default allocations ` +
          `sum to ${sum} (expected 100). Update STRATEGY_FAMILIES.`
      );
    }

    await logEvent(
      "economics",
      "info",
      "strategy_allocations_bootstrapped",
      {
        families: STRATEGY_FAMILY_KEYS,
        seeded,
        skipped,
        unmappedCategories: unmapped,
      },
      {}
    );
  } catch (err) {
    console.error("[strategy-allocator] bootstrapAllocations failed:", err);
  }

  return {
    seeded,
    skipped,
    unmappedCategories: [],
  };
}

// ---------------------------------------------------------------------------
// getAllocations — read all 7 families + their rolled-up stats
// ---------------------------------------------------------------------------

/**
 * Read every `StrategyAllocation` row + roll up the per-subcategory
 * `StrategyStat` rows into a per-family {@link FamilyStatsRollup}.
 *
 * Always returns 7 rows (one per family) even if the DB is empty — missing
 * rows fall back to the family's `defaultAllocation` from `STRATEGY_FAMILIES`
 * so the dashboard renders even on a cold DB.
 */
export async function getAllocations(): Promise<AllocationRow[]> {
  let rows: Awaited<ReturnType<typeof db.strategyAllocation.findMany>> = [];
  try {
    rows = await db.strategyAllocation.findMany({
      orderBy: { family: "asc" },
    });
  } catch (err) {
    console.error("[strategy-allocator] getAllocations failed:", err);
    rows = [];
  }

  const byFamily = new Map(rows.map((r) => [r.family, r]));

  // Load StrategyStat rows once so we can roll up per-family stats in a single
  // pass instead of one query per family.
  let stats: Awaited<ReturnType<typeof getStrategyStats>> = [];
  try {
    stats = await getStrategyStats();
  } catch (err) {
    console.error("[strategy-allocator] getStrategyStats failed:", err);
    stats = [];
  }

  // Build family → list of StrategyStat rows.
  const familyStats = new Map<StrategyFamily, typeof stats>();
  for (const family of STRATEGY_FAMILY_KEYS) {
    familyStats.set(family, []);
  }
  for (const s of stats) {
    const family = strategyKeyToFamily(s.strategy);
    const list = familyStats.get(family) ?? [];
    list.push(s);
    familyStats.set(family, list);
  }

  // Roll up + build the final AllocationRow list.
  const result: AllocationRow[] = [];
  for (const cfg of STRATEGY_FAMILIES) {
    const row = byFamily.get(cfg.family);
    const targetAllocation = row?.targetAllocation ?? cfg.defaultAllocation;
    const minAllocation = row?.minAllocation ?? cfg.minAllocation;
    const maxAllocation = row?.maxAllocation ?? cfg.maxAllocation;
    const disabled = row?.disabled ?? false;
    const scanFrequency = (row?.scanFrequency as "high" | "medium" | "low") ?? cfg.scanFrequency;
    const lastRebalancedAt = row?.lastRebalancedAt?.toISOString() ?? null;
    const rebalanceReason = row?.rebalanceReason ?? null;
    const updatedAt = row?.updatedAt?.toISOString() ?? new Date().toISOString();

    const list = familyStats.get(cfg.family) ?? [];
    const rollup = rollupFamilyStats(list);

    // Trend: direction of the most recent change for this family.
    let trend: "up" | "down" | "flat" = "flat";
    try {
      const lastChange = await db.strategyAllocationChangeLog.findFirst({
        where: { family: cfg.family },
        orderBy: { createdAt: "desc" },
      });
      if (lastChange) {
        if (lastChange.newAllocation > lastChange.previousAllocation) {
          trend = "up";
        } else if (lastChange.newAllocation < lastChange.previousAllocation) {
          trend = "down";
        }
      }
    } catch (err) {
      console.error("[strategy-allocator] trend lookup failed:", err);
    }

    result.push({
      family: cfg.family,
      displayName: cfg.displayName,
      description: cfg.description,
      targetAllocation,
      defaultAllocation: cfg.defaultAllocation,
      minAllocation,
      maxAllocation,
      disabled,
      scanFrequency,
      lastRebalancedAt,
      rebalanceReason,
      updatedAt,
      stats: rollup,
      trend,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// selectFamilyForCycle — adaptive allocator (Phase 3 §18, §36)
// ---------------------------------------------------------------------------

/**
 * Pick a single strategy family for the next autonomous cycle.
 *
 * Implements the 65 / 20 / 15 exploit / explore / experimental split:
 *
 *   - 65% exploit: pick from the families with the highest verified
 *                   hourly return (top quartile of active families).
 *   - 20% explore:  pick from mid-performing families (25–75 percentile).
 *   - 15% experimental: pick from families with <3 attempts (gather data).
 *
 * Within each bucket the picker is weighted by `targetAllocation` so the
 * operator's allocation targets still bias the choice. Disabled families
 * are never picked. Families outside their min/max window are clamped before
 * weighting (the rebalancer is responsible for moving the target — the
 * picker just consumes whatever the current target is).
 *
 * @returns the chosen family key, or `null` if every family is disabled or
 *          the DB is unreachable.
 */
export async function selectFamilyForCycle(): Promise<StrategyFamily | null> {
  try {
    const allocations = await getAllocations();

    // Filter out disabled families.
    const active = allocations.filter((a) => !a.disabled);
    if (active.length === 0) {
      await logEvent(
        "economics",
        "warn",
        "strategy_family_selection_empty",
        { reason: "every family is disabled" },
        {}
      );
      return null;
    }
    if (active.length === 1) {
      return active[0].family;
    }

    // Sort by verified hourly (descending) so we can pick the "exploit" pool
    // from the top. Use the default allocation as a tiebreaker so a brand-new
    // family (0 attempts) doesn't always win the exploit bucket.
    const ranked = [...active].sort((a, b) => {
      const aHourly = a.stats.avgHourly;
      const bHourly = b.stats.avgHourly;
      if (aHourly !== bHourly) return bHourly - aHourly;
      return b.defaultAllocation - a.defaultAllocation;
    });

    const roll = Math.random();

    // --- 65% exploit: top-quartile family, weighted by allocation. ---------
    if (roll < EXPLOIT_RATIO) {
      const topCount = Math.max(1, Math.ceil(ranked.length / 4));
      const topPool = ranked.slice(0, topCount);
      return weightedPick(topPool);
    }

    // --- 20% explore: mid-quartile family, weighted by allocation. ----------
    if (roll < EXPLOIT_RATIO + EXPLORE_RATIO) {
      const midStart = Math.max(1, Math.floor(ranked.length * 0.25));
      const midEnd = Math.max(midStart + 1, Math.ceil(ranked.length * 0.75));
      const midPool = ranked.slice(midStart, midEnd);
      if (midPool.length === 0) return weightedPick(ranked);
      return weightedPick(midPool);
    }

    // --- 15% experimental: families with < MIN_ATTEMPTS attempts. -----------
    const MIN_ATTEMPTS = 3;
    const experimentalPool = active.filter(
      (a) => a.stats.attempted < MIN_ATTEMPTS
    );
    if (experimentalPool.length > 0) {
      return weightedPick(experimentalPool);
    }

    // Fallback: every family has ≥3 attempts → re-run the exploit pool.
    const topCount = Math.max(1, Math.ceil(ranked.length / 4));
    const topPool = ranked.slice(0, topCount);
    return weightedPick(topPool);
  } catch (err) {
    console.error("[strategy-allocator] selectFamilyForCycle failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// rebalanceAllocations — adaptive rebalancer (Phase 3 §18, §35)
// ---------------------------------------------------------------------------

/**
 * Adaptive rebalancer — runs periodically (every 5+ completed opportunities,
 * gated by the orchestrator loop) to shift allocation toward higher-performing
 * families.
 *
 * Algorithm:
 *   1. Roll up per-family verified $/hr from StrategyStat (via
 *      {@link getAllocations}).
 *   2. Filter to families with ≥ {@link MIN_REBALANCE_SAMPLE} completed
 *      opportunities — below this sample size the rebalancer refuses to
 *      adjust (Phase 3 §35 — requires a minimum sample size before
 *      adjusting).
 *   3. Compute the cross-family average verified $/hr.
 *   4. For each family with enough samples, compute the ratio of its
 *      verified $/hr to the average:
 *        - ratio > OUTPERFORM_RATIO (1.5x): candidate to GAIN allocation.
 *        - ratio < 1/OUTPERFORM_RATIO (0.67x): candidate to LOSE allocation.
 *   5. Shift up to MAX_REBALANCE_SHIFT_PCT (5%) from the under-performers to
 *      the over-performers. Round-robin so no single family dominates.
 *   6. Clamp every result to [minAllocation, maxAllocation] (Phase 3 §26).
 *   7. Persist the new allocations + write a `StrategyAllocationChangeLog`
 *      row per shifted family with a human-readable reason (Phase 3 §23).
 *
 * @returns the changes that were applied (empty if the rebalancer decided to
 *          skip — see `skippedReason` for why).
 */
export async function rebalanceAllocations(): Promise<RebalanceResult> {
  const empty: RebalanceResult = {
    rebalanced: false,
    changes: [],
    skippedReason: "no changes needed",
  };

  try {
    const allocations = await getAllocations();
    const active = allocations.filter((a) => !a.disabled);
    if (active.length < 2) {
      return { ...empty, skippedReason: "fewer than 2 active families" };
    }

    // Phase 3 §35: requires a minimum sample size (5 completed opportunities)
    // before adjusting. Filter the families that have enough data.
    const withSamples = active.filter(
      (a) => a.stats.completed >= MIN_REBALANCE_SAMPLE
    );
    if (withSamples.length < 2) {
      return {
        ...empty,
        skippedReason: `only ${withSamples.length} families have ≥${MIN_REBALANCE_SAMPLE} completed opportunities`,
      };
    }

    // Cross-family average verified $/hr (weighted by hours so a family with
    // 100 hours of data counts more than one with 5 hours).
    const totalHours = withSamples.reduce(
      (sum, a) => sum + a.stats.totalHours,
      0
    );
    const weightedHourly =
      withSamples.reduce(
        (sum, a) => sum + a.stats.avgHourly * a.stats.totalHours,
        0
      ) / Math.max(totalHours, 1);

    if (weightedHourly <= 0) {
      return {
        ...empty,
        skippedReason: "weighted avg verified $/hr is 0 — no signal to rebalance",
      };
    }

    // Classify each family as over-performer / under-performer / steady.
    const overPerformers: Array<{
      alloc: AllocationRow;
      ratio: number;
    }> = [];
    const underPerformers: Array<{
      alloc: AllocationRow;
      ratio: number;
    }> = [];

    for (const alloc of withSamples) {
      const ratio = alloc.stats.avgHourly / weightedHourly;
      if (ratio > OUTPERFORM_RATIO) overPerformers.push({ alloc, ratio });
      else if (ratio < 1 / OUTPERFORM_RATIO) underPerformers.push({ alloc, ratio });
    }

    if (overPerformers.length === 0 || underPerformers.length === 0) {
      return {
        ...empty,
        skippedReason:
          "no over/under-performers detected (every family within ±50% of the average)",
      };
    }

    // Sort over-performers by ratio desc (best first); under-performers by
    // ratio asc (worst first).
    overPerformers.sort((a, b) => b.ratio - a.ratio);
    underPerformers.sort((a, b) => a.ratio - b.ratio);

    // Distribute up to MAX_REBALANCE_SHIFT_PCT per family per pass.
    // Round-robin: take 1% at a time from the worst under-performer, give
    // it to the best over-performer, until we've moved MAX_REBALANCE_SHIFT_PCT
    // or one side is exhausted.
    const changes: RebalanceResult["changes"] = [];
    const newTargets = new Map<StrategyFamily, number>(
      active.map((a) => [a.family, a.targetAllocation])
    );

    let shiftsApplied = 0;
    let overIdx = 0;
    let underIdx = 0;

    while (
      shiftsApplied < MAX_REBALANCE_SHIFT_PCT &&
      overIdx < overPerformers.length &&
      underIdx < underPerformers.length
    ) {
      const gainer = overPerformers[overIdx];
      const loser = underPerformers[underIdx];

      const loserCurrent = newTargets.get(loser.alloc.family) ?? loser.alloc.targetAllocation;
      const gainerCurrent = newTargets.get(gainer.alloc.family) ?? gainer.alloc.targetAllocation;

      // Respect the loser's minAllocation floor + the gainer's maxAllocation ceiling.
      const loserFloor = loser.alloc.minAllocation;
      const gainerCeil = gainer.alloc.maxAllocation;

      if (loserCurrent <= loserFloor) {
        underIdx += 1;
        continue;
      }
      if (gainerCurrent >= gainerCeil) {
        overIdx += 1;
        continue;
      }

      const shift = Math.min(1, MAX_REBALANCE_SHIFT_PCT - shiftsApplied);
      const newLoser = Math.max(loserFloor, loserCurrent - shift);
      const newGainer = Math.min(gainerCeil, gainerCurrent + (loserCurrent - newLoser));
      const actualShift = loserCurrent - newLoser;

      if (actualShift <= 0) {
        underIdx += 1;
        continue;
      }

      newTargets.set(loser.alloc.family, newLoser);
      newTargets.set(gainer.alloc.family, newGainer);
      shiftsApplied += actualShift;

      const reason =
        `${gainer.alloc.displayName} produced ${(gainer.ratio).toFixed(1)}x higher verified ` +
        `$${gainer.alloc.stats.avgHourly.toFixed(2)}/hr across ${gainer.alloc.stats.completed} ` +
        `completed tasks. Shifting ${actualShift}% from ${loser.alloc.displayName} ` +
        `(${loser.ratio.toFixed(1)}x avg, $${loser.alloc.stats.avgHourly.toFixed(2)}/hr).`;

      changes.push({
        family: gainer.alloc.family,
        previous: gainerCurrent,
        next: newGainer,
        delta: newGainer - gainerCurrent,
        reason: `+${actualShift}% → ${reason}`,
      });
      changes.push({
        family: loser.alloc.family,
        previous: loserCurrent,
        next: newLoser,
        delta: newLoser - loserCurrent,
        reason: `-${actualShift}% ← ${reason}`,
      });

      // Move the indices forward — both sides get a chance at the next pass.
      overIdx += 1;
      underIdx += 1;
    }

    if (changes.length === 0) {
      return {
        ...empty,
        skippedReason: "every candidate clamped to its min/max — nothing to shift",
      };
    }

    // Persist the changes + write the change log entries.
    const timestamp = new Date();
    const overallReason =
      `Adaptive rebalance: shifted ${shiftsApplied}% across ${changes.length / 2} ` +
      `family pair(s) based on verified $/hr over ${totalHours.toFixed(1)} hours of data ` +
      `(weighted avg $${weightedHourly.toFixed(2)}/hr).`;

    for (const change of changes) {
      const newTarget = newTargets.get(change.family);
      if (newTarget === undefined) continue;

      await db.strategyAllocation.update({
        where: { family: change.family },
        data: {
          targetAllocation: newTarget,
          lastRebalancedAt: timestamp,
          rebalanceReason: overallReason,
        },
      });

      await db.strategyAllocationChangeLog.create({
        data: {
          family: change.family,
          previousAllocation: change.previous,
          newAllocation: change.next,
          reason: change.reason,
          triggeredBy: "adaptive_rebalancer",
        },
      });
    }

    await logEvent(
      "economics",
      "info",
      "strategy_allocations_rebalanced",
      {
        shiftsApplied,
        changes: changes.length,
        weightedHourly,
        totalHours,
        reason: overallReason,
      },
      {}
    );

    return { rebalanced: true, changes };
  } catch (err) {
    console.error("[strategy-allocator] rebalanceAllocations failed:", err);
    return {
      rebalanced: false,
      changes: [],
      skippedReason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// setAllocation — operator override (Phase 3 §25)
// ---------------------------------------------------------------------------

/**
 * Set a single family's `targetAllocation` to the given percentage. The
 * other families are rescaled proportionally so the total remains 100%
 * (Phase 3 §25 validation rule).
 *
 * Rules:
 *   - `percentage` must be within [family.minAllocation, family.maxAllocation]
 *     (Phase 3 §26 hard limits).
 *   - The family must exist in `STRATEGY_FAMILIES`.
 *   - The other families are NOT scaled below their own minAllocation or
 *     above their maxAllocation — if rescaling would violate a limit, the
 *     surplus/deficit is distributed to the next family in the round-robin.
 *   - A `StrategyAllocationChangeLog` row is written for every family whose
 *     target changes.
 *
 * @returns the resulting allocations + the list of changes applied.
 */
export async function setAllocation(
  family: StrategyFamily,
  percentage: number
): Promise<{ ok: boolean; error?: string; changes?: RebalanceResult["changes"] }> {
  try {
    const cfg = STRATEGY_FAMILY_MAP[family];
    if (!cfg) {
      return { ok: false, error: `Unknown strategy family: ${family}` };
    }

    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      return { ok: false, error: "percentage must be a number in [0, 100]." };
    }

    const allocations = await getAllocations();
    const target = allocations.find((a) => a.family === family);
    if (!target) {
      return { ok: false, error: `Family ${family} not in current allocations.` };
    }
    if (target.disabled) {
      return {
        ok: false,
        error: `Family ${family} is disabled — enable it before setting allocation.`,
      };
    }
    if (percentage < target.minAllocation) {
      return {
        ok: false,
        error: `percentage ${percentage}% is below the minAllocation floor ${target.minAllocation}% for ${family}.`,
      };
    }
    if (percentage > target.maxAllocation) {
      return {
        ok: false,
        error: `percentage ${percentage}% exceeds the maxAllocation ceiling ${target.maxAllocation}% for ${family}.`,
      };
    }

    // The remaining % to distribute across the other (non-disabled) families.
    const others = allocations.filter(
      (a) => a.family !== family && !a.disabled
    );
    const remaining = Math.max(0, 100 - percentage);

    // Current sum of the others' targets — used to scale them proportionally.
    const othersCurrentSum = others.reduce(
      (sum, a) => sum + a.targetAllocation,
      0
    );

    const newTargets = new Map<StrategyFamily, number>();
    newTargets.set(family, percentage);

    if (others.length === 0) {
      // No other families — the single family must equal 100%.
      if (Math.abs(percentage - 100) > 0.01) {
        return {
          ok: false,
          error: "no other active families to absorb the remainder — percentage must equal 100.",
        };
      }
    } else {
      // Scale each other family by (current / othersCurrentSum) * remaining.
      // If othersCurrentSum is 0 (every other family is at 0%), split evenly.
      let distributed = 0;
      for (let i = 0; i < others.length; i++) {
        const a = others[i];
        const share =
          othersCurrentSum > 0
            ? (a.targetAllocation / othersCurrentSum) * remaining
            : remaining / others.length;
        const clampedShare = Math.max(
          a.minAllocation,
          Math.min(a.maxAllocation, share)
        );
        newTargets.set(a.family, clampedShare);
        distributed += clampedShare;
      }

      // Fix rounding drift — adjust the last family to absorb the residual.
      const drift = 100 - (percentage + distributed);
      if (Math.abs(drift) > 0.001) {
        // Find a family that has room in its [min, max] window.
        for (let i = 0; i < others.length; i++) {
          const a = others[i];
          const current = newTargets.get(a.family) ?? a.targetAllocation;
          const adjusted = Math.max(
            a.minAllocation,
            Math.min(a.maxAllocation, current + drift)
          );
          if (adjusted !== current) {
            newTargets.set(a.family, adjusted);
            break;
          }
        }
      }
    }

    // Persist + log every family whose target changed.
    const changes: RebalanceResult["changes"] = [];
    const timestamp = new Date();
    for (const [f, newTarget] of newTargets) {
      const before = allocations.find((a) => a.family === f);
      const beforeTarget = before?.targetAllocation ?? 0;
      if (Math.abs(newTarget - beforeTarget) < 0.001) continue;

      await db.strategyAllocation.update({
        where: { family: f },
        data: {
          targetAllocation: newTarget,
          lastRebalancedAt: timestamp,
          rebalanceReason: f === family
            ? `Operator override: set ${family} to ${percentage}%.`
            : `Auto-rescaled after operator set ${family} to ${percentage}%.`,
        },
      });

      await db.strategyAllocationChangeLog.create({
        data: {
          family: f,
          previousAllocation: beforeTarget,
          newAllocation: newTarget,
          reason: f === family
            ? `Operator override: set ${family} to ${percentage}%.`
            : `Auto-rescaled to keep total at 100% after operator set ${family} to ${percentage}%.`,
          triggeredBy: "operator",
        },
      });

      changes.push({
        family: f,
        previous: beforeTarget,
        next: newTarget,
        delta: newTarget - beforeTarget,
        reason: f === family
          ? `Operator set to ${percentage}%.`
          : `Auto-rescaled (${(newTarget - beforeTarget).toFixed(2)}%).`,
      });
    }

    await logEvent(
      "economics",
      "info",
      "strategy_allocation_override",
      {
        family,
        percentage,
        changes: changes.length,
      },
      {}
    );

    return { ok: true, changes };
  } catch (err) {
    console.error("[strategy-allocator] setAllocation failed:", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// setAllocationLimits — operator hard limits (Phase 3 §26)
// ---------------------------------------------------------------------------

/**
 * Set the operator-defined hard floor + ceiling for a family (Phase 3 §26).
 *
 * Rules:
 *   - `min` must be ≥ 0 and ≤ `max`.
 *   - `max` must be ≥ `min` and ≤ 100.
 *   - If the family's current `targetAllocation` is outside the new window,
 *     it is clamped into the window (and a change-log row is written).
 *   - The family's `minAllocation` / `maxAllocation` are persisted.
 */
export async function setAllocationLimits(
  family: StrategyFamily,
  min: number,
  max: number
): Promise<{ ok: boolean; error?: string; newTarget?: number }> {
  try {
    const cfg = STRATEGY_FAMILY_MAP[family];
    if (!cfg) {
      return { ok: false, error: `Unknown strategy family: ${family}` };
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { ok: false, error: "min and max must be finite numbers." };
    }
    if (min < 0 || max > 100) {
      return { ok: false, error: "min must be ≥ 0 and max must be ≤ 100." };
    }
    if (min > max) {
      return { ok: false, error: `min (${min}) cannot exceed max (${max}).` };
    }

    const existing = await db.strategyAllocation.findUnique({
      where: { family },
    });
    if (!existing) {
      return { ok: false, error: `Family ${family} not bootstrapped yet.` };
    }

    const previousTarget = existing.targetAllocation;
    const newTarget = Math.max(min, Math.min(max, previousTarget));
    const targetChanged = Math.abs(newTarget - previousTarget) > 0.001;

    await db.strategyAllocation.update({
      where: { family },
      data: {
        minAllocation: min,
        maxAllocation: max,
        targetAllocation: newTarget,
        lastRebalancedAt: targetChanged ? new Date() : existing.lastRebalancedAt,
        rebalanceReason: targetChanged
          ? `Limit override: clamped target from ${previousTarget}% to ${newTarget}% (new window [${min}, ${max}]).`
          : existing.rebalanceReason,
      },
    });

    if (targetChanged) {
      await db.strategyAllocationChangeLog.create({
        data: {
          family,
          previousAllocation: previousTarget,
          newAllocation: newTarget,
          reason: `Limit override: clamped target from ${previousTarget}% to ${newTarget}% (new window [${min}, ${max}]).`,
          triggeredBy: "limit_override",
        },
      });
    }

    await logEvent(
      "economics",
      "info",
      "strategy_allocation_limits_set",
      { family, min, max, previousTarget, newTarget },
      {}
    );

    return { ok: true, newTarget };
  } catch (err) {
    console.error("[strategy-allocator] setAllocationLimits failed:", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// disableFamily / enableFamily — operator toggle (Phase 3 §25)
// ---------------------------------------------------------------------------

export async function disableFamily(
  family: StrategyFamily
): Promise<{ ok: boolean; error?: string }> {
  try {
    const existing = await db.strategyAllocation.findUnique({
      where: { family },
    });
    if (!existing) {
      return { ok: false, error: `Family ${family} not bootstrapped yet.` };
    }
    if (existing.disabled) {
      return { ok: true }; // idempotent
    }

    // When a family is disabled, redistribute its target across the other
    // active families so the total stays at 100%.
    const others = await db.strategyAllocation.findMany({
      where: { family: { not: family }, disabled: false },
    });
    const disabledTarget = existing.targetAllocation;
    const othersSum = others.reduce((sum, a) => sum + a.targetAllocation, 0);

    await db.strategyAllocation.update({
      where: { family },
      data: {
        disabled: true,
        targetAllocation: 0,
        lastRebalancedAt: new Date(),
        rebalanceReason: `Family disabled by operator. Reallocated ${disabledTarget}% to other active families.`,
      },
    });

    await db.strategyAllocationChangeLog.create({
      data: {
        family,
        previousAllocation: disabledTarget,
        newAllocation: 0,
        reason: `Family disabled by operator. Reallocated ${disabledTarget}% to other active families.`,
        triggeredBy: "toggle",
      },
    });

    if (othersSum > 0) {
      for (const other of others) {
        const newTarget = Math.min(
          other.maxAllocation,
          other.targetAllocation + (disabledTarget * other.targetAllocation / othersSum)
        );
        if (Math.abs(newTarget - other.targetAllocation) > 0.001) {
          await db.strategyAllocation.update({
            where: { family: other.family },
            data: { targetAllocation: newTarget },
          });
          await db.strategyAllocationChangeLog.create({
            data: {
              family: other.family as StrategyFamily,
              previousAllocation: other.targetAllocation,
              newAllocation: newTarget,
              reason: `Auto-rescaled after ${family} disabled (+${(newTarget - other.targetAllocation).toFixed(2)}%).`,
              triggeredBy: "toggle",
            },
          });
        }
      }
    }

    await logEvent(
      "economics",
      "warn",
      "strategy_family_disabled",
      { family, reallocatedPct: disabledTarget },
      {}
    );

    return { ok: true };
  } catch (err) {
    console.error("[strategy-allocator] disableFamily failed:", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function enableFamily(
  family: StrategyFamily
): Promise<{ ok: boolean; error?: string }> {
  try {
    const cfg = STRATEGY_FAMILY_MAP[family];
    if (!cfg) return { ok: false, error: `Unknown strategy family: ${family}` };

    const existing = await db.strategyAllocation.findUnique({
      where: { family },
    });
    if (!existing) {
      return { ok: false, error: `Family ${family} not bootstrapped yet.` };
    }
    if (!existing.disabled) {
      return { ok: true }; // idempotent
    }

    // When re-enabling, restore the family's default allocation + take the
    // delta proportionally from the other active families so the total stays
    // at 100%.
    const restored = cfg.defaultAllocation;
    const others = await db.strategyAllocation.findMany({
      where: { family: { not: family }, disabled: false },
    });
    const othersSum = others.reduce((sum, a) => sum + a.targetAllocation, 0);

    await db.strategyAllocation.update({
      where: { family },
      data: {
        disabled: false,
        targetAllocation: restored,
        lastRebalancedAt: new Date(),
        rebalanceReason: `Family enabled by operator. Restored to default ${restored}% (taken proportionally from other active families).`,
      },
    });

    await db.strategyAllocationChangeLog.create({
      data: {
        family,
        previousAllocation: 0,
        newAllocation: restored,
        reason: `Family enabled by operator. Restored to default ${restored}%.`,
        triggeredBy: "toggle",
      },
    });

    if (othersSum > 0) {
      for (const other of others) {
        const take = (restored * other.targetAllocation / othersSum);
        const newTarget = Math.max(
          other.minAllocation,
          other.targetAllocation - take
        );
        if (Math.abs(newTarget - other.targetAllocation) > 0.001) {
          await db.strategyAllocation.update({
            where: { family: other.family },
            data: { targetAllocation: newTarget },
          });
          await db.strategyAllocationChangeLog.create({
            data: {
              family: other.family as StrategyFamily,
              previousAllocation: other.targetAllocation,
              newAllocation: newTarget,
              reason: `Auto-rescaled after ${family} enabled (${(other.targetAllocation - newTarget).toFixed(2)}% given back).`,
              triggeredBy: "toggle",
            },
          });
        }
      }
    }

    await logEvent(
      "economics",
      "info",
      "strategy_family_enabled",
      { family, restoredPct: restored },
      {}
    );

    return { ok: true };
  } catch (err) {
    console.error("[strategy-allocator] enableFamily failed:", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// autoOptimize — return control to the adaptive allocator (Phase 3 §25)
// ---------------------------------------------------------------------------

/**
 * Reset every family's `targetAllocation` to the adaptive-computed value.
 * The current implementation uses the family's `defaultAllocation` from
 * `STRATEGY_FAMILIES` as the "fresh" target — once enough verified-earning
 * data exists, the next call to {@link rebalanceAllocations} will adjust
 * toward the measured performance.
 *
 * This wipes operator overrides — every family's `targetAllocation` is
 * reset to its `defaultAllocation`. Hard limits (min/max) + the disabled
 * flag are preserved.
 *
 * Writes one `StrategyAllocationChangeLog` row per family whose target
 * actually changed (triggeredBy = "auto_optimize").
 */
export async function autoOptimize(): Promise<{
  ok: boolean;
  changes: RebalanceResult["changes"];
  error?: string;
}> {
  try {
    const allocations = await getAllocations();
    const changes: RebalanceResult["changes"] = [];
    const timestamp = new Date();

    for (const a of allocations) {
      const cfg: StrategyFamilyConfig | undefined = STRATEGY_FAMILY_MAP[a.family];
      if (!cfg) continue;
      if (a.disabled) continue;

      // Clamp the default into [min, max] — the operator's hard limits
      // survive autoOptimize.
      const newTarget = Math.max(
        a.minAllocation,
        Math.min(a.maxAllocation, cfg.defaultAllocation)
      );

      if (Math.abs(newTarget - a.targetAllocation) < 0.001) continue;

      await db.strategyAllocation.update({
        where: { family: a.family },
        data: {
          targetAllocation: newTarget,
          lastRebalancedAt: timestamp,
          rebalanceReason: `Auto-optimize: reset to default ${cfg.defaultAllocation}% (clamped to [${a.minAllocation}, ${a.maxAllocation}]).`,
        },
      });

      await db.strategyAllocationChangeLog.create({
        data: {
          family: a.family,
          previousAllocation: a.targetAllocation,
          newAllocation: newTarget,
          reason: `Auto-optimize: reset to default ${cfg.defaultAllocation}% (clamped to [${a.minAllocation}, ${a.maxAllocation}]).`,
          triggeredBy: "auto_optimize",
        },
      });

      changes.push({
        family: a.family,
        previous: a.targetAllocation,
        next: newTarget,
        delta: newTarget - a.targetAllocation,
        reason: `Auto-optimize reset to ${newTarget}%.`,
      });
    }

    await logEvent(
      "economics",
      "info",
      "strategy_allocations_auto_optimized",
      { changes: changes.length },
      {}
    );

    return { ok: true, changes };
  } catch (err) {
    console.error("[strategy-allocator] autoOptimize failed:", err);
    return {
      ok: false,
      changes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// getAllocationChangeLog — audit trail (Phase 3 §23)
// ---------------------------------------------------------------------------

/**
 * Return the allocation change-log entries, newest-first. Used by the
 * dashboard's "Allocation Change Log" panel.
 *
 * @param limit default 50, hard-cap 500.
 */
export async function getAllocationChangeLog(
  limit = 50
): Promise<AllocationChangeLogEntry[]> {
  try {
    const cappedLimit = Math.max(1, Math.min(limit, 500));
    const rows = await db.strategyAllocationChangeLog.findMany({
      orderBy: { createdAt: "desc" },
      take: cappedLimit,
    });
    return rows.map((r) => ({
      id: r.id,
      family: r.family as StrategyFamily,
      previousAllocation: r.previousAllocation,
      newAllocation: r.newAllocation,
      reason: r.reason,
      triggeredBy: r.triggeredBy as AllocationChangeLogEntry["triggeredBy"],
      createdAt: r.createdAt.toISOString(),
    }));
  } catch (err) {
    console.error("[strategy-allocator] getAllocationChangeLog failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Roll up an array of `StrategyStatRow` (one per subcategory) into a single
 * {@link FamilyStatsRollup}. Empty list → zeroed rollup.
 */
function rollupFamilyStats<
  T extends {
    discovered: number;
    attempted: number;
    completed: number;
    failed: number;
    totalNetUsd: number;
    totalHours: number;
  }
>(rows: T[]): FamilyStatsRollup {
  let discovered = 0;
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  let totalNetUsd = 0;
  let totalHours = 0;

  for (const r of rows) {
    discovered += finiteOr(r.discovered, 0);
    attempted += finiteOr(r.attempted, 0);
    completed += finiteOr(r.completed, 0);
    failed += finiteOr(r.failed, 0);
    totalNetUsd += finiteOr(r.totalNetUsd, 0);
    totalHours += finiteOr(r.totalHours, 0);
  }

  return {
    discovered,
    attempted,
    completed,
    failed,
    totalNetUsd,
    totalHours,
    avgHourly: totalHours > 0 ? totalNetUsd / totalHours : 0,
    successRate: attempted > 0 ? completed / attempted : 0,
    subcategoryCount: rows.length,
  };
}

/**
 * Weighted random pick — each family's weight is its `targetAllocation`.
 * Falls back to uniform if every weight is 0 (e.g. every family is at the
 * default 0% — only happens before bootstrap).
 */
function weightedPick(rows: AllocationRow[]): StrategyFamily {
  const total = rows.reduce((sum, r) => sum + Math.max(r.targetAllocation, 0), 0);
  if (total <= 0) {
    const idx = Math.floor(Math.random() * rows.length);
    return rows[idx].family;
  }
  let roll = Math.random() * total;
  for (const r of rows) {
    roll -= Math.max(r.targetAllocation, 0);
    if (roll <= 0) return r.family;
  }
  return rows[rows.length - 1].family;
}

function finiteOr(n: number | null | undefined, fallback: number): number {
  if (n === null || n === undefined || !Number.isFinite(n)) return fallback;
  return n;
}

// Re-export the family-subcategories helper for callers that want to know
// which canonical strategies roll up into a given family.
export { familySubcategories };
