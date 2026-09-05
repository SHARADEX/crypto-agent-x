// GET /api/export/events?format=csv|json&level=&agent=&limit=
//
// Export the AgentEvent log as CSV or JSON for offline analysis
// (Phase-3 DEV-REVIEW-4, priority #4).
//
// Operators often want to audit the event log externally — this endpoint
// returns the filtered set (no pagination) so the operator can grep /
// chart / archive it.
//
// Query params:
//   - format: "csv" (default) | "json"
//   - level  : filter by level (e.g. "error", "warn", "info")
//   - agent  : filter by agent (e.g. "orchestrator", "model_router")
//   - limit  : max rows (default 5000, hard-cap 10_000)
//
// CSV format: header row + one event per row, comma-separated, double-quoted.
// JSON format: bare array of event objects.
//
// Content-Disposition is set to "attachment" so the browser downloads
// the file rather than rendering it inline.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 10_000;

function csvEscape(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function toCSV(
  rows: Record<string, unknown>[],
  columns: Array<{ key: string; label: string }>
): string {
  const header = columns.map((c) => csvEscape(c.label)).join(",");
  const body = rows
    .map((row) => columns.map((c) => csvEscape(row[c.key])).join(","))
    .join("\n");
  return `${header}\n${body}`;
}

function dateStamp(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export async function GET(req: Request) {
  try {
    await bootstrapAgent();

    const url = new URL(req.url);
    const format = (url.searchParams.get("format") ?? "csv").toLowerCase();
    const level = url.searchParams.get("level") ?? undefined;
    const agent = url.searchParams.get("agent") ?? undefined;
    const limitParam = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(Math.trunc(limitParam), MAX_LIMIT))
      : DEFAULT_LIMIT;

    const where: Record<string, unknown> = {};
    if (level) where.level = level;
    if (agent) where.agent = agent;

    const rows = await db.agentEvent.findMany({
      where: where as never,
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        taskId: true,
        opportunityId: true,
        agent: true,
        level: true,
        event: true,
        payload: true,
        createdAt: true,
      },
    });

    const serializable = rows.map((r) => ({
      ...r,
      createdAt:
        r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    }));

    const filename = `events-${dateStamp()}`;

    if (format === "json") {
      return NextResponse.json(
        { events: serializable, count: serializable.length },
        {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}.json"`,
            "Cache-Control": "no-store",
          },
        }
      );
    }

    const columns = [
      { key: "id", label: "id" },
      { key: "createdAt", label: "createdAt" },
      { key: "agent", label: "agent" },
      { key: "level", label: "level" },
      { key: "event", label: "event" },
      { key: "taskId", label: "taskId" },
      { key: "opportunityId", label: "opportunityId" },
      { key: "payload", label: "payload" },
    ];
    const csv = toCSV(serializable as Record<string, unknown>[], columns);

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[api/export/events GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
