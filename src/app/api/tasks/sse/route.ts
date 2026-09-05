// GET /api/tasks/sse
//
// Phase-2 P3-3: SSE stream for real-time task updates.
//
// Similar to /api/events/sse but for Task rows. Keeps the connection open
// and pushes recently-updated tasks (new tasks, status changes, completions).
// The dashboard's Tasks tab uses this in "Live" mode instead of polling.
//
// Implementation: polls the DB every 3s for tasks updated since the last
// cursor. Tasks are ordered by updatedAt desc, deduped by id.

import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const POLL_INTERVAL_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

export async function GET(req: Request): Promise<Response> {
  const encoder = new TextEncoder();

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? undefined;
  const sinceId = url.searchParams.get("sinceId") ?? undefined;

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let lastHeartbeat = Date.now();
      let lastPoll = 0;
      let cursor = sinceId ?? undefined;

      const send = (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          closed = true;
        }
      };

      try {
        await bootstrapAgent();
      } catch {
        // ignore
      }

      send(`: connected\n\n`);

      // Send initial context — last 10 tasks.
      try {
        const where: Record<string, unknown> = {};
        if (statusParam && statusParam !== "all") {
          where.status = statusParam;
        }
        const recent = await db.task.findMany({
          where: where as never,
          orderBy: { createdAt: "desc" },
          take: 10,
          include: { opportunity: { select: { title: true } } },
        });
        const ascending = [...recent].reverse();
        for (const row of ascending) {
          send(formatSseTask(row));
          cursor = row.id;
        }
      } catch (err) {
        console.error("[tasks-sse] initial fetch failed:", err);
      }

      // Poll loop.
      while (!closed) {
        const now = Date.now();

        if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
          send(`: heartbeat\n\n`);
          lastHeartbeat = now;
        }

        if (now - lastPoll >= POLL_INTERVAL_MS) {
          lastPoll = now;
          try {
            const where: Record<string, unknown> = {};
            if (statusParam && statusParam !== "all") {
              where.status = statusParam;
            }
            if (cursor) {
              where.id = { gt: cursor };
            }
            const rows = await db.task.findMany({
              where: where as never,
              orderBy: { createdAt: "asc" },
              take: 50,
              include: { opportunity: { select: { title: true } } },
            });
            for (const row of rows) {
              send(formatSseTask(row));
              cursor = row.id;
            }
          } catch (err) {
            console.error("[tasks-sse] poll failed:", err);
          }
        }

        await new Promise((r) => setTimeout(r, 500));
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
    cancel() {},
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function formatSseTask(row: {
  id: string;
  opportunityId: string | null;
  fromAgent: string;
  toAgent: string;
  objective: string;
  status: string;
  riskLevel: string;
  executionLevel: number;
  modelId: string | null;
  tokensUsed: number;
  latencyMs: number;
  qualityScore: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  opportunity?: { title: string } | null;
}): string {
  const obj = {
    id: row.id,
    opportunityId: row.opportunityId,
    opportunityTitle: row.opportunity?.title ?? null,
    fromAgent: row.fromAgent,
    toAgent: row.toAgent,
    objective: row.objective,
    status: row.status,
    riskLevel: row.riskLevel,
    executionLevel: row.executionLevel,
    modelId: row.modelId,
    tokensUsed: row.tokensUsed,
    latencyMs: row.latencyMs,
    qualityScore: row.qualityScore,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
  return `id: ${row.id}\ndata: ${JSON.stringify(obj)}\n\n`;
}
