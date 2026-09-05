// POST /api/analytics/lifecycle/snapshot
//
// Write a lifecycle snapshot — a point-in-time record of how many
// opportunities are in each status + their avg/max hours in status
// (Phase-3 dev-review #3, priority #5).
//
// The snapshot is idempotent per hourly bucket: if a snapshot for the
// current hour already exists for a given status, it's updated in place
// rather than duplicated. This means the snapshot can be called multiple
// times per hour (e.g. by the orchestrator loop + a cron) without
// polluting the historical record.
//
// The dashboard's Lifecycle tab renders a 7-day trend chart from these
// snapshots so the operator can see whether bottlenecks are improving or
// worsening over time.
//
// Phase-3 DEV-REVIEW-4: the snapshot logic is now in
// src/lib/analytics/lifecycle-snapshot.ts (recordLifecycleSnapshot) so
// the orchestrator loop can call it directly without an HTTP round-trip.
// This route is a thin wrapper for manual / cron use.
//
// Body: none (the snapshot is computed from the current DB state).
// Response: { bucket, statuses: [{ status, count, avg, max }] }

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { recordLifecycleSnapshot } from "@/lib/analytics/lifecycle-snapshot";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await bootstrapAgent();
    const result = await recordLifecycleSnapshot();
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[api/analytics/lifecycle/snapshot POST] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// GET /api/analytics/lifecycle/snapshot?days=7
//
// Return the historical lifecycle snapshots for the last N days (default 7).
// Used by the dashboard's Lifecycle tab to render a trend chart.
//
// Response: { snapshots: [{ bucket, status, count, avgHoursInStatus, maxHoursInStatus }] }

export async function GET(req: Request) {
  try {
    await bootstrapAgent();

    const url = new URL(req.url);
    const days = Math.min(
      90,
      Math.max(1, Number(url.searchParams.get("days") ?? "7"))
    );
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const snapshots = await db.lifecycleSnapshot.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: {
        bucket: true,
        status: true,
        count: true,
        avgHoursInStatus: true,
        maxHoursInStatus: true,
        trueAvgHoursInStatus: true,
        createdAt: true,
      },
    });

    return NextResponse.json(
      {
        snapshots,
        count: snapshots.length,
        days,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/analytics/lifecycle/snapshot GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
