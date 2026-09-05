// GET /api/public/status — a public, read-only summary safe to share with
// anyone (Phase-2 P3-4). Contains NO secrets, NO wallet private keys, NO
// internal API keys — only the headline metrics + opportunity counts.
//
// This endpoint is ALWAYS allowed (even in read-only mode) and is the one
// the operator shares via a public dashboard link.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await bootstrapAgent();

    const [
      agentState,
      opportunityCounts,
      ledgerTotals,
      strategyStats,
      modelCount,
      providerCount,
      recentEvents,
    ] = await Promise.all([
      db.agentState.findUnique({
        where: { id: "singleton" },
        select: {
          running: true,
          paused: true,
          emergencyStop: true,
          autonomyMode: true,
          lastCycleAt: true,
          lastCycleResult: true,
          cycleCount: true,
        },
      }),
      db.opportunity.groupBy({
        by: ["status"],
        _count: true,
      }),
      db.earning.aggregate({
        _sum: { netUsd: true, grossUsd: true },
        _count: true,
        where: { verified: true },
      }),
      db.strategyStat.findMany({
        orderBy: { totalNetUsd: "desc" },
        take: 5,
        select: {
          strategy: true,
          attempted: true,
          completed: true,
          totalNetUsd: true,
          avgHourly: true,
          successRate: true,
        },
      }),
      db.modelRecord.count({ where: { enabled: true } }),
      db.modelRecord.groupBy({
        by: ["provider"],
        _count: true,
      }),
      db.agentEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          agent: true,
          level: true,
          event: true,
          createdAt: true,
        },
      }),
    ]);

    const statusCounts: Record<string, number> = {};
    for (const s of opportunityCounts) {
      statusCounts[s.status] = s._count;
    }

    const providerCounts: Record<string, number> = {};
    for (const p of providerCount) {
      providerCounts[p.provider] = p._count;
    }

    return NextResponse.json(
      {
        agent: agentState
          ? {
              running: agentState.running,
              paused: agentState.paused,
              emergencyStop: agentState.emergencyStop,
              autonomyMode: agentState.autonomyMode,
              lastCycleAt: agentState.lastCycleAt,
              lastCycleResult: agentState.lastCycleResult,
              cycleCount: agentState.cycleCount,
            }
          : null,
        earnings: {
          verifiedNetUsd: ledgerTotals._sum.netUsd ?? 0,
          verifiedGrossUsd: ledgerTotals._sum.grossUsd ?? 0,
          verifiedCount: ledgerTotals._count,
        },
        opportunities: {
          byStatus: statusCounts,
          total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
        },
        topStrategies: strategyStats,
        models: {
          enabledCount: modelCount,
          byProvider: providerCounts,
        },
        recentEvents,
        publicReadOnly: process.env.PUBLIC_READ_ONLY === "true",
        generatedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
