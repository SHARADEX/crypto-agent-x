// GET /api/opportunities
//
// List opportunities with optional filters + sort. Always returns:
//   { opportunities: Opportunity[], count: number, total: number }
//
// Query params:
//   - status   : filter by status (e.g. "discovered", "verified", "queued", ...)
//   - category : filter by category (e.g. "github_bounty", "hackathon", ...)
//   - source   : filter by source (e.g. "github_issues", "mock_bounties")
//   - watched  : "true" → only starred (watchlist); "false" → only unstarred
//   - limit    : max rows to return (default 50, hard-cap 200)
//   - offset   : pagination offset (default 0)
//   - sort     : "score" (default, riskAdjustedHourly DESC)
//                | "reward" (rewardUsd DESC)
//                | "newest" (createdAt DESC)
//                | "deadline" (deadline ASC, nulls LAST — v0.4.2 fix)
//                | "watched" (watchedAt DESC — watchlist recency)
//   - deadlineWithin: "<days>" → only opportunities with a deadline within
//                the next N days (incl. already-overdue ones), deadline ASC.
//                Powers the briefing "Closing soon" + tab ⏰ chip.
//
// The `count` field is the length of the returned slice; `total` is the
// unfiltered total in the DB so the dashboard can render pagination.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { serializeOpportunity } from "@/lib/agent/serialize";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 200;

export async function GET(req: Request) {
  try {
    await bootstrapAgent();

    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? undefined;
    const category = url.searchParams.get("category") ?? undefined;
    const source = url.searchParams.get("source") ?? undefined;
    const sort = url.searchParams.get("sort") ?? "score";
    // v0.4.2: deadline-urgency filter — "<days>" keeps only rows whose
    // deadline exists + falls within now..now+N days (overdue included).
    const deadlineWithinParam = url.searchParams.get("deadlineWithin");
    const deadlineWithinDays =
      deadlineWithinParam && Number.isFinite(Number(deadlineWithinParam))
        ? Math.max(0, Math.min(365, Number(deadlineWithinParam)))
        : undefined;
    // v0.4.1: watchlist filter — "true" returns only starred opportunities.
    const watchedParam = url.searchParams.get("watched");
    const watched =
      watchedParam === "true"
        ? true
        : watchedParam === "false"
        ? false
        : undefined;

    const limitParam = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(Math.trunc(limitParam), MAX_LIMIT))
      : 50;
    const offsetParam = Number(url.searchParams.get("offset") ?? 0);
    const offset = Number.isFinite(offsetParam)
      ? Math.max(0, Math.trunc(offsetParam))
      : 0;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (category) where.category = category;
    if (source) where.source = source;
    if (watched !== undefined) where.watched = watched;
    if (deadlineWithinDays !== undefined) {
      where.deadline = {
        not: null,
        lte: new Date(Date.now() + deadlineWithinDays * 24 * 60 * 60 * 1000),
      };
    }

    let orderBy: Record<string, unknown> = { riskAdjustedHourly: "desc" };
    if (sort === "reward") {
      orderBy = { rewardUsd: "desc" };
    } else if (sort === "newest") {
      orderBy = { createdAt: "desc" };
    } else if (sort === "deadline") {
      // v0.4.2 fix: Prisma supports { nulls: 'last' } on SQLite — no more
      // null-deadline rows drowning out the urgent ones.
      orderBy = { deadline: { sort: "asc", nulls: "last" } };
    } else if (sort === "watched") {
      // Starred first (most recently starred on top), then by score.
      orderBy = { watchedAt: { sort: "desc", nulls: "last" } };
    }
    // deadlineWithin implies urgency ordering.
    if (deadlineWithinDays !== undefined) {
      orderBy = { deadline: "asc" };
    }

    const [rows, total, filteredTotal] = await Promise.all([
      db.opportunity.findMany({
        where: where as never,
        orderBy: orderBy as never,
        take: limit,
        skip: offset,
      }),
      db.opportunity.count(),
      db.opportunity.count({ where: where as never }),
    ]);

    return NextResponse.json(
      {
        opportunities: rows.map(rowToOpportunity),
        count: rows.length,
        total,
        filteredTotal,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/opportunities] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Serialization lives in the shared module so the LIST and DETAIL endpoints
// emit the identical canonical shape (v0.4.1 normalization).
function rowToOpportunity(row: Parameters<typeof serializeOpportunity>[0]) {
  return serializeOpportunity(row);
}

