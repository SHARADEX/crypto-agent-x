// POST /api/iterations/[id]/restore
//
// Restore a previous iteration as the current one (Phase 3 §7, §9). This
// re-creates a NEW iteration on the same Task with the artifact + feedback
// metadata from the requested historical iteration, so the audit trail
// stays append-only. The prior "current" iteration is marked superseded.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { logEvent } from "@/lib/agent/events";
import {
  createIteration,
  getIterationById,
  markIterationSuperseded,
} from "@/lib/iteration/iteration-service";

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
        { error: "Missing iteration id." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const existing = await getIterationById(id);
    if (!existing.ok || !existing.data) {
      return NextResponse.json(
        { error: existing.error ?? `Iteration ${id} not found.` },
        {
          status: 404,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }
    const source = existing.data;

    const task = await db.task.findUnique({
      where: { id: source.taskId },
      select: {
        id: true,
        currentIterationId: true,
        opportunityId: true,
        iterationCount: true,
        maxIterations: true,
      },
    });
    if (!task) {
      return NextResponse.json(
        { error: `Task ${source.taskId} not found.` },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Don't allow restoring if the requested iteration IS the current one.
    if (task.currentIterationId === source.id) {
      return NextResponse.json(
        { error: "Iteration is already the current one." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Mark the current iteration as superseded (if it isn't the source).
    if (task.currentIterationId && task.currentIterationId !== source.id) {
      await markIterationSuperseded(task.currentIterationId);
    }

    const restored = await createIteration({
      taskId: task.id,
      feedbackText: `(restored from ${source.version})`,
      feedbackType: "other",
      feedbackPriority: "low",
      artifact: safeParseArtifact(source.artifactJson) as never,
    });
    if (!restored.ok || !restored.data) {
      return NextResponse.json(
        { error: restored.error ?? "createIteration failed" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    await logEvent(
      "orchestrator",
      "info",
      "iteration_restored",
      {
        taskId: task.id,
        opportunityId: task.opportunityId ?? null,
        restoredFromIterationId: source.id,
        restoredFromVersion: source.version,
        newIterationId: restored.data.id,
        newVersion: restored.data.version,
      },
      task.opportunityId
        ? { opportunityId: task.opportunityId, taskId: task.id }
        : { taskId: task.id }
    );

    return NextResponse.json(
      { iteration: restored.data, restoredFrom: source.id, restoredFromVersion: source.version },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/iterations/[id]/restore POST] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

function safeParseArtifact(
  json: string
): {
  approach: string;
  files: Array<{
    path: string;
    language: string;
    content: string;
    safety?: unknown;
  }>;
  tests: Array<{ path: string; framework: string; content: string }>;
  diff?: string;
  safety?: unknown;
  testsPassed?: boolean;
  testResults?: unknown;
  model?: string;
} {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as {
        approach: string;
        files: Array<{
          path: string;
          language: string;
          content: string;
          safety?: unknown;
        }>;
        tests: Array<{ path: string; framework: string; content: string }>;
        diff?: string;
        safety?: unknown;
        testsPassed?: boolean;
        testResults?: unknown;
        model?: string;
      };
    }
  } catch {
    // ignore
  }
  return { approach: "", files: [], tests: [] };
}
