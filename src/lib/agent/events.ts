// Append-only event log for the autonomous agent (spec §17, §28).
//
// Every state change, decision, error, and external action is recorded as an
// immutable AgentEvent row. Downstream consumers (dashboard, review agent,
// audit endpoint) read these events to reconstruct agent behaviour.
//
// Design notes:
// - `logEvent` is async and never throws — failures are surfaced to the
//   console instead of crashing the dev server (spec §28 graceful errors).
// - The `payload` object is JSON-stringified before being stored so the
//   `AgentEvent.payload` String column stays schema-stable.
// - `taskId` and `opportunityId` are optional foreign keys; we null-check
//   them against the existence of their parents to avoid FK violations when
//   callers pass a stale id.
// - `runId` is a first-class field on the `opts` (Phase-2 P2-21): every event
//   in a single orchestrator cycle shares the same `runId` so the dashboard
//   can correlate events across agents. If the caller omits `runId`, we
//   fall back to a per-process default so all events in this server lifetime
//   are at least grouped together (useful for ad-hoc / non-loop callers).
// - The optional `provider`, `model`, `tokens`, `latencyMs`, `fallback`, and
//   `error` fields are merged into `payload` so they appear as top-level keys
//   in the JSON column AND in the dashboard's payload viewer — without the
//   caller having to remember to add them to a free-form payload object.

import { db } from "@/lib/db";
import type { AgentEventLog, AgentName, EventLevel } from "@/lib/agent/types";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Per-process default runId (Phase-2 P2-21)
// ---------------------------------------------------------------------------

/**
 * A stable UUID generated the first time this module is imported in a given
 * server process. Used as the fallback `runId` when a caller does not pass
 * one explicitly (e.g. bootstrap, ad-hoc API calls). The orchestrator loop
 * generates a FRESH runId per cycle (see `src/lib/orchestrator/loop.ts`) so
 * the per-cycle correlation is preserved when the loop drives the calls.
 */
const PROCESS_RUN_ID: string = generateRunId();

function generateRunId(): string {
  // Prefer the global Web Crypto UUID (available in Node 19+/Next.js 16
  // server runtime). Fall back to a small random string when unavailable.
  try {
    if (
      typeof globalThis !== "undefined" &&
      typeof globalThis.crypto?.randomUUID === "function"
    ) {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // ignore — fall through to the manual fallback
  }
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Returns the per-process default runId. Useful for callers that want to
 * attribute ad-hoc events to "this process" when they don't have a
 * cycle-scoped runId.
 */
export function getProcessRunId(): string {
  return PROCESS_RUN_ID;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const eventInputSchema = z.object({
  agent: z.string().min(1),
  level: z.enum(["debug", "info", "warn", "error", "critical"]),
  event: z.string().min(1).max(280),
  payload: z.record(z.string(), z.unknown()).optional(),
  taskId: z.string().optional(),
  opportunityId: z.string().optional(),
});

export interface LogEventOptions {
  taskId?: string;
  opportunityId?: string;
  /**
   * Phase-2 P2-21: every event in a single orchestrator cycle shares the
   * same `runId` so the dashboard can correlate events across agents.
   * Defaults to the per-process runId when omitted.
   */
  runId?: string;
  /**
   * Convenience fields (Phase-2 P2-21). When set, these are merged into the
   * payload as first-class keys so callers don't have to remember to add
   * them to the free-form `payload` object. They are NOT separate columns —
   * they ride inside the existing `payload` JSON.
   */
  provider?: string;
  model?: string;
  tokens?: number;
  latencyMs?: number;
  fallback?: boolean;
  error?: string;
}

/**
 * Persist a single agent event to the append-only log.
 *
 * @returns the created event row, or `null` if the write failed (the failure
 *          is logged to the console but never thrown).
 */
export async function logEvent(
  agent: AgentName,
  level: EventLevel,
  event: string,
  payload?: Record<string, unknown>,
  opts?: LogEventOptions
): Promise<AgentEventLog | null> {
  // Merge the convenience fields into the payload so they appear as
  // top-level JSON keys in the stored row (Phase-2 P2-21). The caller
  // can still pass them via the free-form `payload` object — we just
  // dedupe so the explicit opt wins.
  const enrichedPayload: Record<string, unknown> = { ...(payload ?? {}) };
  if (opts?.runId !== undefined) {
    enrichedPayload.runId = opts.runId;
  } else {
    enrichedPayload.runId = PROCESS_RUN_ID;
  }
  if (opts?.provider !== undefined) enrichedPayload.provider = opts.provider;
  if (opts?.model !== undefined) enrichedPayload.model = opts.model;
  if (opts?.tokens !== undefined) enrichedPayload.tokens = opts.tokens;
  if (opts?.latencyMs !== undefined) enrichedPayload.latencyMs = opts.latencyMs;
  if (opts?.fallback !== undefined) enrichedPayload.fallback = opts.fallback;
  if (opts?.error !== undefined) enrichedPayload.error = opts.error;

  const parsed = eventInputSchema.safeParse({
    agent,
    level,
    event,
    payload: enrichedPayload,
    taskId: opts?.taskId,
    opportunityId: opts?.opportunityId,
  });
  if (!parsed.success) {
    // Invalid input — record a best-effort warning and bail.
    console.warn("[events] logEvent rejected invalid input:", parsed.error.format());
    return null;
  }
  const data = parsed.data;

  try {
    // Optional FK sanity: only attach taskId/opportunityId if the parent row
    // exists. We do a lightweight exists check; on miss we null-out the link
    // rather than crashing the call site.
    let taskId = data.taskId ?? null;
    let opportunityId = data.opportunityId ?? null;

    if (taskId) {
      const exists = await db.task.findUnique({
        where: { id: taskId },
        select: { id: true },
      });
      if (!exists) taskId = null;
    }
    if (opportunityId) {
      const exists = await db.opportunity.findUnique({
        where: { id: opportunityId },
        select: { id: true },
      });
      if (!exists) opportunityId = null;
    }

    const row = await db.agentEvent.create({
      data: {
        agent: data.agent,
        level: data.level,
        event: data.event,
        payload: JSON.stringify(data.payload ?? {}),
        taskId: taskId ?? undefined,
        opportunityId: opportunityId ?? undefined,
      },
    });

    return {
      id: row.id,
      taskId: row.taskId ?? undefined,
      opportunityId: row.opportunityId ?? undefined,
      agent: row.agent as AgentName,
      level: row.level as EventLevel,
      event: row.event,
      payload: safeParseJson(row.payload),
      createdAt: row.createdAt.toISOString(),
    };
  } catch (err) {
    console.error("[events] failed to persist event:", err);
    return null;
  }
}

/**
 * Fetch the most recent N events across all agents (default 50).
 * Returns rows in newest-first order.
 */
export async function getRecentEvents(limit = 50): Promise<AgentEventLog[]> {
  try {
    const rows = await db.agentEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: Math.max(1, Math.min(limit, 500)),
    });
    return rows.map(rowToLog);
  } catch (err) {
    console.error("[events] getRecentEvents failed:", err);
    return [];
  }
}

/**
 * Fetch all events linked to a specific opportunity (any agent, any level).
 */
export async function getEventsByOpportunity(
  opportunityId: string
): Promise<AgentEventLog[]> {
  try {
    const rows = await db.agentEvent.findMany({
      where: { opportunityId },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    return rows.map(rowToLog);
  } catch (err) {
    console.error("[events] getEventsByOpportunity failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToLog(row: {
  id: string;
  taskId: string | null;
  opportunityId: string | null;
  agent: string;
  level: string;
  event: string;
  payload: string;
  createdAt: Date;
}): AgentEventLog {
  return {
    id: row.id,
    taskId: row.taskId ?? undefined,
    opportunityId: row.opportunityId ?? undefined,
    agent: row.agent as AgentName,
    level: row.level as EventLevel,
    event: row.event,
    payload: safeParseJson(row.payload),
    createdAt: row.createdAt.toISOString(),
  };
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : { value: v };
  } catch {
    return { raw };
  }
}
