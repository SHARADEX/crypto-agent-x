// GET /api/events
//
// List recent AgentEvents. Query params:
//   - limit : default 100, hard-cap 500
//   - level : "debug" | "info" | "warn" | "error" | "critical"
//   - agent : agent name (e.g. "orchestrator", "research", "payment", ...)
//   - opportunityId : filter by opportunity id

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 500;

const VALID_LEVELS = new Set([
  "debug",
  "info",
  "warn",
  "error",
  "critical",
]);

export async function GET(req: Request) {
  try {
    await bootstrapAgent();

    const url = new URL(req.url);
    const levelParam = url.searchParams.get("level");
    const level =
      levelParam && VALID_LEVELS.has(levelParam) ? levelParam : undefined;
    const agent = url.searchParams.get("agent") ?? undefined;
    const opportunityId = url.searchParams.get("opportunityId") ?? undefined;

    const limitParam = Number(url.searchParams.get("limit") ?? 100);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(Math.trunc(limitParam), MAX_LIMIT))
      : 100;

    const where: Record<string, unknown> = {};
    if (level) where.level = level;
    if (agent) where.agent = agent;
    if (opportunityId) where.opportunityId = opportunityId;

    const rows = await db.agentEvent.findMany({
      where: where as never,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const parsed = rows.map((row) => ({
      ...row,
      payload: safeParseJson(row.payload),
      createdAt: row.createdAt.toISOString(),
    }));

    return NextResponse.json(
      { events: parsed, count: parsed.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/events GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

function safeParseJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : { value: v };
  } catch {
    return { raw };
  }
}
