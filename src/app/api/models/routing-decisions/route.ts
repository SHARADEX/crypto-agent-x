// GET /api/models/routing-decisions
//
// Phase-2 P2-20 §36: dashboard "Recent Routing Decisions" panel endpoint.
//
// Returns the last N (default 20, hard-cap 100) `AgentEvent` rows emitted by
// the `model_router` agent where `event LIKE 'llm_call_%'` OR `event =
// 'routing_decision'`. The dashboard renders these as a scrollable list
// showing:
//   - timestamp
//   - task_type         (extracted from payload)
//   - selected model    (payload.modelId — or `toModel` for rerouting events)
//   - routing_level     (payload.routeAttempt — 0 = primary, >0 = fallback)
//   - reason            (payload.error / "ok" / "rerouting")
//   - was-fallback      (payload.fallback === true)
//   - excluded-models   (payload.excludeModelIds.length)
//
// The payload JSON is parsed and the useful fields surfaced as top-level
// keys so the dashboard component doesn't have to re-parse.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const ROUTING_EVENT_PREFIX = "llm_call_";
const ROUTING_DECISION_EVENT = "routing_decision";

export interface RoutingDecisionEntry {
  id: string;
  createdAt: string;
  event: string;
  level: string;
  agent: string;
  taskId?: string;
  opportunityId?: string;
  runId?: string;
  taskType?: string;
  modelId?: string;
  fromModel?: string;
  toModel?: string;
  provider?: string;
  model?: string;
  routingLevel?: number;
  routeAttempt?: number;
  reason?: string;
  error?: string;
  wasFallback: boolean;
  excludedModelCount: number;
  tokens?: number;
  latencyMs?: number;
  status?: string;
}

export async function GET(req: Request) {
  try {
    await bootstrapAgent();

    const url = new URL(req.url);
    const limitParam = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(Math.trunc(limitParam), MAX_LIMIT))
      : DEFAULT_LIMIT;

    // SQLite doesn't support LIKE on an indexed column efficiently, but the
    // AgentEvent table is small (a few thousand rows at most) so a full
    // table scan with a JS-side filter is fine. We fetch 5x the requested
    // limit to give the JS filter some slack, then truncate.
    const rows = await db.agentEvent.findMany({
      where: { agent: "model_router" },
      orderBy: { createdAt: "desc" },
      take: Math.min(limit * 5, 500),
    });

    const filtered: RoutingDecisionEntry[] = [];
    for (const row of rows) {
      if (filtered.length >= limit) break;
      const isRoutingEvent =
        row.event.startsWith(ROUTING_EVENT_PREFIX) ||
        row.event === ROUTING_DECISION_EVENT;
      if (!isRoutingEvent) continue;

      const payload = safeParseJson(row.payload);
      const excludeModelIds = Array.isArray(payload.excludeModelIds)
        ? (payload.excludeModelIds as unknown[])
        : [];
      const wasFallback =
        payload.fallback === true ||
        row.event === "llm_call_rerouting" ||
        row.event === "llm_call_exhausted_retries" ||
        (typeof payload.routeAttempt === "number" && payload.routeAttempt > 0);

      filtered.push({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        event: row.event,
        level: row.level,
        agent: row.agent,
        taskId: row.taskId ?? undefined,
        opportunityId: row.opportunityId ?? undefined,
        runId: typeof payload.runId === "string" ? payload.runId : undefined,
        taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
        modelId:
          (typeof payload.modelId === "string" && payload.modelId) ||
          (typeof payload.model === "string" && payload.model) ||
          undefined,
        fromModel:
          typeof payload.fromModel === "string" ? payload.fromModel : undefined,
        toModel:
          typeof payload.toModel === "string" ? payload.toModel : undefined,
        provider:
          typeof payload.provider === "string" ? payload.provider : undefined,
        model: typeof payload.model === "string" ? payload.model : undefined,
        routingLevel:
          typeof payload.routingLevel === "number"
            ? payload.routingLevel
            : typeof payload.routeAttempt === "number"
              ? payload.routeAttempt
              : undefined,
        routeAttempt:
          typeof payload.routeAttempt === "number"
            ? payload.routeAttempt
            : undefined,
        reason:
          typeof payload.reason === "string"
            ? payload.reason
            : row.event === "llm_call_succeeded"
              ? "ok"
              : row.event === "llm_call_rerouting"
                ? "rerouted"
                : undefined,
        error:
          typeof payload.error === "string" ? payload.error : undefined,
        wasFallback,
        excludedModelCount: excludeModelIds.length,
        tokens:
          typeof payload.tokens === "number"
            ? payload.tokens
            : typeof payload.completionTokens === "number" &&
                typeof payload.promptTokens === "number"
              ? (payload.promptTokens as number) +
                (payload.completionTokens as number)
              : undefined,
        latencyMs:
          typeof payload.latencyMs === "number" ? payload.latencyMs : undefined,
        status: typeof payload.status === "string" ? payload.status : undefined,
      });
    }

    return NextResponse.json(
      { routingDecisions: filtered, count: filtered.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/models/routing-decisions GET] failed:", err);
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
