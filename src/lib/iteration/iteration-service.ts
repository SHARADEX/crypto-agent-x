// Iteration service (Phase 3 §7, §8, §9, §10, §12, §27-§30).
//
// This module is the data layer for the iterative human-approval workflow.
// It owns the `TaskIteration` rows: creating them, recording results,
// superseding prior iterations, computing iteration economics, and running
// the quality gate checks.
//
// Lifecycle:
//   v0  created when a Task is first dispatched (the orchestrator calls
//       `createIteration(taskId)` with no feedback). The artifact is
//       populated by `recordIterationResult` once the deliverable specialist
//       finishes.
//   v1+ created when the operator picks "improve" / "rework" /
//       "request_changes" on the prior iteration's Approval row. The
//       `feedbackId` links back to the Approval row that triggered the
//       iteration. The improvement planner runs before the new iteration
//       is dispatched so the deliverable specialist sees both the prior
//       artifact AND the structured feedback.
//
// Quality gate (Phase 3 §12) — every iteration can be run through
// `getQualityGate(iterationId)`, which returns PASS/WARN/FAIL on four
// checks: functionality (tests pass), security (safety.safe), requirements
// (deliverable matches opportunity requirements), economic (expected
// value > 0).
//
// NEVER throws — every function returns a structured result object so API
// handlers can surface errors without crashing.

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
// Phase-3 DEV-REVIEW-6 (#3): static import for the `diff` library (was
// loaded via `require()` before — the static import enables tree-shaking
// + gives us proper TypeScript types via @types/diff).
import { diffLines } from "diff";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A snapshot of the artifact produced by one iteration of a Task. */
export interface IterationArtifact {
  approach: string;
  files: Array<{
    path: string;
    language: string;
    content: string;
    safety?: {
      safe: boolean;
      riskScore: number;
      findings: Array<{ id: string; severity: string; detail: string }>;
    };
  }>;
  tests: Array<{ path: string; framework: string; content: string }>;
  diff?: string;
  safety?: {
    safe: boolean;
    riskScore: number;
    findings: Array<{ id: string; severity: string; detail: string }>;
  };
  testsPassed?: boolean;
  testResults?: {
    framework: string;
    passed: number;
    failed: number;
    ok: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    iterations: number;
  };
  model?: string;
  [k: string]: unknown;
}

/** Result row returned by every iteration-service function. */
export interface IterationResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface IterationRow {
  id: string;
  taskId: string;
  iterationNumber: number;
  version: string;
  artifactJson: string;
  feedbackId: string | null;
  feedbackText: string | null;
  feedbackType: string | null;
  feedbackPriority: string | null;
  modelId: string | null;
  agentName: string | null;
  qualityScore: number | null;
  testResults: string | null;
  securityResults: string | null;
  status: string;
  tokensUsed: number;
  timeSpentMs: number;
  estimatedValueAdded: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface IterationEconomics {
  expectedValueBefore: number;
  expectedValueAfter: number;
  incrementalExpectedValue: number;
  additionalTimeMs: number;
  incrementalHourlyReturnUsd: number;
  recommendation: "worth_it" | "marginal" | "not_worth_it";
  reason: string;
}

export interface QualityGateCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface QualityGateResult {
  checks: QualityGateCheck[];
  overall: "pass" | "warn" | "fail";
}

export interface CreateIterationInput {
  taskId: string;
  feedbackId?: string;
  feedbackText?: string;
  feedbackType?: string;
  feedbackPriority?: string;
  modelId?: string;
  agentName?: string;
  /** The initial artifact to seed the iteration with. v0 is allowed to be
   *  empty (the agent will populate it via `recordIterationResult`). */
  artifact?: IterationArtifact;
}

export interface RecordIterationResultInput {
  iterationId: string;
  artifact: IterationArtifact;
  testResults?: Record<string, unknown>;
  securityResults?: Record<string, unknown>;
  qualityScore?: number;
  tokensUsed?: number;
  timeSpentMs?: number;
  estimatedValueAdded?: number;
  modelId?: string;
  agentName?: string;
  status?: string;
}

export interface CompareIterationsResult {
  versionA: string;
  versionB: string;
  filesAdded: string[];
  filesRemoved: string[];
  filesChanged: Array<{ path: string; beforeLines: number; afterLines: number }>;
  /**
   * Phase-3 dev-review #2: per-file line-level diff. Each entry contains
   * the file path + a list of diff hunks (added/removed/context lines).
   * Empty unless the caller passes `includeLineDiffs: true` to
   * `compareIterations` (the line-diff computation is O(n) per file and
   * is skipped by default for the lightweight summary view).
   */
  fileDiffs?: Array<{
    path: string;
    hunks: Array<{
      type: "added" | "removed" | "context";
      lineNo: number;
      text: string;
    }>;
  }>;
  qualityDelta: number;
  testResultsDelta: { passedDelta: number; failedDelta: number };
  safetyDelta: number;
  notes: string[];
}

// ---------------------------------------------------------------------------
// createIteration
// ---------------------------------------------------------------------------

/**
 * Create a new TaskIteration for the given task. Increments the Task's
 * `iterationCount`, links to the prior iteration's artifact as the
 * starting point (if any), and marks the prior iteration as superseded.
 *
 * Phase 3 §7: each iteration carries the feedback that triggered it (or
 * null for v0) + the model/agent that will produce the new artifact.
 *
 * NEVER throws — returns `{ ok: false, error }` on failure.
 */
export async function createIteration(
  input: CreateIterationInput
): Promise<IterationResult<IterationRow>> {
  try {
    if (!input.taskId) {
      return { ok: false, error: "taskId is required" };
    }

    const task = await db.task.findUnique({
      where: { id: input.taskId },
      select: {
        id: true,
        iterationCount: true,
        maxIterations: true,
        currentIterationId: true,
        toAgent: true,
        modelId: true,
        opportunityId: true,
      },
    });
    if (!task) {
      return { ok: false, error: `Task ${input.taskId} not found` };
    }

    const nextNumber = (task.iterationCount ?? 0) + 0; // v0 starts at 0
    // For v0 (no currentIterationId), iterationNumber = 0; otherwise
    // prior + 1.
    const iterationNumber = task.currentIterationId ? nextNumber + 1 : 0;
    const version = `v${iterationNumber}`;

    // If this is v1+, mark the prior iteration as superseded.
    if (task.currentIterationId) {
      await markIterationSuperseded(task.currentIterationId);
    }

    const artifactJson = JSON.stringify(input.artifact ?? emptyArtifact());
    const row = await db.taskIteration.create({
      data: {
        taskId: input.taskId,
        iterationNumber,
        version,
        artifactJson,
        feedbackId: input.feedbackId ?? null,
        feedbackText: input.feedbackText ?? null,
        feedbackType: input.feedbackType ?? null,
        feedbackPriority: input.feedbackPriority ?? null,
        modelId: input.modelId ?? task.modelId ?? null,
        agentName: input.agentName ?? task.toAgent ?? null,
        status: "created",
      },
    });

    await db.task.update({
      where: { id: input.taskId },
      data: {
        iterationCount: iterationNumber,
        currentIterationId: row.id,
      },
    });

    await logEvent(
      "orchestrator",
      "info",
      "iteration_created",
      {
        taskId: input.taskId,
        opportunityId: task.opportunityId ?? null,
        iterationId: row.id,
        iterationNumber,
        version,
        feedbackId: input.feedbackId ?? null,
        feedbackType: input.feedbackType ?? null,
        feedbackPriority: input.feedbackPriority ?? null,
      },
      task.opportunityId
        ? { opportunityId: task.opportunityId, taskId: input.taskId }
        : { taskId: input.taskId }
    );

    return { ok: true, data: rowToIteration(row) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[iteration-service] createIteration failed:", err);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// getIterations / getLatestIteration / getIterationByVersion
// ---------------------------------------------------------------------------

export async function getIterations(
  taskId: string
): Promise<IterationResult<IterationRow[]>> {
  try {
    if (!taskId) return { ok: false, error: "taskId is required" };
    const rows = await db.taskIteration.findMany({
      where: { taskId },
      orderBy: { iterationNumber: "asc" },
    });
    return { ok: true, data: rows.map(rowToIteration) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[iteration-service] getIterations failed:", err);
    return { ok: false, error: msg };
  }
}

export async function getLatestIteration(
  taskId: string
): Promise<IterationResult<IterationRow | null>> {
  try {
    if (!taskId) return { ok: false, error: "taskId is required" };
    const row = await db.taskIteration.findFirst({
      where: { taskId },
      orderBy: { iterationNumber: "desc" },
    });
    return { ok: true, data: row ? rowToIteration(row) : null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[iteration-service] getLatestIteration failed:", err);
    return { ok: false, error: msg };
  }
}

export async function getIterationByVersion(
  taskId: string,
  version: string
): Promise<IterationResult<IterationRow | null>> {
  try {
    if (!taskId) return { ok: false, error: "taskId is required" };
    if (!version) return { ok: false, error: "version is required" };
    const row = await db.taskIteration.findFirst({
      where: { taskId, version },
      orderBy: { iterationNumber: "desc" },
    });
    return { ok: true, data: row ? rowToIteration(row) : null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[iteration-service] getIterationByVersion failed:", err);
    return { ok: false, error: msg };
  }
}

export async function getIterationById(
  iterationId: string
): Promise<IterationResult<IterationRow | null>> {
  try {
    if (!iterationId) return { ok: false, error: "iterationId is required" };
    const row = await db.taskIteration.findUnique({
      where: { id: iterationId },
    });
    return { ok: true, data: row ? rowToIteration(row) : null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[iteration-service] getIterationById failed:", err);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// compareIterations
// ---------------------------------------------------------------------------

export async function compareIterations(
  taskId: string,
  versionA: string,
  versionB: string,
  opts?: { includeLineDiffs?: boolean }
): Promise<IterationResult<CompareIterationsResult>> {
  try {
    if (!taskId) return { ok: false, error: "taskId is required" };
    if (!versionA || !versionB) {
      return { ok: false, error: "versionA and versionB are required" };
    }
    const a = await getIterationByVersion(taskId, versionA);
    const b = await getIterationByVersion(taskId, versionB);
    if (!a.ok || !a.data) return { ok: false, error: `version ${versionA} not found` };
    if (!b.ok || !b.data) return { ok: false, error: `version ${versionB} not found` };

    const artifactA = parseArtifact(a.data.artifactJson);
    const artifactB = parseArtifact(b.data.artifactJson);

    const filesA = new Map(artifactA.files.map((f) => [f.path, f]));
    const filesB = new Map(artifactB.files.map((f) => [f.path, f]));

    const filesAdded: string[] = [];
    const filesRemoved: string[] = [];
    const filesChanged: Array<{ path: string; beforeLines: number; afterLines: number }> = [];

    for (const [path, fileB] of filesB) {
      if (!filesA.has(path)) filesAdded.push(path);
    }
    for (const [path, fileA] of filesA) {
      if (!filesB.has(path)) filesRemoved.push(path);
    }
    for (const [path, fileA] of filesA) {
      const fileB = filesB.get(path);
      if (!fileB) continue;
      if (fileA.content !== fileB.content) {
        filesChanged.push({
          path,
          beforeLines: countLines(fileA.content),
          afterLines: countLines(fileB.content),
        });
      }
    }

    // Phase-3 dev-review #2: compute line-level diffs for changed files.
    // Only runs when the caller passes `includeLineDiffs: true` (the
    // dashboard's "Show line diff" toggle in the Compare dialog).
    let fileDiffs: CompareIterationsResult["fileDiffs"] | undefined;
    if (opts?.includeLineDiffs) {
      fileDiffs = [];
      for (const changed of filesChanged) {
        const fileA = filesA.get(changed.path);
        const fileB = filesB.get(changed.path);
        if (!fileA || !fileB) continue;
        const hunks = computeLineDiff(fileA.content, fileB.content);
        fileDiffs.push({ path: changed.path, hunks });
      }
    }

    const qualityA = a.data.qualityScore ?? 0;
    const qualityB = b.data.qualityScore ?? 0;
    const safetyA = artifactA.safety?.riskScore ?? 0;
    const safetyB = artifactB.safety?.riskScore ?? 0;

    const testA = parseTestResults(a.data.testResults);
    const testB = parseTestResults(b.data.testResults);

    const notes: string[] = [];
    if (filesAdded.length > 0) notes.push(`${filesAdded.length} file(s) added`);
    if (filesRemoved.length > 0) notes.push(`${filesRemoved.length} file(s) removed`);
    if (filesChanged.length > 0) notes.push(`${filesChanged.length} file(s) changed`);
    if (qualityB > qualityA) notes.push(`quality improved +${(qualityB - qualityA).toFixed(1)}`);
    if (qualityB < qualityA) notes.push(`quality regressed -${(qualityA - qualityB).toFixed(1)}`);
    if (safetyB < safetyA) notes.push(`safety risk reduced`);
    if (safetyB > safetyA) notes.push(`safety risk increased`);

    return {
      ok: true,
      data: {
        versionA,
        versionB,
        filesAdded,
        filesRemoved,
        filesChanged,
        fileDiffs,
        qualityDelta: qualityB - qualityA,
        testResultsDelta: {
          passedDelta: (testB.passed ?? 0) - (testA.passed ?? 0),
          failedDelta: (testB.failed ?? 0) - (testA.failed ?? 0),
        },
        safetyDelta: safetyB - safetyA,
        notes,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[iteration-service] compareIterations failed:", err);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// canIterate
// ---------------------------------------------------------------------------

/**
 * Check whether a task can accept another iteration. Returns false when the
 * task's `iterationCount` has reached its `maxIterations` cap.
 *
 * Phase 3 §10: the cap exists so a stuck deliverable doesn't loop forever
 * burning tokens.
 */
export async function canIterate(
  taskId: string
): Promise<IterationResult<{ canIterate: boolean; iterationCount: number; maxIterations: number; remaining: number }>> {
  try {
    if (!taskId) return { ok: false, error: "taskId is required" };
    const task = await db.task.findUnique({
      where: { id: taskId },
      select: { iterationCount: true, maxIterations: true },
    });
    if (!task) return { ok: false, error: `Task ${taskId} not found` };
    const iterationCount = task.iterationCount ?? 0;
    const maxIterations = task.maxIterations ?? 6;
    const remaining = Math.max(0, maxIterations - iterationCount);
    return {
      ok: true,
      data: {
        canIterate: remaining > 0,
        iterationCount,
        maxIterations,
        remaining,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[iteration-service] canIterate failed:", err);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// recordIterationResult
// ---------------------------------------------------------------------------

export async function recordIterationResult(
  input: RecordIterationResultInput
): Promise<IterationResult<IterationRow>> {
  try {
    if (!input.iterationId) {
      return { ok: false, error: "iterationId is required" };
    }
    const existing = await db.taskIteration.findUnique({
      where: { id: input.iterationId },
      select: { id: true, taskId: true, iterationNumber: true, version: true },
    });
    if (!existing) {
      return { ok: false, error: `Iteration ${input.iterationId} not found` };
    }

    const updated = await db.taskIteration.update({
      where: { id: input.iterationId },
      data: {
        artifactJson: JSON.stringify(input.artifact),
        testResults: input.testResults ? JSON.stringify(input.testResults) : null,
        securityResults: input.securityResults
          ? JSON.stringify(input.securityResults)
          : null,
        qualityScore: input.qualityScore ?? null,
        tokensUsed: input.tokensUsed ?? 0,
        timeSpentMs: input.timeSpentMs ?? 0,
        estimatedValueAdded: input.estimatedValueAdded ?? 0,
        modelId: input.modelId ?? null,
        agentName: input.agentName ?? null,
        status: input.status ?? "reviewed",
      },
    });

    await logEvent(
      "orchestrator",
      "info",
      "iteration_result_recorded",
      {
        taskId: existing.taskId,
        iterationId: input.iterationId,
        version: existing.version,
        qualityScore: input.qualityScore ?? null,
        tokensUsed: input.tokensUsed ?? 0,
        timeSpentMs: input.timeSpentMs ?? 0,
        status: input.status ?? "reviewed",
      },
      { taskId: existing.taskId }
    );

    return { ok: true, data: rowToIteration(updated) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[iteration-service] recordIterationResult failed:", err);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// markIterationSuperseded
// ---------------------------------------------------------------------------

export async function markIterationSuperseded(
  iterationId: string
): Promise<IterationResult<{ id: string; status: string }>> {
  try {
    if (!iterationId) return { ok: false, error: "iterationId is required" };
    const updated = await db.taskIteration.update({
      where: { id: iterationId },
      data: { status: "superseded" },
      select: { id: true, status: true },
    });
    return { ok: true, data: updated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[iteration-service] markIterationSuperseded failed:", err);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// getIterationEconomics (Phase 3 §10)
// ---------------------------------------------------------------------------

/**
 * Compute whether another iteration is economically worth doing.
 *
 * Compares the expected value of the current artifact against the expected
 * value of a hypothetical improved artifact, weighing the incremental gain
 * against the additional time + tokens required for another round.
 *
 * Returns a recommendation:
 *   - "worth_it"     — incremental value clearly outweighs the cost
 *   - "marginal"     — incremental value is positive but close to the cost
 *   - "not_worth_it" — another iteration would lose money or hit the cap
 *
 * The economics are intentionally simple + conservative — this is a sanity
 * check, not a market model.
 */
export async function getIterationEconomics(
  taskId: string
): Promise<IterationResult<IterationEconomics>> {
  try {
    if (!taskId) return { ok: false, error: "taskId is required" };

    const task = await db.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        opportunityId: true,
        iterationCount: true,
        maxIterations: true,
        currentIterationId: true,
      },
    });
    if (!task) return { ok: false, error: `Task ${taskId} not found` };

    // Opportunity context — reward ceiling.
    let rewardUsd = 0;
    let expectedValueBefore = 0;
    if (task.opportunityId) {
      const op = await db.opportunity.findUnique({
        where: { id: task.opportunityId },
        select: { rewardUsd: true, expectedValue: true, riskScore: true },
      });
      if (op) {
        rewardUsd = op.rewardUsd;
        expectedValueBefore = op.expectedValue;
      }
    }

    // The prior iteration's quality + tokens inform the projection.
    let priorQuality = 0.5;
    let priorTokens = 0;
    let priorTimeMs = 0;
    let priorValueAdded = 0;
    if (task.currentIterationId) {
      const prior = await db.taskIteration.findUnique({
        where: { id: task.currentIterationId },
        select: {
          qualityScore: true,
          tokensUsed: true,
          timeSpentMs: true,
          estimatedValueAdded: true,
        },
      });
      if (prior) {
        priorQuality = (prior.qualityScore ?? 5) / 10; // 0..1
        priorTokens = prior.tokensUsed ?? 0;
        priorTimeMs = prior.timeSpentMs ?? 0;
        priorValueAdded = prior.estimatedValueAdded ?? 0;
      }
    }

    // Heuristic projection: each iteration closes ~30% of the remaining gap
    // to the reward ceiling. So if priorQuality=0.5 (quality 5/10), the
    // expected quality after one more iteration is ~0.65.
    const gap = 1 - priorQuality;
    const projectedQualityAfter = Math.min(1, priorQuality + gap * 0.3);
    const projectedValueAfter = rewardUsd * projectedQualityAfter;
    const expectedValueAfter = Math.max(
      projectedValueAfter,
      expectedValueBefore + priorValueAdded
    );

    // Cost of another iteration: assume tokens/time grow ~30% over prior
    // (improvement is harder than greenfield).
    const additionalTokens = Math.round(priorTokens * 1.3) || 5000;
    const additionalTimeMs = Math.round(priorTimeMs * 1.3) || 60_000;
    const incrementalExpectedValue = Math.max(
      0,
      expectedValueAfter - (expectedValueBefore + priorValueAdded)
    );

    // Token cost: $0 (the whole system runs on free-tier LLMs — spec §0),
    // so the only "cost" is time. Convert time to USD at a conservative
    // $30/hr opportunity cost so the recommendation has units.
    const additionalHours = additionalTimeMs / 3_600_000;
    const timeCostUsd = additionalHours * 30;
    const incrementalHourlyReturnUsd =
      additionalHours > 0
        ? Math.max(0, incrementalExpectedValue - timeCostUsd) / additionalHours
        : 0;

    let recommendation: "worth_it" | "marginal" | "not_worth_it";
    let reason: string;

    const remaining = Math.max(
      0,
      (task.maxIterations ?? 6) - (task.iterationCount ?? 0)
    );
    if (remaining <= 0) {
      recommendation = "not_worth_it";
      reason = `iteration cap reached (${task.iterationCount}/${task.maxIterations})`;
    } else if (incrementalExpectedValue <= 0) {
      recommendation = "not_worth_it";
      reason = `incremental expected value is non-positive (${incrementalExpectedValue.toFixed(2)})`;
    } else if (incrementalExpectedValue < timeCostUsd) {
      recommendation = "marginal";
      reason = `incremental value ${incrementalExpectedValue.toFixed(2)} barely covers time cost ${timeCostUsd.toFixed(2)}`;
    } else if (incrementalHourlyReturnUsd < 15) {
      recommendation = "marginal";
      reason = `incremental hourly return ${incrementalHourlyReturnUsd.toFixed(2)} USD/hr is below $15/hr floor`;
    } else {
      recommendation = "worth_it";
      reason = `incremental value ${incrementalExpectedValue.toFixed(2)} USD at ${incrementalHourlyReturnUsd.toFixed(2)} USD/hr — clear positive return`;
    }

    return {
      ok: true,
      data: {
        expectedValueBefore: expectedValueBefore + priorValueAdded,
        expectedValueAfter,
        incrementalExpectedValue,
        additionalTimeMs,
        incrementalHourlyReturnUsd,
        recommendation,
        reason,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[iteration-service] getIterationEconomics failed:", err);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// getQualityGate (Phase 3 §12)
// ---------------------------------------------------------------------------

/**
 * Run the four quality-gate checks against an iteration's artifact.
 *
 *   1. functionality_check — tests pass? (artifact.testsPassed === true OR
 *      testResults.ok === true)
 *   2. security_check     — safety.safe === true AND riskScore below threshold
 *   3. requirements_check  — artifact has files + approach non-empty + matches
 *      opportunity requirements (heuristic: keyword overlap)
 *   4. economic_check     — opportunity.expectedValue > 0 OR the iteration's
 *      estimatedValueAdded > 0
 *
 * Overall = "fail" if any check fails, "warn" if any check warns, "pass"
 * otherwise.
 */
export async function getQualityGate(
  iterationId: string
): Promise<IterationResult<QualityGateResult>> {
  try {
    if (!iterationId) return { ok: false, error: "iterationId is required" };
    const iteration = await db.taskIteration.findUnique({
      where: { id: iterationId },
      select: {
        id: true,
        taskId: true,
        artifactJson: true,
        testResults: true,
        qualityScore: true,
        estimatedValueAdded: true,
      },
    });
    if (!iteration) {
      return { ok: false, error: `Iteration ${iterationId} not found` };
    }

    const task = await db.task.findUnique({
      where: { id: iteration.taskId },
      select: { opportunityId: true },
    });
    let opportunity: {
      title: string;
      description: string;
      requirements: string;
      expectedValue: number;
      rewardUsd: number;
    } | null = null;
    if (task?.opportunityId) {
      opportunity = await db.opportunity.findUnique({
        where: { id: task.opportunityId },
        select: {
          title: true,
          description: true,
          requirements: true,
          expectedValue: true,
          rewardUsd: true,
        },
      });
    }

    const artifact = parseArtifact(iteration.artifactJson);
    const testResults = parseTestResults(iteration.testResults);

    // --- 1. functionality check -------------------------------------------
    const testsPass = artifact.testsPassed === true || testResults.ok === true;
    const hasTests = (artifact.tests?.length ?? 0) > 0 || testResults.passed != null;
    const functionalityCheck: QualityGateCheck = testsPass
      ? {
          name: "functionality_check",
          status: "pass",
          detail: hasTests
            ? `${testResults.passed ?? 0} test(s) passed`
            : "no tests recorded — auto-pass",
        }
      : hasTests
      ? {
          name: "functionality_check",
          status: "fail",
          detail: `${testResults.failed ?? 0} test(s) failed`,
        }
      : {
          name: "functionality_check",
          status: "warn",
          detail: "no tests were recorded for this artifact",
        };

    // --- 2. security check -----------------------------------------------
    const safe = artifact.safety?.safe === true;
    const riskScore = artifact.safety?.riskScore ?? 0;
    const securityCheck: QualityGateCheck = safe
      ? riskScore > 20
        ? {
            name: "security_check",
            status: "warn",
            detail: `safety.safe=true but riskScore=${riskScore} (>20) — review findings`,
          }
        : {
            name: "security_check",
            status: "pass",
            detail: `safety.safe=true, riskScore=${riskScore}`,
          }
      : {
          name: "security_check",
          status: "fail",
          detail: `safety.safe=false, riskScore=${riskScore}`,
        };

    // --- 3. requirements check -------------------------------------------
    let requirementsCheck: QualityGateCheck;
    if (!opportunity) {
      requirementsCheck = {
        name: "requirements_check",
        status: "warn",
        detail: "no opportunity linked — cannot verify requirements",
      };
    } else {
      const approach = (artifact.approach ?? "").toLowerCase();
      const reqs = parseStringArray(opportunity.requirements);
      if (approach.length === 0 && (artifact.files?.length ?? 0) === 0) {
        requirementsCheck = {
          name: "requirements_check",
          status: "fail",
          detail: "artifact is empty (no approach, no files)",
        };
      } else if (reqs.length === 0) {
        requirementsCheck = {
          name: "requirements_check",
          status: "pass",
          detail: "opportunity has no explicit requirements to check",
        };
      } else {
        // Heuristic: count how many requirement keywords appear in the
        // approach + file paths.
        const haystack =
          approach +
          " " +
          (artifact.files ?? []).map((f) => f.path.toLowerCase()).join(" ");
        const hits = reqs.filter((r) =>
          r.toLowerCase().split(/\W+/).some((w) => w.length > 3 && haystack.includes(w))
        ).length;
        const ratio = reqs.length > 0 ? hits / reqs.length : 1;
        if (ratio >= 0.5) {
          requirementsCheck = {
            name: "requirements_check",
            status: "pass",
            detail: `${hits}/${reqs.length} requirements matched`,
          };
        } else if (ratio > 0) {
          requirementsCheck = {
            name: "requirements_check",
            status: "warn",
            detail: `${hits}/${reqs.length} requirements matched — partial coverage`,
          };
        } else {
          requirementsCheck = {
            name: "requirements_check",
            status: "fail",
            detail: `0/${reqs.length} requirements matched`,
          };
        }
      }
    }

    // --- 4. economic check -----------------------------------------------
    const expectedValue = opportunity?.expectedValue ?? 0;
    const valueAdded = iteration.estimatedValueAdded ?? 0;
    const economicCheck: QualityGateCheck =
      expectedValue > 0 || valueAdded > 0
        ? {
            name: "economic_check",
            status: "pass",
            detail: `expectedValue=${expectedValue.toFixed(2)} USD, valueAdded=${valueAdded.toFixed(2)} USD`,
          }
        : {
            name: "economic_check",
            status: "warn",
            detail: "expectedValue and valueAdded both zero — confirm this opportunity is worth pursuing",
          };

    const checks: QualityGateCheck[] = [
      functionalityCheck,
      securityCheck,
      requirementsCheck,
      economicCheck,
    ];
    const hasFail = checks.some((c) => c.status === "fail");
    const hasWarn = checks.some((c) => c.status === "warn");
    const overall: "pass" | "warn" | "fail" = hasFail
      ? "fail"
      : hasWarn
      ? "warn"
      : "pass";

    return { ok: true, data: { checks, overall } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[iteration-service] getQualityGate failed:", err);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToIteration(row: {
  id: string;
  taskId: string;
  iterationNumber: number;
  version: string;
  artifactJson: string;
  feedbackId: string | null;
  feedbackText: string | null;
  feedbackType: string | null;
  feedbackPriority: string | null;
  modelId: string | null;
  agentName: string | null;
  qualityScore: number | null;
  testResults: string | null;
  securityResults: string | null;
  status: string;
  tokensUsed: number;
  timeSpentMs: number;
  estimatedValueAdded: number | null;
  createdAt: Date;
  updatedAt: Date;
}): IterationRow {
  return {
    id: row.id,
    taskId: row.taskId,
    iterationNumber: row.iterationNumber,
    version: row.version,
    artifactJson: row.artifactJson,
    feedbackId: row.feedbackId,
    feedbackText: row.feedbackText,
    feedbackType: row.feedbackType,
    feedbackPriority: row.feedbackPriority,
    modelId: row.modelId,
    agentName: row.agentName,
    qualityScore: row.qualityScore,
    testResults: row.testResults,
    securityResults: row.securityResults,
    status: row.status,
    tokensUsed: row.tokensUsed,
    timeSpentMs: row.timeSpentMs,
    estimatedValueAdded: row.estimatedValueAdded,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function emptyArtifact(): IterationArtifact {
  return { approach: "", files: [], tests: [] };
}

function parseArtifact(json: string): IterationArtifact {
  try {
    const parsed = JSON.parse(json) as IterationArtifact;
    if (typeof parsed !== "object" || parsed === null) return emptyArtifact();
    return {
      approach: typeof parsed.approach === "string" ? parsed.approach : "",
      files: Array.isArray(parsed.files) ? parsed.files : [],
      tests: Array.isArray(parsed.tests) ? parsed.tests : [],
      diff: typeof parsed.diff === "string" ? parsed.diff : undefined,
      safety: parsed.safety,
      testsPassed: parsed.testsPassed,
      testResults: parsed.testResults,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
    };
  } catch {
    return emptyArtifact();
  }
}

function parseTestResults(
  json: string | null | undefined
): { passed?: number; failed?: number; ok?: boolean } {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return {
      passed: typeof parsed.passed === "number" ? parsed.passed : undefined,
      failed: typeof parsed.failed === "number" ? parsed.failed : undefined,
      ok: typeof parsed.ok === "boolean" ? parsed.ok : undefined,
    };
  } catch {
    return {};
  }
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // fall through — treat as a single comma-separated string
    return value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split("\n").length;
}

/**
 * Phase-3 dev-review #2 → #3 → #5: compute a line-level diff between two strings.
 *
 * Returns a list of hunks (added/removed/context) that the dashboard's
 * Compare dialog renders as a syntax-highlighted diff view (like a GitHub
 * PR diff).
 *
 * Implementation: uses the off-the-shelf `diff` library (jsdiff) which
 * implements Myers' O(ND) algorithm correctly. We attempted an in-house
 * Myers implementation in dev-review #3 but the middle-snake backtracking
 * was buggy. The `diff` library is battle-tested + handles edge cases
 * (empty inputs, identical inputs, complete rewrites) correctly.
 *
 * We cap the input at 1000 lines per side + the output at 500 hunks to
 * prevent payload blowup on very large diffs.
 *
 * The output format is intentionally close to the GitHub PR diff view:
 *   - `context` lines are shown with no prefix.
 *   - `added` lines are shown with a `+` prefix + green background.
 *   - `removed` lines are shown with a `-` prefix + red background.
 */
function computeLineDiff(
  before: string,
  after: string
): Array<{ type: "added" | "removed" | "context"; lineNo: number; text: string }> {
  // Cap the input at 1000 lines per side.
  const MAX_LINES = 1000;
  const beforeLines = before.split("\n").slice(0, MAX_LINES);
  const afterLines = after.split("\n").slice(0, MAX_LINES);

  // Use the `diff` library's `diffLines` which implements Myers' algorithm.
  // Phase-3 DEV-REVIEW-6 (#3): switched from `require()` to a static
  // `import` at the top of the file for better tree-shaking + type safety.
  const parts = diffLines(beforeLines.join("\n"), afterLines.join("\n"));

  // Flatten the diff parts into individual line hunks.
  const hunks: Array<{ type: "added" | "removed" | "context"; lineNo: number; text: string }> = [];
  let lineNo = 1;
  const MAX_HUNKS = 500;
  let truncated = false;

  for (const part of parts) {
    if (hunks.length >= MAX_HUNKS) {
      truncated = true;
      break;
    }
    // Split the part's value into lines (dropping the trailing empty string
    // from the final newline).
    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();

    const type: "added" | "removed" | "context" = part.added
      ? "added"
      : part.removed
        ? "removed"
        : "context";

    for (const line of lines) {
      if (hunks.length >= MAX_HUNKS) {
        truncated = true;
        break;
      }
      hunks.push({ type, lineNo, text: line });
      // Only increment the line number for context + added lines (removed
      // lines don't advance the "after" file's line numbering).
      if (type === "context" || type === "added") {
        lineNo++;
      }
    }
    if (truncated) break;
  }

  if (truncated) {
    hunks.push({
      type: "context",
      lineNo,
      text: `… (diff truncated at ${MAX_HUNKS} hunks)`,
    });
  }
  return hunks;
}
