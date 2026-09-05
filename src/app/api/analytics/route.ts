// GET /api/analytics
//
// Unified analytics payload for the dashboard's main overview screen. Pulls
// together everything the dashboard needs in ONE round-trip so the operator
// sees a fully-rendered page on first paint:
//
//   - totalVerifiedEarningsUsd, totalExpectedEarningsUsd
//   - opportunitiesDiscovered, opportunitiesAttempted, opportunitiesCompleted
//   - successRate, avgHourlyReturn, totalHoursSpent
//   - topStrategies   : top 5 by avgHourly
//   - topModels       : top 5 by earnings contribution
//   - recentEvents    : last 20 agent events
//   - budgetReport    : current daily/hourly budget usage
//   - walletSummary   : total USD + fetchedAt
//   - charts:
//       earningsOverTime        : last 14 days, by day, verified vs expected
//       opportunitiesByCategory : { category, count }[]
//       opportunitiesByStatus   : { status, count }[]

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { getTotals } from "@/lib/economics/ledger";
import { rankStrategies } from "@/lib/economics/strategy-stats";
import { getModels } from "@/lib/llm/registry";
import { getRecentEvents } from "@/lib/agent/events";
import { BudgetManager } from "@/lib/budget/manager";
import { getWalletSummary } from "@/lib/wallet/monitor";

export const dynamic = "force-dynamic";

const DAYS_WINDOW = 14;

export async function GET() {
  try {
    await bootstrapAgent();

    // Run all the independent reads in parallel so the endpoint is fast
    // even on a cold cache.
    const [
      totals,
      strategies,
      models,
      recentEvents,
      budgetReport,
      walletSummary,
      opportunitiesDiscovered,
      opportunitiesByStatus,
      opportunitiesByCategory,
      earningsLast14Days,
    ] = await Promise.all([
      getTotals(),
      rankStrategies(),
      getModels(),
      getRecentEvents(20),
      BudgetManager.getInstance().getReport(),
      getWalletSummary().catch(() => null),
      db.opportunity.count(),
      db.opportunity.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      db.opportunity.groupBy({
        by: ["category"],
        _count: { _all: true },
      }),
      buildEarningsOverTime(DAYS_WINDOW),
    ]);

    const topStrategies = strategies.slice(0, 5).map((s) => ({
      strategy: s.strategy,
      avgHourly: s.avgHourly,
      effectiveAvgHourly: s.effectiveAvgHourly,
      successRate: s.successRate,
      attempted: s.attempted,
      completed: s.completed,
      totalNetUsd: s.totalNetUsd,
    }));

    const topModels = [...models]
      .sort(
        (a, b) =>
          b.earnings_contribution_usd - a.earnings_contribution_usd
      )
      .slice(0, 5)
      .map((m) => ({
        model_id: m.model_id,
        provider: m.provider,
        role: m.role,
        status: m.status,
        enabled: m.enabled,
        earnings_contribution_usd: m.earnings_contribution_usd,
        success_rate: m.performance.success_rate,
        average_quality: m.performance.average_quality,
      }));

    const statusCounts = opportunitiesByStatus.map((row) => ({
      status: row.status,
      count: row._count._all,
    }));
    const categoryCounts = opportunitiesByCategory.map((row) => ({
      category: row.category,
      count: row._count._all,
    }));

    return NextResponse.json(
      {
        totalVerifiedEarningsUsd: totals.verifiedNetUsd,
        totalExpectedEarningsUsd: totals.expectedNetUsd,
        totalGrossUsd: totals.totalGrossUsd,
        opportunitiesDiscovered,
        opportunitiesAttempted: totals.opportunitiesAttempted,
        opportunitiesCompleted: totals.opportunitiesCompleted,
        successRate: totals.successRate,
        avgHourlyReturn: totals.avgHourlyReturn,
        totalHoursSpent: totals.totalHours,
        topStrategies,
        topModels,
        recentEvents,
        budgetReport,
        walletSummary: walletSummary
          ? {
              totalUsd: walletSummary.totalUsd,
              fetchedAt: walletSummary.fetchedAt,
              walletCount: walletSummary.wallets.length,
            }
          : null,
        charts: {
          earningsOverTime: earningsLast14Days,
          opportunitiesByCategory: categoryCounts,
          opportunitiesByStatus: statusCounts,
          earningsByCategory: Object.entries(totals.byCategory).map(
            ([category, v]) => ({ category, ...v })
          ),
          earningsBySource: Object.entries(totals.bySource).map(
            ([source, v]) => ({ source, ...v })
          ),
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/analytics GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface EarningsOverTimePoint {
  date: string;
  verifiedUsd: number;
  expectedUsd: number;
}

/**
 * Build a daily series of verified + expected earnings over the last N days.
 * Verified entries are summed by their `createdAt` day; expected entries by
 * the same. The aggregation runs in JS (not via Prisma groupBy) so we can
 * fill in days with zero earnings (otherwise the dashboard's chart would
 * skip them).
 */
async function buildEarningsOverTime(days: number): Promise<
  EarningsOverTimePoint[]
> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const since = new Date(today);
  since.setUTCDate(since.getUTCDate() - (days - 1));

  const buckets = new Map<string, EarningsOverTimePoint>();
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setUTCDate(since.getUTCDate() + i);
    buckets.set(dateKey(d), {
      date: dateKey(d),
      verifiedUsd: 0,
      expectedUsd: 0,
    });
  }

  try {
    const rows = await db.earning.findMany({
      where: { createdAt: { gte: since } },
      select: {
        netUsd: true,
        verified: true,
        expected: true,
        createdAt: true,
      },
    });

    for (const row of rows) {
      const key = dateKey(row.createdAt);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      if (row.verified) bucket.verifiedUsd += finiteOr(row.netUsd, 0);
      else if (row.expected) bucket.expectedUsd += finiteOr(row.netUsd, 0);
    }
  } catch (err) {
    console.error("[api/analytics] earningsOverTime failed:", err);
  }

  return Array.from(buckets.values()).map((b) => ({
    date: b.date,
    verifiedUsd: round2(b.verifiedUsd),
    expectedUsd: round2(b.expectedUsd),
  }));
}

function dateKey(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function finiteOr(
  n: number | null | undefined,
  fallback: number
): number {
  if (n === null || n === undefined || !Number.isFinite(n)) return fallback;
  return n;
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
