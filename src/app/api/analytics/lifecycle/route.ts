// GET /api/analytics/lifecycle?trueAverage=true
//
// Lifecycle analytics payload for the dashboard's Lifecycle tab
// (Phase-3 STYLING-1). Lists every opportunity status along with:
//   - count           : how many opportunities are currently in that status
//   - oldestUpdatedAt : the ISO timestamp of the oldest opportunity's
//                       `updatedAt` in that status — used by the Lifecycle
//                       tab to detect "stuck" opportunities (non-terminal
//                       statuses whose oldest opportunity is > 24h old).
//   - avgHoursInStatus: average number of hours the current opportunities in
//                       this status have been sitting here.
//   - maxHoursInStatus: the worst-case (oldest) opportunity's hours in status.
//
// Phase-3 dev-review #3 (priority #4): when `?trueAverage=true` is passed,
// the avgHoursInStatus is computed as the TRUE arithmetic mean of every
// opportunity's age in that status (fetches every row's updatedAt + averages).
// Without the flag, avgHoursInStatus is a midpoint approximation between
// the oldest + newest (faster, but can be misleading when the distribution
// is skewed). The true-average is opt-in because it's O(n) per status
// instead of O(1) — expensive when a status has thousands of opportunities.
//
// Returns:
//   { statuses: [{ status, count, oldestUpdatedAt, avgHoursInStatus, maxHoursInStatus }] }
//
// The list only includes statuses that currently have ≥ 1 opportunity.
// Empty statuses are omitted so the front-end can render a clean
// flowchart (the Lifecycle tab backfills the empty nodes client-side so
// the 14-status flowchart always shows every node, even with zero data).
//
// Marked `force-dynamic` + `Cache-Control: no-store` so the response is
// always fresh — the operator needs up-to-the-second stuck detection.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await bootstrapAgent();

    const url = new URL(req.url);
    const trueAverage = url.searchParams.get("trueAverage") === "true";

    // Group by status, count rows + take the min/max of updatedAt.
    const rows = await db.opportunity.groupBy({
      by: ["status"],
      _count: { _all: true },
      _min: { updatedAt: true },
      _max: { updatedAt: true },
    });

    // Phase-3 dev-review #3 (priority #4): when trueAverage=true, fetch
    // every opportunity's updatedAt per status + compute the arithmetic
    // mean. This is O(n) per status — expensive for large tables, so it's
    // opt-in. Without the flag, avgHoursInStatus is the midpoint
    // approximation (oldest + newest / 2) which is O(1) per status.
    let trueAverageByStatus: Map<string, number> | null = null;
    if (trueAverage) {
      trueAverageByStatus = new Map();
      const allOpps = await db.opportunity.findMany({
        select: { status: true, updatedAt: true },
      });
      const byStatus = new Map<string, number[]>();
      const nowMs = Date.now();
      for (const opp of allOpps) {
        const ts = opp.updatedAt instanceof Date ? opp.updatedAt.getTime() : null;
        if (ts == null || !Number.isFinite(ts)) continue;
        const hours = Math.max(0, (nowMs - ts) / (1000 * 60 * 60));
        const arr = byStatus.get(opp.status) ?? [];
        arr.push(hours);
        byStatus.set(opp.status, arr);
      }
      for (const [status, hoursArr] of byStatus) {
        if (hoursArr.length === 0) continue;
        const sum = hoursArr.reduce((a, b) => a + b, 0);
        trueAverageByStatus.set(
          status,
          Math.round((sum / hoursArr.length) * 10) / 10
        );
      }
    }

    const nowMs = Date.now();
    const statuses = rows.map((row) => {
      const oldestDate = row._min.updatedAt;
      const newestDate = row._max.updatedAt;
      const oldestMs = oldestDate instanceof Date ? oldestDate.getTime() : null;
      const newestMs = newestDate instanceof Date ? newestDate.getTime() : null;
      const maxHoursInStatus =
        oldestMs != null && Number.isFinite(oldestMs)
          ? Math.max(0, (nowMs - oldestMs) / (1000 * 60 * 60))
          : 0;
      // Use the true average if requested + available; otherwise the midpoint.
      const avgHoursInStatus =
        trueAverageByStatus?.get(row.status) ??
        (oldestMs != null && newestMs != null
          ? Math.max(0, (nowMs - (oldestMs + newestMs) / 2) / (1000 * 60 * 60))
          : 0);
      return {
        status: row.status,
        count: row._count._all,
        oldestUpdatedAt:
          oldestDate instanceof Date ? oldestDate.toISOString() : oldestDate,
        avgHoursInStatus: Math.round(avgHoursInStatus * 10) / 10,
        maxHoursInStatus: Math.round(maxHoursInStatus * 10) / 10,
      };
    });

    // Sort by status alphabetically so the response is stable across
    // calls — the front-end's FLOW_ROWS ordering is independent.
    statuses.sort((a, b) => a.status.localeCompare(b.status));

    return NextResponse.json(
      { statuses, trueAverage },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/analytics/lifecycle GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
