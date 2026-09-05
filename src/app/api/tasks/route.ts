// GET /api/tasks
//
// List recent Tasks. Each row carries the related opportunity id so the
// dashboard can cross-link. Query params:
//   - status : "pending" | "running" | "success" | "failed" | "skipped" | "cancelled"
//   - limit  : default 50, hard-cap 200

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 200;

const VALID_STATUSES = new Set([
  "pending",
  "running",
  "success",
  "failed",
  "skipped",
  "cancelled",
]);

export async function GET(req: Request) {
  try {
    await bootstrapAgent();

    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam && VALID_STATUSES.has(statusParam) ? statusParam : undefined;

    const limitParam = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(Math.trunc(limitParam), MAX_LIMIT))
      : 50;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;

    const rows = await db.task.findMany({
      where: where as never,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return NextResponse.json(
      { tasks: rows, count: rows.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/tasks GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
