// Shared types for specialist agents (spec §4B, §4M).
//
// Every specialist agent exports an `execute(input: AgentInput): Promise<AgentOutput>`
// function with this exact shape. The orchestrator is the ONLY component that
// creates Task rows; agents execute them and report back via `AgentOutput`.
//
// Design rules (spec §28, §29, §30):
//   - NEVER throw out of an agent — always catch and return
//     `{ success: false, result: { error } }`.
//   - Every significant transition is logged via `logEvent`.
//   - Every external action is wrapped in an `IdempotencyRecord` (spec §30).
//   - The orchestrator owns task lifecycle; agents own their specialist work.

import type { AgentName } from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// Agent I/O contract (spec §4M handoff protocol)
// ---------------------------------------------------------------------------

export interface AgentInput {
  /**
   * The DB Opportunity row (or a partial superset) — agents read only the
   * fields they need. The orchestrator is responsible for loading the
   * opportunity and passing it in.
   */
  opportunity?: Record<string, unknown>;
  /**
   * The DB Task row (if this agent was invoked via a Task handoff). Carries
   * `id`, `fromAgent`, `toAgent`, `objective`, `input`, `riskLevel`,
   * `executionLevel`, `modelId` etc. — used by the agent for audit-trail
   * linkage via `logEvent` opts.
   */
  task?: Record<string, unknown>;
  /**
   * Free-form context bag the orchestrator passes in. Each agent documents
   * the keys it expects here. Examples:
   *   - research: `{ priorFindings?: ResearchFindings }`
   *   - coding: `{ repoContext?: string; language?: string }`
   *   - execution: `{ action: string; approvalId?: string }`
   */
  context?: Record<string, unknown>;
}

export interface AgentOutput {
  /** True when the agent completed its specialist work successfully. */
  success: boolean;
  /** Structured result — shape varies per agent. Always includes `error`
   *  string when `success === false`. */
  result: Record<string, unknown>;
  /** Optional 0..10 quality score (used by the Review Agent + budget tracker). */
  qualityScore?: number;
  /** Human-readable caveats the orchestrator should consider. */
  notes?: string[];
  /** Suggested next specialist (orchestrator makes the final decision). */
  nextAgent?: AgentName;
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/** Build a success AgentOutput. */
export function ok(
  result: Record<string, unknown>,
  opts?: { qualityScore?: number; notes?: string[]; nextAgent?: AgentName }
): AgentOutput {
  return {
    success: true,
    result,
    qualityScore: opts?.qualityScore,
    notes: opts?.notes,
    nextAgent: opts?.nextAgent,
  };
}

/** Build a failure AgentOutput. Never throws. */
export function fail(
  error: string,
  extra?: Record<string, unknown>
): AgentOutput {
  return {
    success: false,
    result: { error, ...(extra ?? {}) },
  };
}

/** Safely extract a string field from a possibly-partial record. */
export function fieldString(
  obj: Record<string, unknown> | undefined,
  key: string,
  fallback = ""
): string {
  if (!obj) return fallback;
  const v = obj[key];
  return typeof v === "string" ? v : fallback;
}

/** Safely extract a number field from a possibly-partial record. */
export function fieldNumber(
  obj: Record<string, unknown> | undefined,
  key: string,
  fallback = 0
): number {
  if (!obj) return fallback;
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Safely extract a string-array field from a possibly-partial record. */
export function fieldStringArray(
  obj: Record<string, unknown> | undefined,
  key: string
): string[] {
  if (!obj) return [];
  const v = obj[key];
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string");
  }
  // Some persisted rows store arrays as JSON strings.
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      // ignore
    }
  }
  return [];
}
