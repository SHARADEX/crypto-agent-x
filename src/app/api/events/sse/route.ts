// GET /api/events/sse
//
// Phase-2 P3-3: Server-Sent Events (SSE) stream for real-time event push.
//
// Unlike the NDJSON poll endpoint (/api/events/stream), this endpoint keeps
// the HTTP connection open and pushes new events to the dashboard as they're
// logged. The dashboard's Events tab subscribes via `EventSource` and gets
// instant updates without polling.
//
// Implementation: the endpoint polls the DB every 2s for new events (using
// the `sinceId` cursor) and writes them as SSE `data:` lines. This is a
// pragmatic SSE — true push would require a pub/sub layer (Redis/WebSocket),
// but 2s internal polling behind a persistent SSE connection is
// indistinguishable from push for the user and avoids the complexity of
// a message broker.
//
// Query params (same as /api/events/stream):
//   - level, agent, opportunityId, runId — filters
//   - sinceId — starting cursor (last event id the client saw)
//
// SSE protocol:
//   - Content-Type: text/event-stream
//   - Each event: `data: <json>\n\n`
//   - Heartbeat comment every 15s: `:heartbeat\n\n` (keeps the connection alive)

import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes — Next.js will cycle the connection

const VALID_LEVELS = new Set([
  "debug",
  "info",
  "warn",
  "error",
  "critical",
]);

const POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

export async function GET(req: Request): Promise<Response> {
  // Signal that this is a streaming response.
  const encoder = new TextEncoder();

  const url = new URL(req.url);
  const levelParam = url.searchParams.get("level");
  const level =
    levelParam && VALID_LEVELS.has(levelParam) ? levelParam : undefined;
  const agent = url.searchParams.get("agent") ?? undefined;
  const opportunityId = url.searchParams.get("opportunityId") ?? undefined;
  const runId = url.searchParams.get("runId") ?? undefined;
  let sinceId = url.searchParams.get("sinceId") ?? undefined;

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let lastHeartbeat = Date.now();
      let lastPoll = 0;

      const send = (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          closed = true;
        }
      };

      // Bootstrap on first connect (cheap due to module-level flag).
      try {
        await bootstrapAgent();
      } catch {
        // ignore — the stream still works, just without bootstrap
      }

      // Send an initial comment so the client knows the connection is open.
      send(`: connected\n\n`);

      // If no sinceId, start from "now" — send the last 10 events as context.
      if (!sinceId) {
        try {
          const recent = await db.agentEvent.findMany({
            where: buildWhere(level, agent, opportunityId),
            orderBy: { createdAt: "desc" },
            take: 10,
          });
          const ascending = [...recent].reverse();
          for (const row of ascending) {
            send(formatSseEvent(row));
            sinceId = row.id;
          }
        } catch (err) {
          console.error("[sse] initial fetch failed:", err);
        }
      }

      // Poll loop.
      while (!closed) {
        const now = Date.now();

        // Heartbeat.
        if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
          send(`: heartbeat\n\n`);
          lastHeartbeat = now;
        }

        // Poll for new events.
        if (now - lastPoll >= POLL_INTERVAL_MS) {
          lastPoll = now;
          try {
            const where = buildWhere(level, agent, opportunityId);
            if (sinceId) {
              (where as Record<string, unknown>).id = { gt: sinceId };
            }
            const rows = await db.agentEvent.findMany({
              where: where as never,
              orderBy: { createdAt: "asc" },
              take: 50,
            });

            for (const row of rows) {
              // Optional runId filter (stored in payload JSON).
              if (runId) {
                try {
                  const p = JSON.parse(row.payload ?? "{}") as {
                    runId?: string;
                  };
                  if (p.runId !== runId) continue;
                } catch {
                  continue;
                }
              }
              send(formatSseEvent(row));
              sinceId = row.id;
            }
          } catch (err) {
            console.error("[sse] poll failed:", err);
            // Don't close the stream on a transient DB error — just wait + retry.
          }
        }

        // Sleep 500ms between iterations to avoid a tight loop.
        await new Promise((r) => setTimeout(r, 500));

        // Check if the client disconnected (AbortSignal).
        if (req.signal.aborted) {
          closed = true;
          break;
        }
      }

      try {
        controller.close();
      } catch {
        // already closed
      }
    },
    cancel() {
      // Client disconnected.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable proxy buffering
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildWhere(
  level?: string,
  agent?: string,
  opportunityId?: string
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (level) where.level = level;
  if (agent) where.agent = agent;
  if (opportunityId) where.opportunityId = opportunityId;
  return where;
}

function formatSseEvent(row: {
  id: string;
  taskId: string | null;
  opportunityId: string | null;
  agent: string;
  level: string;
  event: string;
  payload: string | null;
  createdAt: Date;
}): string {
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
  // SSE format: `id: <id>\ndata: <json>\n\n`
  return `id: ${row.id}\ndata: ${JSON.stringify(obj)}\n\n`;
}

function safeParseJson(
  raw: string | null | undefined
): Record<string, unknown> {
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
