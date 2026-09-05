// Per-(model, task_type) cooldown subsystem (spec §4P, Phase-2 P2-8).
//
// The circuit breaker (P2-2) operates at the model level — 3 failures in 60s
// → degraded, 10 → blacklisted. But sometimes a model fails consistently on
// ONE specific task type (e.g. "zai/glm-4.6 fails on web3 tasks") while
// succeeding on others. Blacklisting the whole model is too aggressive.
//
// This subsystem tracks per-(model, taskType) failure patterns and excludes
// a model from a specific task type for 1 hour after N consecutive failures
// on that task type. The router consults `isTaskEligible(modelId, taskType)`
// when filtering eligible models.
//
// State is persisted to the DB (TaskCooldown table) so it survives restarts.

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of consecutive failures on the same (model, taskType) before cooldown. */
const COOLDOWN_FAILURE_THRESHOLD = 3;

/** How long a cooldown lasts (1 hour). */
const COOLDOWN_DURATION_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskCooldownEntry {
  id: string;
  modelId: string;
  taskType: string;
  consecutiveFailures: number;
  cooldownUntil: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Record a success/failure for a (model, taskType) pair
// ---------------------------------------------------------------------------

/**
 * Record the outcome of a (model, taskType) call. On success, the
 * consecutive-failure counter resets to 0. On failure, it increments; when
 * it reaches COOLDOWN_FAILURE_THRESHOLD, a cooldown is set.
 *
 * Phase-2 P2-8 — closed.
 */
export async function recordTaskOutcome(
  modelId: string,
  taskType: string,
  success: boolean
): Promise<void> {
  if (!modelId || !taskType) return;

  try {
    const existing = await db.taskCooldown.findUnique({
      where: {
        modelId_taskType: { modelId, taskType },
      },
    });

    const now = new Date();

    if (success) {
      // Reset the failure counter on success. Clear any active cooldown
      // (a success means the model is working again for this task type).
      await db.taskCooldown.upsert({
        where: { modelId_taskType: { modelId, taskType } },
        create: {
          modelId,
          taskType,
          consecutiveFailures: 0,
          cooldownUntil: null,
          lastSuccessAt: now,
        },
        update: {
          consecutiveFailures: 0,
          cooldownUntil: null,
          lastSuccessAt: now,
        },
      });
      return;
    }

    // Failure — increment the counter.
    const newFailureCount = (existing?.consecutiveFailures ?? 0) + 1;
    let cooldownUntil: Date | null = null;

    if (newFailureCount >= COOLDOWN_FAILURE_THRESHOLD) {
      cooldownUntil = new Date(now.getTime() + COOLDOWN_DURATION_MS);
      // Only log the first time we enter cooldown (not on every subsequent failure).
      if (!existing?.cooldownUntil || new Date(existing.cooldownUntil).getTime() < now.getTime()) {
        await logEvent(
          "model_router",
          "warn",
          "task_cooldown_engaged",
          {
            modelId,
            taskType,
            consecutiveFailures: newFailureCount,
            cooldownUntil: cooldownUntil.toISOString(),
            durationMs: COOLDOWN_DURATION_MS,
          },
          {}
        );
      }
    }

    await db.taskCooldown.upsert({
      where: { modelId_taskType: { modelId, taskType } },
      create: {
        modelId,
        taskType,
        consecutiveFailures: newFailureCount,
        cooldownUntil,
        lastFailureAt: now,
      },
      update: {
        consecutiveFailures: newFailureCount,
        cooldownUntil,
        lastFailureAt: now,
      },
    });
  } catch (err) {
    console.error("[task-cooldown] recordTaskOutcome failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Check eligibility
// ---------------------------------------------------------------------------

/**
 * Is the model currently eligible for the given task type? Returns false if
 * the model is in an active cooldown for this task type.
 */
export async function isTaskEligible(
  modelId: string,
  taskType: string
): Promise<boolean> {
  if (!modelId || !taskType) return true;

  try {
    const row = await db.taskCooldown.findUnique({
      where: { modelId_taskType: { modelId, taskType } },
    });
    if (!row?.cooldownUntil) return true;
    return new Date(row.cooldownUntil).getTime() <= Date.now();
  } catch {
    // On DB error, be permissive — don't block the whole router.
    return true;
  }
}

/**
 * Synchronous variant that uses a cached in-memory snapshot. Used by the
 * router's hot path where we don't want to await a DB read per model.
 * Call `refreshCooldownCache()` once at the start of a routing decision.
 */
let _cooldownCache: Map<string, number> = new Map(); // key: "modelId|taskType" → cooldownUntil epoch-ms
let _cacheFetchedAt = 0;
const CACHE_TTL_MS = 5_000;

export async function refreshCooldownCache(): Promise<void> {
  try {
    const rows = await db.taskCooldown.findMany({
      where: { cooldownUntil: { not: null } },
      select: { modelId: true, taskType: true, cooldownUntil: true },
    });
    const cache = new Map<string, number>();
    for (const r of rows) {
      if (r.cooldownUntil) {
        cache.set(
          `${r.modelId}|${r.taskType}`,
          new Date(r.cooldownUntil).getTime()
        );
      }
    }
    _cooldownCache = cache;
    _cacheFetchedAt = Date.now();
  } catch (err) {
    console.error("[task-cooldown] refreshCooldownCache failed:", err);
  }
}

export function isTaskEligibleCached(
  modelId: string,
  taskType: string
): boolean {
  if (Date.now() - _cacheFetchedAt > CACHE_TTL_MS) return true; // stale cache → permissive
  const until = _cooldownCache.get(`${modelId}|${taskType}`);
  if (!until) return true;
  return until <= Date.now();
}

// ---------------------------------------------------------------------------
// Clear cooldowns (operator override)
// ---------------------------------------------------------------------------

/**
 * Clear all task cooldowns (operator override). Used by the dashboard's
 * maintenance actions.
 */
export async function clearAllTaskCooldowns(): Promise<{
  cleared: number;
}> {
  try {
    const result = await db.taskCooldown.updateMany({
      where: { cooldownUntil: { not: null } },
      data: { cooldownUntil: null, consecutiveFailures: 0 },
    });
    _cooldownCache.clear();
    await logEvent(
      "model_router",
      "info",
      "task_cooldowns_cleared",
      { cleared: result.count },
      {}
    );
    return { cleared: result.count };
  } catch (err) {
    console.error("[task-cooldown] clearAllTaskCooldowns failed:", err);
    return { cleared: 0 };
  }
}

/**
 * Get all active cooldowns (for the dashboard).
 */
export async function getActiveCooldowns(): Promise<TaskCooldownEntry[]> {
  try {
    const now = new Date();
    const rows = await db.taskCooldown.findMany({
      where: {
        cooldownUntil: { not: null, gt: now },
      },
      orderBy: { cooldownUntil: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      modelId: r.modelId,
      taskType: r.taskType,
      consecutiveFailures: r.consecutiveFailures,
      cooldownUntil: r.cooldownUntil?.toISOString() ?? null,
      lastFailureAt: r.lastFailureAt?.toISOString() ?? null,
      lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  } catch (err) {
    console.error("[task-cooldown] getActiveCooldowns failed:", err);
    return [];
  }
}
