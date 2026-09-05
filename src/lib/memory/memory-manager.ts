// Memory Manager — bounded context retrieval for LLM calls.
//
// Ensures that the database can grow indefinitely (100k+ records) without
// causing LLM context to grow linearly. The LLM-facing context is always
// bounded by hard limits:
//
//   MAX_MEMORY_TOKENS       — total tokens for the memory context
//   MAX_RETRIEVED_RECORDS   — max records returned from any single query
//   MAX_RECENT_TASKS        — max recent task records included
//   MAX_SIMILAR_TASKS       — max similar-past-experience records included
//
// The manager has 6 tiers:
//   1. Working Memory      — the current task + opportunity (1 record)
//   2. Episodic Memory      — recent tasks for the same opportunity/strategy
//   3. Semantic Memory      — compact summaries of past lessons (AgentMemory)
//   4. Strategy Statistics  — aggregated via SQL (not raw records)
//   5. Model Statistics     — aggregated via SQL (not raw records)
//   6. Archived Raw History — never sent to the LLM; stays in the DB
//
// Statistics are computed via deterministic SQL aggregation — the LLM never
// sees raw records for computation. It receives pre-computed numbers like
// `success_rate = 0.85`, `avg_hourly = $14.20`, etc.
//
// The manager reports:
//   memory_records_total    — total rows across all tables (for monitoring)
//   records_retrieved       — how many records were actually fetched
//   estimated_memory_tokens — token estimate of the assembled context
//   final_context_tokens    — after budget enforcement (may be < estimated)

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import { retrieveMemories } from "@/lib/memory/agent-memory";
import { getStrategyStats } from "@/lib/economics/strategy-stats";
import { getTotals } from "@/lib/economics/ledger";
import { getModelPerformanceForTask } from "@/lib/llm/registry";

// ---------------------------------------------------------------------------
// Hard limits (Phase 3.2 §Memory)
// ---------------------------------------------------------------------------

export const MAX_MEMORY_TOKENS = 4000;
export const MAX_RETRIEVED_RECORDS = 20;
export const MAX_RECENT_TASKS = 3;
export const MAX_SIMILAR_TASKS = 3;
const APPROX_CHARS_PER_TOKEN = 4; // standard OpenAI heuristic

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryContext {
  /** The current task being worked on (if any). */
  workingMemory: WorkingMemoryEntry | null;
  /** Recent tasks for the same opportunity or strategy. */
  episodicMemory: EpisodicEntry[];
  /** Compact lessons learned (AgentMemory rows, top by confidence). */
  semanticMemory: SemanticEntry[];
  /** Pre-computed strategy stats (from SQL aggregation, not raw records). */
  strategyStats: StrategyStatSummary[];
  /** Pre-computed model stats for the current task type. */
  modelStats: ModelStatSummary[];
  /** Relevant security/policy info. */
  policyInfo: PolicyInfo;
  /** Memory report — for monitoring + budget enforcement. */
  report: MemoryReport;
}

export interface WorkingMemoryEntry {
  taskId: string;
  opportunityId: string;
  opportunityTitle: string;
  opportunityCategory: string;
  status: string;
  iterationCount: number;
  modelId: string | null;
  agentName: string;
  objective: string;
}

export interface EpisodicEntry {
  taskId: string;
  agentName: string;
  status: string;
  qualityScore: number | null;
  modelId: string | null;
  objective: string;
  createdAt: string;
}

export interface SemanticEntry {
  id: string;
  category: string;
  title: string;
  body: string;
  confidence: number;
  tags: string[];
}

export interface StrategyStatSummary {
  strategy: string;
  attempted: number;
  completed: number;
  successRate: number;
  totalNetUsd: number;
  avgHourly: number;
}

export interface ModelStatSummary {
  modelId: string;
  taskType: string;
  attempts: number;
  successes: number;
  successRate: number;
  avgQuality: number;
  avgLatencyMs: number;
}

export interface PolicyInfo {
  autonomyMode: string;
  capitalRequired: boolean;
  maxIterations: number;
  riskScoreThreshold: number;
}

export interface MemoryReport {
  memoryRecordsTotal: number;
  recordsRetrieved: number;
  estimatedMemoryTokens: number;
  finalContextTokens: number;
  budgetExceeded: boolean;
  truncated: boolean;
  tiers: {
    working: number;
    episodic: number;
    semantic: number;
    strategyStats: number;
    modelStats: number;
    policy: number;
  };
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function estimateObjectTokens(obj: unknown): number {
  return estimateTokens(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// getTotalRecordCount — count all rows across all tables
// ---------------------------------------------------------------------------

/**
 * Count the total number of records across all persistent tables.
 * Used for the `memory_records_total` metric — proves the DB can grow
 * without affecting LLM context size.
 */
export async function getTotalRecordCount(): Promise<number> {
  try {
    const [
      opportunities,
      tasks,
      iterations,
      earnings,
      transactions,
      strategyStats,
      approvals,
      events,
      memoryRows,
      modelRecords,
      modelPerf,
      idempotency,
      budgetUsage,
      breakerState,
      taskCooldown,
      agentState,
      sourceRep,
      stratAlloc,
      stratChangeLog,
      discoveredSources,
    ] = await Promise.all([
      db.opportunity.count(),
      db.task.count(),
      db.taskIteration.count(),
      db.earning.count(),
      db.transaction.count(),
      db.strategyStat.count(),
      db.approval.count(),
      db.agentEvent.count(),
      db.agentMemory.count(),
      db.modelRecord.count(),
      db.modelPerformance.count(),
      db.idempotencyRecord.count(),
      db.budgetUsage.count(),
      db.breakerState.count(),
      db.taskCooldown.count(),
      db.agentState.count(),
      db.sourceReputation.count(),
      db.strategyAllocation.count(),
      db.strategyAllocationChangeLog.count(),
      db.discoveredSource.count(),
    ]);

    return (
      opportunities + tasks + iterations + earnings + transactions +
      strategyStats + approvals + events + memoryRows + modelRecords +
      modelPerf + idempotency + budgetUsage + breakerState + taskCooldown +
      agentState + sourceRep + stratAlloc + stratChangeLog + discoveredSources
    );
  } catch (err) {
    console.error("[memory-manager] getTotalRecordCount failed:", err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// buildMemoryContext — the main entry point
// ---------------------------------------------------------------------------

/**
 * Build a bounded memory context for an LLM call.
 *
 * This function retrieves ONLY the records relevant to the current task,
 * with hard limits on the number of records + total tokens.
 *
 * @param taskId       The current task ID (if any).
 * @param taskType     The task type (e.g. "research", "coding").
 * @param opportunityId The opportunity being worked on (if any).
 * @param strategy     The strategy family (e.g. "bounty", "freelance").
 */
export async function buildMemoryContext(opts: {
  taskId?: string;
  taskType?: string;
  opportunityId?: string;
  strategy?: string;
}): Promise<MemoryContext> {
  const { taskId, taskType, opportunityId, strategy } = opts;

  // --- Tier 1: Working Memory (the current task) ---
  let workingMemory: WorkingMemoryEntry | null = null;
  let currentOpp: { category: string; title: string; riskScore: number; capitalRequired: boolean } | null = null;

  if (taskId) {
    try {
      const task = await db.task.findUnique({
        where: { id: taskId },
        select: {
          id: true,
          opportunityId: true,
          toAgent: true,
          status: true,
          objective: true,
          modelId: true,
          opportunity: {
            select: {
              id: true,
              title: true,
              category: true,
              riskScore: true,
              capitalRequired: true,
            },
          },
        },
      });

      if (task) {
        // Get the iteration count from the TaskIteration table.
        const iterationCount = await db.taskIteration.count({
          where: { taskId },
        });

        workingMemory = {
          taskId: task.id,
          opportunityId: task.opportunityId ?? "",
          opportunityTitle: task.opportunity?.title ?? "",
          opportunityCategory: task.opportunity?.category ?? "",
          status: task.status,
          iterationCount,
          modelId: task.modelId,
          agentName: task.toAgent,
          objective: task.objective,
        };

        currentOpp = task.opportunity
          ? {
              category: task.opportunity.category,
              title: task.opportunity.title,
              riskScore: task.opportunity.riskScore,
              capitalRequired: task.opportunity.capitalRequired,
            }
          : null;
      }
    } catch (err) {
      console.error("[memory-manager] working memory fetch failed:", err);
    }
  }

  // --- Tier 2: Episodic Memory (recent tasks for same opportunity/strategy) ---
  let episodicMemory: EpisodicEntry[] = [];
  try {
    const where: Record<string, unknown> = {};
    if (opportunityId) {
      where.opportunityId = opportunityId;
    } else if (strategy) {
      // Find tasks whose opportunity matches the strategy family.
      where.opportunity = { category: { contains: strategy } };
    }
    where.id = taskId ? { not: taskId } : undefined;

    const recentTasks = await db.task.findMany({
      where: where as never,
      orderBy: { createdAt: "desc" },
      take: MAX_RECENT_TASKS,
      select: {
        id: true,
        toAgent: true,
        status: true,
        qualityScore: true,
        modelId: true,
        objective: true,
        createdAt: true,
      },
    });

    episodicMemory = recentTasks.map((t) => ({
      taskId: t.id,
      agentName: t.toAgent,
      status: t.status,
      qualityScore: t.qualityScore,
      modelId: t.modelId,
      objective: t.objective,
      createdAt: t.createdAt.toISOString(),
    }));
  } catch (err) {
    console.error("[memory-manager] episodic memory fetch failed:", err);
  }

  // --- Tier 3: Semantic Memory (compact lessons, top by confidence) ---
  let semanticMemory: SemanticEntry[] = [];
  try {
    const memories = await retrieveMemories({
      category: undefined,
      limit: 5,
      minConfidence: 0.4,
    });

    semanticMemory = memories.map((m) => ({
      id: m.id,
      category: m.category,
      title: m.title,
      body: m.body.slice(0, 300), // truncate body to 300 chars for token efficiency
      confidence: m.confidence,
      tags: m.tags.slice(0, 5), // max 5 tags
    }));
  } catch (err) {
    console.error("[memory-manager] semantic memory fetch failed:", err);
  }

  // --- Tier 4: Strategy Statistics (SQL aggregation, NOT raw records) ---
  let strategyStats: StrategyStatSummary[] = [];
  try {
    const stats = await getStrategyStats();
    strategyStats = stats.slice(0, 5).map((s) => ({
      strategy: s.strategy,
      attempted: s.attempted,
      completed: s.completed,
      successRate: s.successRate,
      totalNetUsd: s.totalNetUsd,
      avgHourly: s.avgHourly,
    }));
  } catch (err) {
    console.error("[memory-manager] strategy stats fetch failed:", err);
  }

  // --- Tier 5: Model Statistics (SQL aggregation for current task type) ---
  let modelStats: ModelStatSummary[] = [];
  if (taskType) {
    try {
      // Get model performance for the current task type.
      const models = await db.modelRecord.findMany({
        where: { enabled: true },
        select: { modelId: true },
        take: 10,
      });

      for (const m of models.slice(0, 5)) {
        const perf = await getModelPerformanceForTask(m.modelId, taskType);
        if (perf && perf.attempts > 0) {
          modelStats.push({
            modelId: m.modelId,
            taskType,
            attempts: perf.attempts,
            successes: perf.successes,
            successRate: perf.success_rate,
            avgQuality: perf.avg_quality,
            avgLatencyMs: perf.avg_latency,
          });
        }
      }
    } catch (err) {
      console.error("[memory-manager] model stats fetch failed:", err);
    }
  }

  // --- Tier 6: Policy Info (static-ish, from agent state) ---
  let policyInfo: PolicyInfo = {
    autonomyMode: "observe",
    capitalRequired: currentOpp?.capitalRequired ?? false,
    maxIterations: 5,
    riskScoreThreshold: 70,
  };
  try {
    const state = await db.agentState.findUnique({
      where: { id: "singleton" },
      select: { autonomyMode: true },
    });
    if (state) {
      policyInfo.autonomyMode = state.autonomyMode;
    }
  } catch {
    // ignore
  }

  // --- Build the memory report ---
  const recordsRetrieved =
    (workingMemory ? 1 : 0) +
    episodicMemory.length +
    semanticMemory.length +
    strategyStats.length +
    modelStats.length +
    1; // policy info

  const estimatedMemoryTokens =
    estimateObjectTokens(workingMemory) +
    estimateObjectTokens(episodicMemory) +
    estimateObjectTokens(semanticMemory) +
    estimateObjectTokens(strategyStats) +
    estimateObjectTokens(modelStats) +
    estimateObjectTokens(policyInfo);

  // --- Budget enforcement: truncate if over limit ---
  let budgetExceeded = false;
  let truncated = false;
  let finalContextTokens = estimatedMemoryTokens;

  if (estimatedMemoryTokens > MAX_MEMORY_TOKENS) {
    budgetExceeded = true;
    truncated = true;

    // Truncation strategy: reduce episodic memory first (least critical),
    // then semantic memory, then model stats.
    while (finalContextTokens > MAX_MEMORY_TOKENS && episodicMemory.length > 0) {
      episodicMemory.pop();
      finalContextTokens = recalculateTokens(
        workingMemory,
        episodicMemory,
        semanticMemory,
        strategyStats,
        modelStats,
        policyInfo
      );
    }
    while (finalContextTokens > MAX_MEMORY_TOKENS && semanticMemory.length > 0) {
      semanticMemory.pop();
      finalContextTokens = recalculateTokens(
        workingMemory,
        episodicMemory,
        semanticMemory,
        strategyStats,
        modelStats,
        policyInfo
      );
    }
    while (finalContextTokens > MAX_MEMORY_TOKENS && modelStats.length > 0) {
      modelStats.pop();
      finalContextTokens = recalculateTokens(
        workingMemory,
        episodicMemory,
        semanticMemory,
        strategyStats,
        modelStats,
        policyInfo
      );
    }

    await logEvent(
      "model_router",
      "warn",
      "memory_context_truncated",
      {
        estimatedTokens: estimatedMemoryTokens,
        finalTokens: finalContextTokens,
        maxTokens: MAX_MEMORY_TOKENS,
        truncatedEpisodic: episodicMemory.length,
        truncatedSemantic: semanticMemory.length,
        truncatedModelStats: modelStats.length,
      },
      {}
    );
  }

  // Get total record count (for monitoring — proves bounded context).
  const memoryRecordsTotal = await getTotalRecordCount();

  const report: MemoryReport = {
    memoryRecordsTotal,
    recordsRetrieved,
    estimatedMemoryTokens,
    finalContextTokens,
    budgetExceeded,
    truncated,
    tiers: {
      working: workingMemory ? 1 : 0,
      episodic: episodicMemory.length,
      semantic: semanticMemory.length,
      strategyStats: strategyStats.length,
      modelStats: modelStats.length,
      policy: 1,
    },
  };

  return {
    workingMemory,
    episodicMemory,
    semanticMemory,
    strategyStats,
    modelStats,
    policyInfo,
    report,
  };
}

function recalculateTokens(
  working: WorkingMemoryEntry | null,
  episodic: EpisodicEntry[],
  semantic: SemanticEntry[],
  strategy: StrategyStatSummary[],
  model: ModelStatSummary[],
  policy: PolicyInfo
): number {
  return (
    estimateObjectTokens(working) +
    estimateObjectTokens(episodic) +
    estimateObjectTokens(semantic) +
    estimateObjectTokens(strategy) +
    estimateObjectTokens(model) +
    estimateObjectTokens(policy)
  );
}

// ---------------------------------------------------------------------------
// serializeForLLM — convert the memory context to a compact string
// ---------------------------------------------------------------------------

/**
 * Convert the memory context to a compact string suitable for inclusion
 * in an LLM system prompt. This is the ONLY data the LLM sees from the
 * database — it never sees raw records.
 */
export function serializeForLLM(ctx: MemoryContext): string {
  const parts: string[] = [];

  // Working memory
  if (ctx.workingMemory) {
    parts.push(
      `## Current Task\n` +
      `- Task: ${ctx.workingMemory.taskId}\n` +
      `- Agent: ${ctx.workingMemory.agentName}\n` +
      `- Status: ${ctx.workingMemory.status}\n` +
      `- Iteration: v${ctx.workingMemory.iterationCount}\n` +
      `- Model: ${ctx.workingMemory.modelId ?? "unselected"}\n` +
      `- Objective: ${ctx.workingMemory.objective.slice(0, 200)}\n` +
      `- Opportunity: ${ctx.workingMemory.opportunityTitle.slice(0, 100)} (${ctx.workingMemory.opportunityCategory})`
    );
  }

  // Episodic memory
  if (ctx.episodicMemory.length > 0) {
    parts.push(
      `## Recent Tasks (same opportunity/strategy)\n` +
      ctx.episodicMemory
        .map(
          (e) =>
            `- [${e.status}] ${e.agentName} → ${e.objective.slice(0, 80)} (q=${e.qualityScore ?? "—"}, model=${e.modelId ?? "—"})`
        )
        .join("\n")
    );
  }

  // Semantic memory
  if (ctx.semanticMemory.length > 0) {
    parts.push(
      `## Lessons Learned\n` +
      ctx.semanticMemory
        .map(
          (s) =>
            `- [${s.category}] (${(s.confidence * 100).toFixed(0)}% confidence) ${s.title}: ${s.body.slice(0, 150)}`
        )
        .join("\n")
    );
  }

  // Strategy statistics
  if (ctx.strategyStats.length > 0) {
    parts.push(
      `## Strategy Statistics\n` +
      ctx.strategyStats
        .map(
          (s) =>
            `- ${s.strategy}: ${s.completed}/${s.attempted} done (${(s.successRate * 100).toFixed(0)}% success), $${s.totalNetUsd.toFixed(2)} net, $${s.avgHourly.toFixed(2)}/hr`
        )
        .join("\n")
    );
  }

  // Model statistics
  if (ctx.modelStats.length > 0) {
    parts.push(
      `## Model Performance (${ctx.modelStats[0]?.taskType ?? "unknown"})\n` +
      ctx.modelStats
        .map(
          (m) =>
            `- ${m.modelId}: ${m.successes}/${m.attempts} (${(m.successRate * 100).toFixed(0)}% success, q=${m.avgQuality.toFixed(1)}, ${m.avgLatencyMs}ms)`
        )
        .join("\n")
    );
  }

  // Policy info
  parts.push(
    `## Policy\n` +
    `- Autonomy: ${ctx.policyInfo.autonomyMode}\n` +
    `- Capital required: ${ctx.policyInfo.capitalRequired ? "YES — requires approval" : "No"}\n` +
    `- Max iterations: ${ctx.policyInfo.maxIterations}\n` +
    `- Risk threshold: ${ctx.policyInfo.riskScoreThreshold}`
  );

  // Memory report
  parts.push(
    `## Memory Report\n` +
    `- Total DB records: ${ctx.report.memoryRecordsTotal.toLocaleString()}\n` +
    `- Records retrieved: ${ctx.report.recordsRetrieved}\n` +
    `- Estimated tokens: ${ctx.report.estimatedMemoryTokens}\n` +
    `- Final tokens: ${ctx.report.finalContextTokens}${ctx.report.truncated ? " (TRUNCATED)" : ""}\n` +
    `- Budget: ${ctx.report.budgetExceeded ? "EXCEEDED" : "OK"} (${MAX_MEMORY_TOKENS} max)`
  );

  return parts.join("\n\n");
}
