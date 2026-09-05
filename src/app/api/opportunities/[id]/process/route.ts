// POST /api/opportunities/[id]/process
//
// Run the orchestrator's `processOpportunity(id)` against this opportunity.
// The orchestrator walks the opportunity through its lifecycle (research →
// verification → economics → planning → execution → review → payment) and
// returns a `ProcessOpportunityResult` summarising every step.
//
// This is the manual "advance this opportunity now" endpoint. The autonomous
// loop calls the same function via `runCycle()`.

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { processOpportunity } from "@/lib/orchestrator/orchestrator";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_req: Request, { params }: RouteParams) {
  try {
    await bootstrapAgent();

    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { error: "Missing opportunity id." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const result = await processOpportunity(id);
    return NextResponse.json(
      { result },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/opportunities/[id]/process] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
