// AgentMemory service — cross-cycle "lessons learned" (spec §17, Phase-2 P3-2).
//
// The agent records generalizable insights it discovers during execution:
//   - which approaches worked for which strategy/category
//   - which models perform best for which task types
//   - which sources tend to be reliable vs scam-prone
//   - common scam patterns to watch for
//   - execution lessons (e.g. "PRs with tests merge 3x faster")
//
// These memories are retrieved on future similar tasks to bias the agent's
// decisions toward proven approaches + away from known-bad ones. The
// `confidence` field grows with corroborating evidence; `timesApplied`
// tracks how often a lesson has been referenced.
//
// Memories are NEVER dumped wholesale into the LLM context — the retrieval
// functions return only the top-N most-relevant memories for the current task.

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryCategory =
  | "strategy_insight"
  | "model_performance"
  | "source_reliability"
  | "scam_pattern"
  | "execution_lesson"
  | "general";

export interface AgentMemoryEntry {
  id: string;
  category: MemoryCategory;
  title: string;
  body: string;
  payload?: Record<string, unknown> | null;
  tags: string[];
  confidence: number; // 0..1
  timesApplied: number;
  superseded: boolean;
  opportunityId?: string | null;
  agent: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecordMemoryInput {
  category: MemoryCategory;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  tags?: string[];
  confidence?: number;
  opportunityId?: string;
  agent: string;
}

export interface RetrieveMemoryOpts {
  category?: MemoryCategory;
  tags?: string[]; // any-tag match (OR)
  query?: string; // substring match on title/body
  limit?: number;
  minConfidence?: number;
  includeSuperseded?: boolean;
}

// ---------------------------------------------------------------------------
// Row → typed entry
// ---------------------------------------------------------------------------

function rowToEntry(row: {
  id: string;
  category: string;
  title: string;
  body: string;
  payload: string | null;
  tags: string;
  confidence: number;
  timesApplied: number;
  superseded: boolean;
  opportunityId: string | null;
  agent: string;
  createdAt: Date;
  updatedAt: Date;
}): AgentMemoryEntry {
  let payload: Record<string, unknown> | null = null;
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags);
    if (Array.isArray(parsed)) {
      tags = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    category: row.category as MemoryCategory,
    title: row.title,
    body: row.body,
    payload,
    tags,
    confidence: row.confidence ?? 0.5,
    timesApplied: row.timesApplied ?? 0,
    superseded: row.superseded ?? false,
    opportunityId: row.opportunityId,
    agent: row.agent,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Record a memory
// ---------------------------------------------------------------------------

/**
 * Record a new agent memory. If a memory with the same title + category
 * already exists, the existing one's confidence is bumped + the body is
 * updated (corroborating evidence). Returns the memory entry.
 */
export async function recordMemory(
  input: RecordMemoryInput
): Promise<AgentMemoryEntry | null> {
  try {
    const tags = Array.isArray(input.tags) ? input.tags : [];
    const payload = input.payload ? JSON.stringify(input.payload) : null;
    const confidence = Math.max(0, Math.min(1, input.confidence ?? 0.5));

    // Check for an existing memory with the same title + category.
    const existing = await db.agentMemory.findFirst({
      where: {
        category: input.category,
        title: input.title,
        superseded: false,
      },
    });

    if (existing) {
      // Bump confidence (corroborating evidence). The EMA factor 0.3 means
      // new evidence shifts the confidence 30% toward the new value.
      const newConfidence = Math.max(
        0,
        Math.min(1, existing.confidence * 0.7 + confidence * 0.3)
      );
      const updated = await db.agentMemory.update({
        where: { id: existing.id },
        data: {
          body: input.body,
          payload: payload ?? existing.payload,
          tags: JSON.stringify(
            Array.from(new Set([...tags, ...JSON.parse(existing.tags || "[]")]))
          ),
          confidence: newConfidence,
          updatedAt: new Date(),
        },
      });
      return rowToEntry(updated);
    }

    const created = await db.agentMemory.create({
      data: {
        category: input.category,
        title: input.title,
        body: input.body,
        payload,
        tags: JSON.stringify(tags),
        confidence,
        opportunityId: input.opportunityId,
        agent: input.agent,
      },
    });
    return rowToEntry(created);
  } catch (err) {
    console.error("[memory] recordMemory failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Retrieve memories
// ---------------------------------------------------------------------------

/**
 * Retrieve the most-relevant memories for the current task. NEVER returns
 * all memories — always capped at `limit` (default 5) to keep the LLM
 * context small.
 */
export async function retrieveMemories(
  opts: RetrieveMemoryOpts = {}
): Promise<AgentMemoryEntry[]> {
  try {
    const limit = Math.min(20, Math.max(1, opts.limit ?? 5));
    const minConfidence = opts.minConfidence ?? 0.3;

    const where: Record<string, unknown> = {};
    if (opts.category) where.category = opts.category;
    if (!opts.includeSuperseded) where.superseded = false;
    where.confidence = { gte: minConfidence };

    if (opts.tags && opts.tags.length > 0) {
      // SQLite doesn't have a clean array-contains operator on a JSON string
      // column, so we do a per-tag LIKE filter (OR-ed).
      where.OR = opts.tags.map((t) => ({
        tags: { contains: `"${t}"` },
      }));
    }

    if (opts.query) {
      const q = opts.query;
      where.AND = [
        {
          OR: [
            { title: { contains: q } },
            { body: { contains: q } },
          ],
        },
      ];
    }

    const rows = await db.agentMemory.findMany({
      where: where as never,
      orderBy: [{ confidence: "desc" }, { timesApplied: "desc" }, { createdAt: "desc" }],
      take: limit,
    });

    return rows.map(rowToEntry);
  } catch (err) {
    console.error("[memory] retrieveMemories failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Mark a memory as applied (increments timesApplied)
// ---------------------------------------------------------------------------

export async function markMemoryApplied(memoryId: string): Promise<void> {
  try {
    await db.agentMemory.update({
      where: { id: memoryId },
      data: {
        timesApplied: { increment: 1 },
        updatedAt: new Date(),
      },
    });
  } catch (err) {
    console.error("[memory] markMemoryApplied failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Supersede a memory (mark it as out-of-date)
// ---------------------------------------------------------------------------

export async function supersedeMemory(
  memoryId: string,
  reason?: string
): Promise<void> {
  try {
    await db.agentMemory.update({
      where: { id: memoryId },
      data: {
        superseded: true,
        body: reason ? `${(await db.agentMemory.findUnique({ where: { id: memoryId }, select: { body: true } }))?.body ?? ""}\n\n[SUPERSEDED: ${reason}]` : undefined,
        updatedAt: new Date(),
      },
    });
    await logEvent(
      "orchestrator",
      "info",
      "memory_superseded",
      { memoryId, reason },
      {}
    );
  } catch (err) {
    console.error("[memory] supersedeMemory failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Get all memories (for the dashboard)
// ---------------------------------------------------------------------------

export async function getAllMemories(
  opts: { category?: MemoryCategory; limit?: number } = {}
): Promise<{ memories: AgentMemoryEntry[]; total: number }> {
  try {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const where: Record<string, unknown> = {};
    if (opts.category) where.category = opts.category;

    const [rows, total] = await Promise.all([
      db.agentMemory.findMany({
        where: where as never,
        orderBy: [{ createdAt: "desc" }],
        take: limit,
      }),
      db.agentMemory.count({ where: where as never }),
    ]);

    return { memories: rows.map(rowToEntry), total };
  } catch (err) {
    console.error("[memory] getAllMemories failed:", err);
    return { memories: [], total: 0 };
  }
}

// ---------------------------------------------------------------------------
// Memory summary (for the dashboard + analytics)
// ---------------------------------------------------------------------------

export async function getMemorySummary(): Promise<{
  total: number;
  active: number;
  superseded: number;
  byCategory: Record<string, number>;
  avgConfidence: number;
  topApplied: AgentMemoryEntry[];
}> {
  try {
    const [total, active, superseded, byCategoryRows, avgConfidenceAgg, topApplied] =
      await Promise.all([
        db.agentMemory.count(),
        db.agentMemory.count({ where: { superseded: false } }),
        db.agentMemory.count({ where: { superseded: true } }),
        db.agentMemory.groupBy({ by: ["category"], _count: true }),
        db.agentMemory.aggregate({ _avg: { confidence: true } }),
        db.agentMemory.findMany({
          orderBy: [{ timesApplied: "desc" }, { confidence: "desc" }],
          take: 5,
        }),
      ]);

    const byCategory: Record<string, number> = {};
    for (const r of byCategoryRows) {
      byCategory[r.category] = r._count;
    }

    return {
      total,
      active,
      superseded,
      byCategory,
      avgConfidence: avgConfidenceAgg._avg.confidence ?? 0,
      topApplied: topApplied.map(rowToEntry),
    };
  } catch (err) {
    console.error("[memory] getMemorySummary failed:", err);
    return {
      total: 0,
      active: 0,
      superseded: 0,
      byCategory: {},
      avgConfidence: 0,
      topApplied: [],
    };
  }
}
