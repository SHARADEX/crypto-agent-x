// GET /api/tasks/[id]
//
// Return a single Task by id, including its related opportunity (if any) and
// its recent events (so the dashboard can render the task-detail timeline).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";

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

    const task = await db.task.findUnique({
      where: { id },
      include: {
        opportunity: {
          select: {
            id: true,
            title: true,
            category: true,
            source: true,
            rewardUsd: true,
            status: true,
          },
        },
        events: {
          orderBy: { createdAt: "desc" },
          take: 100,
        },
      },
    });

    if (!task) {
      return NextResponse.json(
        { error: `Task ${id} not found.` },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      { task },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/tasks/[id] GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
