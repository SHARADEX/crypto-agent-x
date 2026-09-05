// GET /api/strategies/change-log
//
// Return the history of strategy allocation changes (Phase 3 §23). Each row
// captures: which family changed, the previous + new target %, the reason
// (human-readable), who triggered it (adaptive_rebalancer | operator |
// auto_optimize | limit_override | toggle), and the timestamp.
//
// Used by the Strategies dashboard's "Allocation Change Log" panel — a
// scrollable list of past rebalance decisions with timestamps + reasons.

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { getAllocationChangeLog } from "@/lib/economics/strategy-allocator";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 500;

export async function GET(req: Request) {
  try {
    await bootstrapAgent();

    const url = new URL(req.url);
    const limitParam = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(Math.trunc(limitParam), MAX_LIMIT))
      : 50;

    const changeLog = await getAllocationChangeLog(limit);

    return NextResponse.json(
      { changeLog, count: changeLog.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/strategies/change-log GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
