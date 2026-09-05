// GET /api/strategies
//
// Return the ranked strategy stats. Uses `rankStrategies()` so each row
// carries both the raw `avgHourly` and the exploration-boosted
// `effectiveAvgHourly` (the latter is what the strategy selector uses).

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { rankStrategies } from "@/lib/economics/strategy-stats";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await bootstrapAgent();

    const strategies = await rankStrategies();
    return NextResponse.json(
      { strategies, count: strategies.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/strategies GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
