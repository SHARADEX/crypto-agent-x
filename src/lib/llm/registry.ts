// LLM model registry (spec §4C–§4E, §4K, §4R).
//
// The registry is the single source of truth for "which models exist, what
// they can do, and how well they're doing". It owns the `ModelRecord` table
// (seed bootstrap, list/get, role/status/earnings mutations) and the
// `ModelPerformance` per-task-type stats table that the router reads to
// implement adaptive selection (spec §4I, §4K).
//
// All persistence goes through Prisma (`db.modelRecord`, `db.modelPerformance`).
// JSON columns (`capabilitiesJson`, `performanceJson`, `limitsJson`) are
// serialised/deserialised at the boundary so callers always see the typed
// `ModelRecord` shape defined in `@/lib/agent/types`.
//
// Concurrency notes:
//   - `bootstrapModels` is idempotent: it upserts by `modelId` and never
//     overwrites a non-zero `earningsContribUsd` (the agent's hard-won
//     attribution must survive re-seeds).
//   - `updateModelEarnings` and `recordModelPerformance` use atomic
//     `{ increment: n }` updates so concurrent agents cannot lose ticks.

import { db } from "@/lib/db";
import { SEED_MODELS } from "@/config/providers";
import type {
  ModelCapabilities,
  ModelLimits,
  ModelPerformance,
  ModelRecord,
  ModelRole,
  ModelStatus,
} from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// DB-row ↔ typed-shape conversion
// ---------------------------------------------------------------------------

/** Prisma row shape (camelCase columns) — kept structural so we don't import
 *  generated Prisma types and create a circular dependency in tooling. */
interface ModelRecordRow {
  id: string;
  modelId: string;
  provider: string;
  apiType: string;
  enabled: boolean;
  role: string;
  status: string;
  capabilitiesJson: string;
  performanceJson: string;
  limitsJson: string;
  earningsContribUsd: number;
  updatedAt: Date;
}

interface ModelPerformanceRow {
  id: string;
  modelId: string;
  taskType: string;
  attempts: number;
  successes: number;
  failures: number;
  avgLatencyMs: number;
  avgTokens: number;
  avgQuality: number;
  earningsUsd: number;
  updatedAt: Date;
}

/** Convert a Prisma `ModelRecord` row into the typed shape used everywhere
 *  else in the codebase. JSON columns are parsed defensively. */
export function rowToModelRecord(row: ModelRecordRow): ModelRecord {
  return {
    model_id: row.modelId,
    provider: row.provider as ModelRecord["provider"],
    api_type: row.apiType,
    enabled: row.enabled,
    capabilities: safeParseJson(row.capabilitiesJson, DEFAULT_CAPABILITIES),
    performance: safeParseJson(row.performanceJson, DEFAULT_PERFORMANCE),
    limits: safeParseJson(row.limitsJson, DEFAULT_LIMITS),
    role: row.role as ModelRole,
    status: row.status as ModelStatus,
    earnings_contribution_usd: row.earningsContribUsd ?? 0,
  };
}

/** Convert a Prisma `ModelPerformance` row into the typed shape used by the
 *  router when computing weighted scores. */
export function rowToPerfStat(row: ModelPerformanceRow): ModelPerformanceStat {
  const attempts = Math.max(0, row.attempts ?? 0);
  const successes = Math.max(0, row.successes ?? 0);
  const failures = Math.max(0, row.failures ?? 0);
  const success_rate = attempts > 0 ? successes / attempts : 0;
  const failure_rate = attempts > 0 ? failures / attempts : 0;
  return {
    modelId: row.modelId,
    taskType: row.taskType,
    attempts,
    successes,
    failures,
    success_rate,
    failure_rate,
    avg_latency: row.avgLatencyMs ?? 0,
    avg_tokens: row.avgTokens ?? 0,
    avg_quality: row.avgQuality ?? 0,
    earnings_usd: row.earningsUsd ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap (spec §4C — seed registry)
// ---------------------------------------------------------------------------

/**
 * Idempotently seed `db.modelRecord` with the `SEED_MODELS` from config.
 *
 * - Upserts by `modelId` (the unique natural key).
 * - Existing rows keep their `earningsContribUsd` if it is already > 0 —
 *   re-seeding must NEVER zero-out credited earnings.
 * - Existing rows keep their current `role` and `status` (the operator / the
 *   circuit breaker may have flipped them off the seed defaults); only the
 *   capability/performance/limits JSON is refreshed from the seed.
 * - Newly inserted rows get the full seed shape.
 *
 * Safe to call at app boot, in dev hot-reloads, and from cron.
 */
export async function bootstrapModels(): Promise<{
  seeded: number;
  skipped: number;
}> {
  let seeded = 0;
  let skipped = 0;

  for (const seed of SEED_MODELS) {
    try {
      const existing = await db.modelRecord.findUnique({
        where: { modelId: seed.model_id },
        select: {
          earningsContribUsd: true,
          role: true,
          status: true,
          enabled: true,
        },
      });

      // Preserve operator/breaker-controlled fields, refresh everything else.
      const preservedEarnings =
        existing && existing.earningsContribUsd > 0
          ? existing.earningsContribUsd
          : seed.earnings_contribution_usd;
      const preservedRole = existing?.role ?? seed.role;
      const preservedStatus = existing?.status ?? seed.status;
      const preservedEnabled = existing?.enabled ?? seed.enabled;

      await db.modelRecord.upsert({
        where: { modelId: seed.model_id },
        create: {
          modelId: seed.model_id,
          provider: seed.provider,
          apiType: seed.api_type,
          enabled: seed.enabled,
          role: seed.role,
          status: seed.status,
          capabilitiesJson: JSON.stringify(seed.capabilities),
          performanceJson: JSON.stringify(seed.performance),
          limitsJson: JSON.stringify(seed.limits),
          earningsContribUsd: seed.earnings_contribution_usd,
        },
        update: {
          provider: seed.provider,
          apiType: seed.api_type,
          enabled: preservedEnabled,
          role: preservedRole,
          status: preservedStatus,
          capabilitiesJson: JSON.stringify(seed.capabilities),
          performanceJson: JSON.stringify(seed.performance),
          limitsJson: JSON.stringify(seed.limits),
          earningsContribUsd: preservedEarnings,
        },
      });
      seeded += 1;
    } catch (err) {
      console.error(`[registry] bootstrapModels failed for ${seed.model_id}:`, err);
      skipped += 1;
    }
  }

  return { seeded, skipped };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface GetModelsOpts {
  enabled?: boolean;
  role?: ModelRole;
  status?: ModelStatus;
}

/**
 * List models filtered by `enabled`, `role`, and/or `status`. Always returns
 * the typed `ModelRecord` shape (JSON columns deserialised).
 */
export async function getModels(
  opts: GetModelsOpts = {}
): Promise<ModelRecord[]> {
  try {
    const where: Record<string, unknown> = {};
    if (opts.enabled !== undefined) where.enabled = opts.enabled;
    if (opts.role !== undefined) where.role = opts.role;
    if (opts.status !== undefined) where.status = opts.status;

    const rows = await db.modelRecord.findMany({
      where,
      orderBy: [{ provider: "asc" }, { modelId: "asc" }],
    });
    return rows.map(rowToModelRecord);
  } catch (err) {
    console.error("[registry] getModels failed:", err);
    return [];
  }
}

/** Fetch a single model by its unique `model_id` (e.g. `zai/glm-4.6`). */
export async function getModel(modelId: string): Promise<ModelRecord | null> {
  if (!modelId) return null;
  try {
    const row = await db.modelRecord.findUnique({
      where: { modelId },
    });
    return row ? rowToModelRecord(row) : null;
  } catch (err) {
    console.error(`[registry] getModel(${modelId}) failed:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Update a model's routing role (primary / secondary / reviewer / exploration
 * / disabled). Used by the operator dashboard and the router's adaptive
 * re-balancer.
 */
export async function setModelRole(
  modelId: string,
  role: ModelRole
): Promise<boolean> {
  try {
    await db.modelRecord.update({
      where: { modelId },
      data: { role },
    });
    return true;
  } catch (err) {
    console.error(`[registry] setModelRole(${modelId}, ${role}) failed:`, err);
    return false;
  }
}

/**
 * Update a model's health status (healthy / degraded / unhealthy / blacklisted).
 * Called by the circuit breaker when failure thresholds are tripped.
 */
export async function setModelStatus(
  modelId: string,
  status: ModelStatus
): Promise<boolean> {
  try {
    await db.modelRecord.update({
      where: { modelId },
      data: { status },
    });
    return true;
  } catch (err) {
    console.error(`[registry] setModelStatus(${modelId}, ${status}) failed:`, err);
    return false;
  }
}

/**
 * Atomically increment a model's credited earnings by `usd`. Used when a
 * payment is verified and attributed back to the model that did the work.
 */
export async function updateModelEarnings(
  modelId: string,
  usd: number
): Promise<boolean> {
  if (!Number.isFinite(usd) || usd === 0) return false;
  const delta = Math.max(0, usd); // earnings only go up — never decrement via this path
  try {
    await db.modelRecord.update({
      where: { modelId },
      data: { earningsContribUsd: { increment: delta } },
    });
    return true;
  } catch (err) {
    console.error(`[registry] updateModelEarnings(${modelId}, ${usd}) failed:`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-task-type performance tracking (spec §4I, §4K)
// ---------------------------------------------------------------------------

export interface ModelPerformanceStat {
  modelId: string;
  taskType: string;
  attempts: number;
  successes: number;
  failures: number;
  success_rate: number;
  failure_rate: number;
  avg_latency: number;
  avg_tokens: number;
  avg_quality: number;
  earnings_usd: number;
}

/**
 * Record one outcome for a (modelId, taskType) pair. Updates are atomic —
 * concurrent agents cannot lose ticks.
 *
 * The rolling averages for latency / tokens / quality are computed using an
 * exponential moving average with α=0.2 — i.e. new sample contributes 20%,
 * historical average contributes 80%. This keeps the stats responsive to
 * recent shifts without thrashing on every call.
 *
 * @param modelId        the model that produced the outcome
 * @param taskType        the task family (e.g. "research", "coding", "web3")
 * @param success         whether the call produced a usable result
 * @param latencyMs       wall-clock latency of the call
 * @param tokens          total tokens consumed (prompt + completion)
 * @param qualityScore    optional 0..10 quality score from the reviewer
 * @param earningsUsd     optional USD value attributed to this call
 */
export async function recordModelPerformance(
  modelId: string,
  taskType: string,
  success: boolean,
  latencyMs: number,
  tokens: number,
  qualityScore?: number,
  earningsUsd?: number
): Promise<void> {
  if (!modelId || !taskType) return;
  const lat = Math.max(0, Math.round(latencyMs || 0));
  const tok = Math.max(0, Math.round(tokens || 0));
  const q =
    qualityScore !== undefined && Number.isFinite(qualityScore)
      ? Math.max(0, Math.min(10, qualityScore))
      : null;
  const earnings =
    earningsUsd !== undefined && Number.isFinite(earningsUsd) && earningsUsd > 0
      ? earningsUsd
      : null;

  try {
    const existing = await db.modelPerformance.findUnique({
      where: { modelId_taskType: { modelId, taskType } },
    });

    // EMA factor — new sample = 20% weight.
    const ALPHA = 0.2;
    const prevLat = existing?.avgLatencyMs ?? 0;
    const prevTok = existing?.avgTokens ?? 0;
    const prevQ = existing?.avgQuality ?? 0;
    const newLat = Math.round(prevLat === 0 ? lat : prevLat * (1 - ALPHA) + lat * ALPHA);
    const newTok = Math.round(prevTok === 0 ? tok : prevTok * (1 - ALPHA) + tok * ALPHA);
    const newQ =
      q === null
        ? prevQ
        : prevQ === 0
          ? q
          : prevQ * (1 - ALPHA) + q * ALPHA;

    await db.modelPerformance.upsert({
      where: { modelId_taskType: { modelId, taskType } },
      create: {
        modelId,
        taskType,
        attempts: 1,
        successes: success ? 1 : 0,
        failures: success ? 0 : 1,
        avgLatencyMs: newLat,
        avgTokens: newTok,
        avgQuality: newQ,
        earningsUsd: earnings ?? 0,
      },
      update: {
        attempts: { increment: 1 },
        successes: { increment: success ? 1 : 0 },
        failures: { increment: success ? 0 : 1 },
        avgLatencyMs: newLat,
        avgTokens: newTok,
        avgQuality: newQ,
        earningsUsd: earnings ? { increment: earnings } : undefined,
      },
    });
  } catch (err) {
    console.error(
      `[registry] recordModelPerformance(${modelId}, ${taskType}) failed:`,
      err
    );
  }
}

/**
 * Read the per-task-type performance stats for a model. Returns an empty array
 * if no samples have been recorded yet (the router falls back to the seed
 * `ModelPerformance` block in that case).
 */
export async function getModelPerformance(
  modelId: string
): Promise<ModelPerformanceStat[]> {
  try {
    const rows = await db.modelPerformance.findMany({
      where: { modelId },
    });
    return rows.map(rowToPerfStat);
  } catch (err) {
    console.error(
      `[registry] getModelPerformance(${modelId}) failed:`,
      err
    );
    return [];
  }
}

/**
 * Read the per-task-type performance stat for a single (modelId, taskType).
 * Returns null if no sample has been recorded.
 */
export async function getModelPerformanceForTask(
  modelId: string,
  taskType: string
): Promise<ModelPerformanceStat | null> {
  try {
    const row = await db.modelPerformance.findUnique({
      where: { modelId_taskType: { modelId, taskType } },
    });
    return row ? rowToPerfStat(row) : null;
  } catch (err) {
    console.error(
      `[registry] getModelPerformanceForTask(${modelId}, ${taskType}) failed:`,
      err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Defaults + helpers
// ---------------------------------------------------------------------------

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  reasoning: 5,
  coding: 5,
  research: 5,
  web_research: 5,
  web3: 5,
  security: 5,
  writing: 5,
  tool_use: 5,
  structured_output: 5,
};

const DEFAULT_PERFORMANCE: ModelPerformance = {
  success_rate: 0.5,
  average_quality: 5,
  average_latency: 2000,
  average_tokens: 1000,
  failure_rate: 0.5,
};

const DEFAULT_LIMITS: ModelLimits = {
  requests_per_minute: 10,
  tokens_per_minute: 10000,
  daily_requests: 100,
  daily_tokens: 50000,
};

function safeParseJson<T>(raw: string, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
