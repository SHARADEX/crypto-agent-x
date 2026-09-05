// Free-tier budget enforcement (spec §27).
//
// The agent must never spend real money on LLM, RPC, or web requests. Each
// free-tier provider has hard daily / hourly limits and we model them as
// aggregate counters across ALL providers so a single runaway task cannot
// blow through 250k daily tokens before the operator notices.
//
// Storage: the `BudgetUsage` Prisma model with a unique `period` key.
//   - `day:YYYY-MM-DD`  — daily aggregate
//   - `hour:YYYY-MM-DD-HH` — hourly aggregate (rolling window)
//
// All writes are atomic `upsert` + `{ increment: N }` operations so multiple
// concurrent workers cannot race-condition their way past the limits.

import { db } from "@/lib/db";
import { BUDGET_LIMITS } from "@/config/providers";
import type { BudgetReport } from "@/lib/agent/types";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Period key helpers (UTC — agent runs on UTC for deterministic windows)
// ---------------------------------------------------------------------------

/** Returns `YYYY-MM-DD` for the given UTC date. */
function dayKey(d: Date = new Date()): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `day:${yyyy}-${mm}-${dd}`;
}

/** Returns `YYYY-MM-DD-HH` for the given UTC hour. */
function hourKey(d: Date = new Date()): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `hour:${yyyy}-${mm}-${dd}-${hh}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const llmCallSchema = z.object({
  modelId: z.string().min(1),
  tokens: z.number().int().nonnegative(),
  success: z.boolean(),
});

// ---------------------------------------------------------------------------
// BudgetManager
// ---------------------------------------------------------------------------

/**
 * Singleton budget tracker. Records usage, reports against limits, and
 * throws when a hard limit is exceeded.
 *
 * Usage:
 *   const bm = BudgetManager.getInstance();
 *   bm.recordLlmCall("zai/glm-4.6", 1450, true);
 *   bm.assertWithinBudget();
 */
export class BudgetManager {
  private static _instance: BudgetManager | null = null;

  static getInstance(): BudgetManager {
    if (!BudgetManager._instance) BudgetManager._instance = new BudgetManager();
    return BudgetManager._instance;
  }

  // -- Recording -----------------------------------------------------------

  /**
   * Record one LLM call against the day + hour buckets. Uses atomic upsert
   * with increment so concurrent workers cannot lose updates.
   */
  async recordLlmCall(
    modelId: string,
    tokens: number,
    success: boolean
  ): Promise<void> {
    const parsed = llmCallSchema.safeParse({ modelId, tokens, success });
    if (!parsed.success) {
      console.warn("[budget] recordLlmCall rejected input:", parsed.error.format());
      return;
    }
    await this.bumpBothBuckets({
      llmRequests: 1,
      llmTokens: parsed.data.tokens,
    });
  }

  /**
   * Record one outbound web request (scraping, RSS fetch, etc.).
   */
  async recordWebRequest(): Promise<void> {
    await this.bumpBothBuckets({ webRequests: 1 });
  }

  /**
   * Record one read-only RPC call (balance check, transaction history).
   */
  async recordRpcRequest(): Promise<void> {
    await this.bumpBothBuckets({ rpcRequests: 1 });
  }

  /**
   * Record wall-clock time spent executing a task. Aggregated into the day +
   * hour buckets so the dashboard can show execution-time pressure.
   */
  async recordExecutionTime(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) return;
    await this.bumpBothBuckets({ executionTimeMs: Math.round(ms) });
  }

  // -- Reporting ----------------------------------------------------------

  /**
   * Build a `BudgetReport` showing current day + hour usage vs configured
   * limits.
   */
  async getReport(): Promise<BudgetReport> {
    const [day, hour] = await Promise.all([
      this.readBucket(dayKey()),
      this.readBucket(hourKey()),
    ]);
    return {
      day,
      hour,
      limits: {
        dailyLlmTokens: BUDGET_LIMITS.dailyLlmTokens,
        hourlyLlmTokens: BUDGET_LIMITS.hourlyLlmTokens,
        perTaskLlmTokens: BUDGET_LIMITS.perTaskLlmTokens,
      },
    };
  }

  /**
   * Throw a `BudgetExceededError` if any hard limit has been breached.
   * Called by the orchestrator before each new cycle.
   */
  async assertWithinBudget(): Promise<void> {
    const report = await this.getReport();

    if (report.day.llmTokens >= BUDGET_LIMITS.dailyLlmTokens) {
      throw new BudgetExceededError(
        "daily_llm_tokens",
        report.day.llmTokens,
        BUDGET_LIMITS.dailyLlmTokens
      );
    }
    if (report.hour.llmTokens >= BUDGET_LIMITS.hourlyLlmTokens) {
      throw new BudgetExceededError(
        "hourly_llm_tokens",
        report.hour.llmTokens,
        BUDGET_LIMITS.hourlyLlmTokens
      );
    }
    if (report.day.webRequests >= BUDGET_LIMITS.dailyWebRequests) {
      throw new BudgetExceededError(
        "daily_web_requests",
        report.day.webRequests,
        BUDGET_LIMITS.dailyWebRequests
      );
    }
    if (report.day.rpcRequests >= BUDGET_LIMITS.dailyRpcRequests) {
      throw new BudgetExceededError(
        "daily_rpc_requests",
        report.day.rpcRequests,
        BUDGET_LIMITS.dailyRpcRequests
      );
    }
  }

  /**
   * Decide whether the agent has enough headroom to start a new task that is
   * estimated to consume `taskTokenEstimate` tokens.
   *
   * Checks:
   *   - Daily + hourly LLM token caps would not be breached.
   *   - Per-task cap is not exceeded by the estimate itself.
   *   - Daily web + RPC caps still have headroom.
   */
  async canRunTask(taskTokenEstimate: number): Promise<boolean> {
    if (!Number.isFinite(taskTokenEstimate) || taskTokenEstimate < 0) {
      return false;
    }
    if (taskTokenEstimate > BUDGET_LIMITS.perTaskLlmTokens) {
      return false;
    }
    try {
      const report = await this.getReport();
      const dayTokensLeft =
        BUDGET_LIMITS.dailyLlmTokens - report.day.llmTokens;
      const hourTokensLeft =
        BUDGET_LIMITS.hourlyLlmTokens - report.hour.llmTokens;
      if (taskTokenEstimate > dayTokensLeft) return false;
      if (taskTokenEstimate > hourTokensLeft) return false;
      if (report.day.webRequests >= BUDGET_LIMITS.dailyWebRequests) return false;
      if (report.day.rpcRequests >= BUDGET_LIMITS.dailyRpcRequests) return false;
      return true;
    } catch (err) {
      console.error("[budget] canRunTask failed:", err);
      return false;
    }
  }

  // -- Internals ----------------------------------------------------------

  /**
   * Atomically increment both the day and hour buckets. Wraps the two upserts
   * in a transaction so a crash between them leaves neither row half-updated.
   */
  private async bumpBothBuckets(delta: {
    llmRequests?: number;
    llmTokens?: number;
    webRequests?: number;
    rpcRequests?: number;
    executionTimeMs?: number;
  }): Promise<void> {
    const dKey = dayKey();
    const hKey = hourKey();

    const buildCreate = () => ({
      llmRequests: delta.llmRequests ?? 0,
      llmTokens: delta.llmTokens ?? 0,
      webRequests: delta.webRequests ?? 0,
      rpcRequests: delta.rpcRequests ?? 0,
      executionTimeMs: delta.executionTimeMs ?? 0,
    });
    const buildUpdate = () => ({
      llmRequests: delta.llmRequests ? { increment: delta.llmRequests } : undefined,
      llmTokens: delta.llmTokens ? { increment: delta.llmTokens } : undefined,
      webRequests: delta.webRequests ? { increment: delta.webRequests } : undefined,
      rpcRequests: delta.rpcRequests ? { increment: delta.rpcRequests } : undefined,
      executionTimeMs: delta.executionTimeMs
        ? { increment: delta.executionTimeMs }
        : undefined,
    });

    try {
      await db.$transaction([
        db.budgetUsage.upsert({
          where: { period: dKey },
          create: { period: dKey, ...buildCreate() },
          update: buildUpdate() as any,
        }),
        db.budgetUsage.upsert({
          where: { period: hKey },
          create: { period: hKey, ...buildCreate() },
          update: buildUpdate() as any,
        }),
      ]);
    } catch (err) {
      console.error("[budget] bumpBothBuckets failed:", err);
    }
  }

  private async readBucket(period: string): Promise<BudgetReport["day"]> {
    try {
      const row = await db.budgetUsage.findUnique({
        where: { period },
      });
      return {
        llmRequests: row?.llmRequests ?? 0,
        llmTokens: row?.llmTokens ?? 0,
        webRequests: row?.webRequests ?? 0,
        rpcRequests: row?.rpcRequests ?? 0,
        executionTimeMs: row?.executionTimeMs ?? 0,
      };
    } catch (err) {
      console.error("[budget] readBucket failed:", err);
      return {
        llmRequests: 0,
        llmTokens: 0,
        webRequests: 0,
        rpcRequests: 0,
        executionTimeMs: 0,
      };
    }
  }
}

export class BudgetExceededError extends Error {
  readonly limit: string;
  readonly used: number;
  readonly cap: number;
  constructor(limit: string, used: number, cap: number) {
    super(`Budget exceeded for ${limit}: ${used} / ${cap}`);
    this.name = "BudgetExceededError";
    this.limit = limit;
    this.used = used;
    this.cap = cap;
  }
}
