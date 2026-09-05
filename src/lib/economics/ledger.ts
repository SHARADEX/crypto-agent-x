// Earnings ledger (spec §14).
//
// The ledger is the source of truth for every dollar the agent has earned
// (or expects to earn). Spec §14 mandates that "expected" and "verified"
// entries NEVER mix — they live in the same `Earning` table but are
// distinguished by the `expected` and `verified` boolean flags:
//
//   - `expected=true,  verified=false` → the agent predicts this opportunity
//                                         will pay $X once executed.
//   - `expected=false, verified=true`  → the agent received $X (with a real
//                                         on-chain transaction hash).
//
// The lifecycle is:
//
//   1. recordExpected(opportunity)            — when an opportunity is queued
//                                               for execution (status =
//                                               "queued" or "approved").
//   2. recordVerifiedEarning(input)           — when a payment is observed
//                                               on-chain (independent of any
//                                               opportunity, e.g. an out-of-
//                                               band bounty payout).
//   3. convertExpectedToVerified(opId, ...)   — when an on-chain payment is
//                                               matched to a previously-
//                                               recorded expected earning.
//
// Every write also increments the relevant `StrategyStat` row so the
// strategy-learning subsystem (spec §15, §16) has fresh data to rank with.

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import { recordStrategyOutcome } from "@/lib/economics/strategy-stats";
import type { LedgerEntry, Opportunity as OpportunityType } from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LedgerQuery {
  /** If true, only return rows where `verified = true`. */
  verifiedOnly?: boolean;
  /** If true, only return rows where `expected = true`. */
  expectedOnly?: boolean;
  /** Maximum number of rows to return (default 100, hard-capped at 1000). */
  limit?: number;
}

export interface LedgerTotals {
  /** Sum of `netUsd` across verified rows. */
  verifiedNetUsd: number;
  /** Sum of `netUsd` across expected (not-yet-verified) rows. */
  expectedNetUsd: number;
  /** Sum of `grossUsd` across all rows. */
  totalGrossUsd: number;
  /** Sum of `feesUsd` across verified rows. */
  totalFeesUsd: number;
  /** Sum of `expensesUsd` across verified rows. */
  totalExpensesUsd: number;
  /** Sum of `hoursSpent` across verified rows. */
  totalHours: number;
  /** `verifiedNetUsd / totalHours` (0 when totalHours is 0). */
  avgHourlyReturn: number;
  /** Count of verified rows (each verified earning = 1 attempted opportunity). */
  opportunitiesAttempted: number;
  /** Count of verified rows with `netUsd > 0`. */
  opportunitiesCompleted: number;
  /** `opportunitiesCompleted / opportunitiesAttempted` (0 when attempted is 0). */
  successRate: number;
  /** Per-category rollup of `{ count, usd, netUsd, grossUsd }`. */
  byCategory: Record<string, { count: number; usd: number; netUsd?: number; grossUsd?: number }>;
  /** Per-source rollup of `{ count, usd }`. */
  bySource: Record<string, { count: number; usd: number }>;
  /** Per-strategy rollup of `{ count, netUsd, grossUsd }` (strategy = category when not set). */
  byStrategy: Record<string, { count: number; netUsd: number; grossUsd: number }>;
}

export interface VerifiedEarningInput {
  opportunityId?: string;
  source: string;
  category: string;
  grossUsd: number;
  feesUsd?: number;
  expensesUsd?: number;
  hoursSpent: number;
  currency: string;
  transactionHash?: string;
  chain?: string;
  strategy?: string;
}

export interface ConvertExpectedInput {
  /** On-chain transaction hash that matched the expected earning. */
  transactionHash: string;
  /** Chain the payment landed on. */
  chain?: string;
  /** Override the expected gross with the verified on-chain amount. */
  grossUsd?: number;
  feesUsd?: number;
  expensesUsd?: number;
  hoursSpent?: number;
}

// ---------------------------------------------------------------------------
// getLedger
// ---------------------------------------------------------------------------

/**
 * Return `Earning` rows as {@link LedgerEntry} objects, ordered newest-first.
 *
 * Filter flags:
 *   - `verifiedOnly` → only rows where `verified = true`
 *   - `expectedOnly` → only rows where `expected = true`
 *
 * DB failures degrade to an empty array (logged to console) — the caller
 * can render an empty ledger without crashing.
 */
export async function getLedger(
  opts: LedgerQuery = {}
): Promise<LedgerEntry[]> {
  try {
    const where: Record<string, unknown> = {};
    if (opts.verifiedOnly) where.verified = true;
    if (opts.expectedOnly) where.expected = true;

    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));

    const rows = await db.earning.findMany({
      where: where as never,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(rowToLedgerEntry);
  } catch (err) {
    console.error("[ledger] getLedger failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// getTotals
// ---------------------------------------------------------------------------

/**
 * Aggregate the entire ledger into a single {@link LedgerTotals} snapshot.
 * Used by the dashboard's headline numbers and by the strategy-learning
 * subsystem to compute `avgHourlyReturn` for the whole agent.
 *
 * Sums are computed in JS (not via Prisma aggregation) so we can build the
 * `byCategory` / `bySource` rollups in a single pass. The ledger is
 * expected to stay small (thousands of rows at most) so this is fine.
 */
export async function getTotals(): Promise<LedgerTotals> {
  const empty: LedgerTotals = {
    verifiedNetUsd: 0,
    expectedNetUsd: 0,
    totalGrossUsd: 0,
    totalFeesUsd: 0,
    totalExpensesUsd: 0,
    totalHours: 0,
    avgHourlyReturn: 0,
    opportunitiesAttempted: 0,
    opportunitiesCompleted: 0,
    successRate: 0,
    byCategory: {},
    bySource: {},
    byStrategy: {},
  };

  try {
    const rows = await db.earning.findMany();

    let verifiedNetUsd = 0;
    let expectedNetUsd = 0;
    let totalGrossUsd = 0;
    let totalFeesUsd = 0;
    let totalExpensesUsd = 0;
    let totalHours = 0;
    let attempted = 0;
    let completed = 0;
    const byCategory: Record<string, { count: number; usd: number; netUsd: number; grossUsd: number }> = {};
    const bySource: Record<string, { count: number; usd: number }> = {};
    const byStrategy: Record<string, { count: number; netUsd: number; grossUsd: number }> = {};

    for (const r of rows) {
      const gross = finiteOr(r.grossUsd, 0);
      const net = finiteOr(r.netUsd, 0);
      const hours = finiteOr(r.hoursSpent, 0);
      const fees = finiteOr(r.feesUsd, 0);
      const expenses = finiteOr(r.expensesUsd, 0);

      totalGrossUsd += gross;

      if (r.verified) {
        verifiedNetUsd += net;
        totalFeesUsd += fees;
        totalExpensesUsd += expenses;
        totalHours += hours;
        attempted += 1;
        if (net > 0) completed += 1;
      } else if (r.expected) {
        expectedNetUsd += net;
      }

      const cat = r.category || "unknown";
      if (!byCategory[cat]) byCategory[cat] = { count: 0, usd: 0, netUsd: 0, grossUsd: 0 };
      byCategory[cat].count += 1;
      byCategory[cat].usd += net;
      byCategory[cat].netUsd += net;
      byCategory[cat].grossUsd += gross;

      const src = r.source || "unknown";
      if (!bySource[src]) bySource[src] = { count: 0, usd: 0 };
      bySource[src].count += 1;
      bySource[src].usd += net;

      // Strategy = explicit strategy field if set, else category (the common
      // case — recordVerifiedEarning defaults strategy to the category).
      const strat = r.strategy || cat;
      if (!byStrategy[strat]) byStrategy[strat] = { count: 0, netUsd: 0, grossUsd: 0 };
      byStrategy[strat].count += 1;
      byStrategy[strat].netUsd += net;
      byStrategy[strat].grossUsd += gross;
    }

    const avgHourlyReturn = totalHours > 0 ? verifiedNetUsd / totalHours : 0;
    const successRate = attempted > 0 ? completed / attempted : 0;

    return {
      verifiedNetUsd,
      expectedNetUsd,
      totalGrossUsd,
      totalFeesUsd,
      totalExpensesUsd,
      totalHours,
      avgHourlyReturn,
      opportunitiesAttempted: attempted,
      opportunitiesCompleted: completed,
      successRate,
      byCategory,
      bySource,
      byStrategy,
    };
  } catch (err) {
    console.error("[ledger] getTotals failed:", err);
    return empty;
  }
}

// ---------------------------------------------------------------------------
// recordExpected
// ---------------------------------------------------------------------------

/**
 * Record an *expected* earning for an opportunity (spec §14).
 *
 * Called when an opportunity is queued for execution — the agent has
 * computed an `expectedValue` via the economics engine and wants to log
 * "we predict this opportunity will pay $X" before execution starts.
 *
 * Expected earnings use `expected=true, verified=false`. They NEVER mix
 * with verified earnings — the dashboard renders them as a separate
 * "pipeline" total, and they're replaced by a verified earning (via
 * {@link convertExpectedToVerified}) once the payment is observed on-chain.
 *
 * @param opportunity  the in-memory Opportunity (must have `expectedValue`
 *                     populated by the economics engine)
 * @returns the created {@link LedgerEntry}, or `null` on failure.
 */
export async function recordExpected(
  opportunity: OpportunityType
): Promise<LedgerEntry | null> {
  try {
    const netUsd = finiteOr(opportunity.expectedValue, 0);
    const hoursSpent = Math.max(finiteOr(opportunity.estimatedHours, 0.5), 0.5);
    const hourlyReturn = netUsd / hoursSpent;

    // Be defensive: the DB Opportunity has flat `rewardCurrency` while the
    // canonical Opportunity type has nested `reward.currency`. Accept either.
    const currency =
      (opportunity as unknown as { reward?: { currency?: string } }).reward?.currency ??
      (opportunity as unknown as { rewardCurrency?: string }).rewardCurrency ??
      "USDC";

    const row = await db.earning.create({
      data: {
        opportunityId: opportunity.id || undefined,
        source: opportunity.source,
        category: opportunity.category,
        // Expected gross == expected net (no fees/expenses yet — those are
        // only known after the payment is verified on-chain).
        grossUsd: netUsd,
        feesUsd: 0,
        expensesUsd: 0,
        netUsd,
        hoursSpent,
        hourlyReturn,
        currency,
        verified: false,
        expected: true,
        strategy: opportunity.category,
      },
    });

    await logEvent(
      "economics",
      "info",
      "expected_earning_recorded",
      {
        opportunityId: opportunity.id,
        source: opportunity.source,
        category: opportunity.category,
        expectedNetUsd: netUsd,
        hoursSpent,
        hourlyReturn,
      },
      opportunity.id ? { opportunityId: opportunity.id } : undefined
    );

    return rowToLedgerEntry(row);
  } catch (err) {
    console.error("[ledger] recordExpected failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// recordVerifiedEarning
// ---------------------------------------------------------------------------

/**
 * Record a *verified* earning (spec §14).
 *
 * Called when a payment is observed on-chain — independent of any
 * opportunity (e.g. an out-of-band bounty payout to a monitored wallet).
 * If `opportunityId` is provided AND a matching expected earning exists,
 * the caller SHOULD prefer {@link convertExpectedToVerified} instead so the
 * expected row is upgraded rather than duplicated.
 *
 * Computes `netUsd = grossUsd - feesUsd - expensesUsd` (floored at 0 so a
 * net-negative payout can't poison the totals) and
 * `hourlyReturn = netUsd / hoursSpent`.
 *
 * Also increments the relevant `StrategyStat` row via
 * {@link recordStrategyOutcome} so the strategy-learning subsystem has
 * fresh data on the next cycle.
 *
 * @returns the created {@link LedgerEntry}, or `null` on failure.
 */
export async function recordVerifiedEarning(
  input: VerifiedEarningInput
): Promise<LedgerEntry | null> {
  try {
    const grossUsd = finiteOr(input.grossUsd, 0);
    const feesUsd = finiteOr(input.feesUsd, 0);
    const expensesUsd = finiteOr(input.expensesUsd, 0);
    const hoursSpent = Math.max(finiteOr(input.hoursSpent, 0.5), 0.5);
    const netUsd = Math.max(0, grossUsd - feesUsd - expensesUsd);
    const hourlyReturn = netUsd / hoursSpent;
    const strategy = input.strategy ?? input.category;

    const row = await db.earning.create({
      data: {
        opportunityId: input.opportunityId || undefined,
        source: input.source,
        category: input.category,
        grossUsd,
        feesUsd,
        expensesUsd,
        netUsd,
        hoursSpent,
        hourlyReturn,
        currency: input.currency || "USDC",
        verified: true,
        expected: false,
        transactionHash: input.transactionHash,
        chain: input.chain,
        strategy,
      },
    });

    // Increment the matching strategy stat so the learning subsystem has
    // fresh data on the next cycle.
    if (strategy) {
      await recordStrategyOutcome(strategy, {
        attempted: true,
        completed: netUsd > 0,
        failed: netUsd <= 0,
        netUsd,
        hoursSpent,
      });
    }

    await logEvent(
      "economics",
      "info",
      "verified_earning_recorded",
      {
        earningId: row.id,
        opportunityId: input.opportunityId,
        source: input.source,
        category: input.category,
        grossUsd,
        netUsd,
        hoursSpent,
        hourlyReturn,
        transactionHash: input.transactionHash,
        chain: input.chain,
        strategy,
      },
      input.opportunityId ? { opportunityId: input.opportunityId } : undefined
    );

    return rowToLedgerEntry(row);
  } catch (err) {
    console.error("[ledger] recordVerifiedEarning failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// convertExpectedToVerified
// ---------------------------------------------------------------------------

/**
 * Upgrade a previously-recorded *expected* earning to *verified* (spec §14).
 *
 * Called when an on-chain payment is matched to a previously-recorded
 * expected earning. The expected row is mutated in place — its `grossUsd`
 * / `feesUsd` / `expensesUsd` / `hoursSpent` are overwritten with the real
 * on-chain figures (if provided), `netUsd` and `hourlyReturn` are
 * recomputed, and the `verified` / `expected` flags are flipped.
 *
 * The relevant `StrategyStat` row is incremented as a verified outcome so
 * the learning subsystem picks up the result on the next cycle.
 *
 * @param opportunityId  the opportunity whose expected earning should be upgraded
 * @param paymentDetails the on-chain payment details (tx hash + real amounts)
 * @returns the upgraded {@link LedgerEntry}, or `null` if no expected earning
 *          was found for the given opportunity id.
 */
export async function convertExpectedToVerified(
  opportunityId: string,
  paymentDetails: ConvertExpectedInput
): Promise<LedgerEntry | null> {
  try {
    const expected = await db.earning.findFirst({
      where: { opportunityId, expected: true, verified: false },
      orderBy: { createdAt: "desc" },
    });
    if (!expected) {
      console.warn(
        `[ledger] convertExpectedToVerified: no expected earning found for opportunity ${opportunityId}`
      );
      return null;
    }

    // Use the payment-details value if provided, else fall back to the
    // expected row's existing value.
    const grossUsd =
      paymentDetails.grossUsd !== undefined
        ? finiteOr(paymentDetails.grossUsd, 0)
        : finiteOr(expected.grossUsd, 0);
    const feesUsd =
      paymentDetails.feesUsd !== undefined
        ? finiteOr(paymentDetails.feesUsd, 0)
        : finiteOr(expected.feesUsd, 0);
    const expensesUsd =
      paymentDetails.expensesUsd !== undefined
        ? finiteOr(paymentDetails.expensesUsd, 0)
        : finiteOr(expected.expensesUsd, 0);
    const hoursSpent =
      paymentDetails.hoursSpent !== undefined
        ? Math.max(finiteOr(paymentDetails.hoursSpent, 0.5), 0.5)
        : Math.max(finiteOr(expected.hoursSpent, 0.5), 0.5);

    const netUsd = Math.max(0, grossUsd - feesUsd - expensesUsd);
    const hourlyReturn = netUsd / hoursSpent;

    const updated = await db.earning.update({
      where: { id: expected.id },
      data: {
        grossUsd,
        feesUsd,
        expensesUsd,
        netUsd,
        hoursSpent,
        hourlyReturn,
        verified: true,
        expected: false,
        transactionHash: paymentDetails.transactionHash,
        chain: paymentDetails.chain ?? expected.chain,
      },
    });

    // Increment the matching strategy stat (now that we have a verified outcome).
    if (expected.strategy) {
      await recordStrategyOutcome(expected.strategy, {
        attempted: true,
        completed: netUsd > 0,
        failed: netUsd <= 0,
        netUsd,
        hoursSpent,
      });
    }

    await logEvent(
      "economics",
      "info",
      "expected_earning_converted_to_verified",
      {
        earningId: expected.id,
        opportunityId,
        grossUsd,
        netUsd,
        hourlyReturn,
        transactionHash: paymentDetails.transactionHash,
        chain: paymentDetails.chain,
      },
      { opportunityId }
    );

    return rowToLedgerEntry(updated);
  } catch (err) {
    console.error("[ledger] convertExpectedToVerified failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToLedgerEntry(row: {
  id: string;
  opportunityId: string | null;
  source: string;
  category: string;
  grossUsd: number;
  feesUsd: number;
  expensesUsd: number;
  netUsd: number;
  hoursSpent: number;
  hourlyReturn: number;
  currency: string;
  verified: boolean;
  expected: boolean;
  transactionHash: string | null;
  chain: string | null;
  strategy: string | null;
  createdAt: Date;
}): LedgerEntry {
  return {
    id: row.id,
    opportunityId: row.opportunityId ?? undefined,
    source: row.source,
    category: row.category,
    grossUsd: row.grossUsd,
    feesUsd: row.feesUsd,
    expensesUsd: row.expensesUsd,
    netUsd: row.netUsd,
    hoursSpent: row.hoursSpent,
    hourlyReturn: row.hourlyReturn,
    currency: row.currency,
    verified: row.verified,
    expected: row.expected,
    transactionHash: row.transactionHash ?? undefined,
    chain: row.chain ?? undefined,
    strategy: row.strategy ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

function finiteOr(n: number | null | undefined, fallback: number): number {
  if (n === null || n === undefined || !Number.isFinite(n)) return fallback;
  return n;
}
