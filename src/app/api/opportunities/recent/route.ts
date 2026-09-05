// GET /api/opportunities/recent?limit=5&terminal=true
//
// Fetch recently-updated opportunities in one query (Phase-3 DEV-REVIEW-10,
// priority #2). Replaces the 3 separate queries the Recently Completed
// carousel was making (status=paid, status=failed, status=rejected).
//
// Query params:
//   - limit   : max rows (default 5, hard-cap 50)
//   - terminal: when "true", filters to only terminal-state statuses
//               (paid, failed, rejected). When omitted, returns all statuses
//               sorted by updatedAt DESC (useful for "recently active").
//
// Response: { opportunities: Opportunity[], count: number }
//
// Marked `force-dynamic` + `Cache-Control: no-store` for fresh data.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { serializeOpportunity } from "@/lib/agent/serialize";

export const dynamic = "force-dynamic";

const TERMINAL_STATUSES = ["paid", "failed", "rejected"];

export async function GET(req: Request) {
  try {
    await bootstrapAgent();

    const url = new URL(req.url);
    const terminal = url.searchParams.get("terminal") === "true";
    const limitParam = Number(url.searchParams.get("limit") ?? 5);
    const limit = Math.max(1, Math.min(Math.trunc(limitParam), 50));

    const where = terminal
      ? { status: { in: TERMINAL_STATUSES } }
      : {};

    const opportunities = await db.opportunity.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: limit,
      // Full row (not a partial select) — v0.4.2: serializeOpportunity
      // emits the canonical shape (nested reward + parsed arrays) that every
      // other /api/opportunities* endpoint returns.
    });

    return NextResponse.json(
      {
        opportunities: opportunities.map(serializeOpportunity),
        count: opportunities.length,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/opportunities/recent GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
