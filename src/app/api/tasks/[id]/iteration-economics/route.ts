// GET /api/tasks/[id]/iteration-economics
//
// Compute whether another iteration on this Task is economically worth doing
// (Phase 3 §10). Returns expected_value_before, expected_value_after,
// incremental_expected_value, additional_time, incremental_hourly_return,
// and a recommendation: "worth_it" | "marginal" | "not_worth_it".

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { getIterationEconomics } from "@/lib/iteration/iteration-service";

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
        { error: "Missing task id." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const result = await getIterationEconomics(id);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "getIterationEconomics failed" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      { economics: result.data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/tasks/[id]/iteration-economics GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
