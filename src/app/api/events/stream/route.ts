// GET /api/events/stream
//
// Phase-2 P2-21 §38: structured event stream endpoint for live tailing.
//
// Returns the last N (default 50, hard-cap 500) AgentEvents as newline-
// delimited JSON (NDJSON) so the dashboard can poll + append without parsing
// a single large JSON document. The dashboard's Events tab can use this to
// implement a live tail mode (poll every 2s, append only newer rows by id).
//
// We do NOT implement SSE or WebSocket — the dashboard polls this endpoint
// at its own cadence. The response is a `text/x-ndjson` stream of one JSON
// object per line.
//
// Query params:
//   - limit   : default 50, hard-cap 500
//   - level   : "debug" | "info" | "warn" | "error" | "critical"
//   - agent   : agent name (e.g. "orchestrator", "research", "payment", ...)
//   - opportunityId : filter by opportunity id
//   - sinceId : return only events with id > sinceId (lexicographic — CUIDs
//               are roughly time-ordered, so this gives us a cheap "what's
//               new since my last poll" cursor). Optional.
//   - runId   : filter by runId (matches the `payload.runId` field set by
//               Phase-2 P2-21). Optional.

import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

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
    const sinceId = url.searchParams.get("sinceId") ?? undefined;
    const runId = url.searchParams.get("runId") ?? undefined;

    const limitParam = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(Math.trunc(limitParam), MAX_LIMIT))
      : DEFAULT_LIMIT;

    // Build the where clause.
    const where: Record<string, unknown> = {};
    if (level) where.level = level;
    if (agent) where.agent = agent;
    if (opportunityId) where.opportunityId = opportunityId;
    if (sinceId) {
      // CUIDs are lexicographically time-ordered so we can use gt.
      where.id = { gt: sinceId };
    }
    // runId is stored inside the payload JSON string. SQLite has JSON
    // functions but the Prisma client doesn't expose them cleanly; for the
    // poll endpoint we over-fetch and filter in JS (the dataset is small).
    // We fetch 5x the limit to give the JS filter slack, then truncate.
    let fetchLimit = limit;
    if (runId) fetchLimit = Math.min(limit * 5, MAX_LIMIT);

    const rows = await db.agentEvent.findMany({
      where: where as never,
      orderBy: { createdAt: "desc" },
      take: fetchLimit,
    });

    // Reverse to oldest-first so the dashboard can append naturally.
    const ascending = [...rows].reverse();

    const filtered = runId
      ? ascending.filter((r) => {
          try {
            const p = JSON.parse(r.payload ?? "{}") as { runId?: string };
            return p.runId === runId;
          } catch {
            return false;
          }
        })
      : ascending;

    const trimmed = filtered.slice(Math.max(0, filtered.length - limit));

    // Serialize to NDJSON. One JSON object per line, separated by \n.
    const lines = trimmed.map((row) => {
      const obj = {
        id: row.id,
        taskId: row.taskId ?? null,
        opportunityId: row.opportunityId ?? null,
        agent: row.agent,
        level: row.level,
        event: row.event,
        payload: safeParseJson(row.payload),
        createdAt: row.createdAt.toISOString(),
      };
      return JSON.stringify(obj);
    });
    const body = lines.join("\n") + (lines.length > 0 ? "\n" : "");

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Event-Count": String(trimmed.length),
      },
    });
  } catch (err) {
    console.error("[api/events/stream GET] failed:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }) + "\n", {
      status: 500,
      headers: {
        "Content-Type": "text/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
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
