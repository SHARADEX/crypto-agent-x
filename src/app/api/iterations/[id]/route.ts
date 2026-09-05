// GET /api/iterations/[id]
//
// Return a single TaskIteration row by id. Used by the dashboard's iteration
// viewer dialog (Phase 3 §7, §8, §9).

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { getIterationById } from "@/lib/iteration/iteration-service";

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

    const result = await getIterationById(id);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "getIterationById failed" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (!result.data) {
      return NextResponse.json(
        { error: `Iteration ${id} not found.` },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      { iteration: result.data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/iterations/[id] GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
