// GET /api/iterations/[id]/quality-gate
//
// Run the four-check quality gate (Phase 3 §12) on an iteration's artifact:
//   1. functionality_check — tests pass?
//   2. security_check     — safety.safe === true AND riskScore low
//   3. requirements_check — deliverable matches opportunity requirements
//   4. economic_check     — expectedValue > 0 OR valueAdded > 0
//
// Returns { checks: [...], overall: "pass" | "warn" | "fail" }.

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { getQualityGate } from "@/lib/iteration/iteration-service";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    await bootstrapAgent();

    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { error: "Missing iteration id." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const result = await getQualityGate(id);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "getQualityGate failed" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      { qualityGate: result.data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/iterations/[id]/quality-gate GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
