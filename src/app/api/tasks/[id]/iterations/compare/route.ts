// GET /api/tasks/[id]/iterations/compare?versionA=v0&versionB=v1&includeLineDiffs=true
//
// Return a diff/summary of what changed between two iterations of a Task
// (Phase 3 §7). Returns filesAdded, filesRemoved, filesChanged,
// qualityDelta, testResultsDelta, safetyDelta, notes.
//
// Phase-3 dev-review #2: when `includeLineDiffs=true` is passed as a query
// param, the response also includes `fileDiffs` — a per-file line-level
// diff (added/removed/context hunks) that the dashboard renders as a
// syntax-highlighted diff view. Without the flag, the response is the
// lightweight summary (counts + deltas only) for the default Compare dialog.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { compareIterations } from "@/lib/iteration/iteration-service";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    await bootstrapAgent();

    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { error: "Missing task id." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const url = new URL(req.url);
    const versionA = url.searchParams.get("versionA") ?? "";
    const versionB = url.searchParams.get("versionB") ?? "";
    if (!versionA || !versionB) {
      return NextResponse.json(
        { error: "Both versionA and versionB query params are required." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }
    const includeLineDiffs = url.searchParams.get("includeLineDiffs") === "true";

    const exists = await db.task.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      return NextResponse.json(
        { error: `Task ${id} not found.` },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    const result = await compareIterations(id, versionA, versionB, {
      includeLineDiffs,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "compareIterations failed" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      { comparison: result.data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/tasks/[id]/iterations/compare GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
