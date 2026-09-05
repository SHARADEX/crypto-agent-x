// POST /api/opportunities/seed
//
// Force a fresh discovery pass — bypasses the 10-minute throttle the
// autonomous loop applies. Useful for the operator "refresh opportunities"
// button on the dashboard.
//
// Returns the DiscoverySummary.

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { runDiscoveryCycle } from "@/lib/agent/scanners";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await bootstrapAgent();

    const summary = await runDiscoveryCycle();
    return NextResponse.json(
      { summary },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/opportunities/seed] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
