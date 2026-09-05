// GET /api/tasks/[id]/iterations
//
// List all TaskIteration rows for a given Task, ordered by iterationNumber
// ascending (v0 first). Used by the dashboard's task-detail dialog to
// render the version history (Phase 3 §7, §8, §9).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { getIterations } from "@/lib/iteration/iteration-service";

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

    const exists = await db.task.findUnique({
      where: { id },
      select: { id: true, iterationCount: true, maxIterations: true, currentIterationId: true },
    });
    if (!exists) {
      return NextResponse.json(
        { error: `Task ${id} not found.` },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    const result = await getIterations(id);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "getIterations failed" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      {
        iterations: result.data ?? [],
        count: (result.data ?? []).length,
        iterationCount: exists.iterationCount,
        maxIterations: exists.maxIterations,
        currentIterationId: exists.currentIterationId,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/tasks/[id]/iterations GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
