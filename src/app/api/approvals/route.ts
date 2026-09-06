// GET /api/approvals
//
// List Approval rows. Query params:
//   - status : "pending" (default) | "approved" | "rejected" | "improve"
//              | "rework" | "request_changes" | "ask_agent" | "skip" | "pause"
//   - limit  : default 50, hard-cap 200
//
// Each row includes its related opportunity + task so the dashboard can
// render the approval queue in a single round-trip. Phase 3 §5: the
// approval card surfaces what the opportunity asked for, what the agent
// created (the latest iteration's artifact), the quality gate results,
// selected models + model confidence, and reviewer feedback.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 200;

const VALID_STATUSES = new Set([
  "pending",
  "approved",
  "rejected",
  "improve",
  "rework",
  "request_changes",
  "ask_agent",
  "skip",
  "pause",
]);

export async function GET(req: Request) {
  try {
    await bootstrapAgent();

    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status") ?? "pending";
    const status = VALID_STATUSES.has(statusParam) ? statusParam : "pending";

    const limitParam = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(Math.trunc(limitParam), MAX_LIMIT))
      : 50;

    const rows = await db.approval.findMany({
      where: { status } as never,
      include: {
        opportunity: {
          select: {
            id: true,
            title: true,
            description: true,
            category: true,
            source: true,
            requirements: true,
            rewardUsd: true,
            riskScore: true,
            expectedValue: true,
            riskAdjustedHourly: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    // v0.5.1 badge fix: `count` is the TOTAL number of rows matching the
    // status filter, NOT the page size. The dashboard badge queries with
    // `limit: 1` (bandwidth-cheap) and reads `count` — returning
    // `rows.length` made the sidebar badge show "1" forever while the real
    // queue had more. Separate count query; both values stay consistent.
    const total = await db.approval.count({
      where: { status } as never,
    });

    return NextResponse.json(
      { approvals: rows, count: total },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/approvals GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
