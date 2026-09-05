// Execution Agent (spec §4B, §20, §32).
//
// Executes APPROVED tasks. Performs only LOW-RISK actions (spec §4B):
// "It must NOT have unrestricted financial authority."
//
// Pre-flight gates:
//   1. `assertPolicy(action, ctx)` — must return `allowed: true`.
//   2. Idempotency: look up `IdempotencyRecord` by `executionId` =
//      `${opportunityId}:${action}`. If a completed record exists, skip
//      (spec §30 — never re-execute).
//   3. If `executionLevel >= 2`, an approved `Approval` row must exist
//      for this opportunity+action.
//
// SUBMISSION (Phase-2 §20, P1-10, P2-EXEC-ADAPTERS — REAL adapters):
//   The agent now dispatches to a REAL submission adapter selected by
//   `getAdapterForCategory(category, sourceUrl)`. The adapter makes the
//   external API call (GitHub PR, GitHub Gist, Mirror.xyz post, Medium
//   post) OR — when no real adapter is configured for the category —
//   falls back to `EmailDraftAdapter`, which writes a draft the operator
//   must complete manually. The EmailDraftAdapter is ALWAYS available
//   so the agent NEVER has to fake a submission.
//
// SIMULATION MODE (Phase-2 §40, P2-23, P2-16):
//   When `MOCK_MODE=true` OR `autonomyMode="observe"`, the agent runs
//   the simulated path (writes `externalRef = "simulated:..."`) — this
//   is what the mock-simulation script + the dashboard demo depend on.
//   In production autonomous mode (semi/full without MOCK_MODE) the
//   agent calls a REAL adapter (or the EmailDraftAdapter fallback) —
//   NEVER fakes success.
//
//   The `simulated:` prefix on `externalRef` is preserved so the audit
//   log + dashboard can distinguish real submissions from simulated ones
//   at a glance. See `docs/SIMULATION.md` for the full matrix.

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import { assertPolicy, type PolicyAction } from "@/lib/policy";
import { getCachedState } from "@/lib/agent/state";
import type { AgentInput, AgentOutput } from "@/lib/agents/types";
import { fail, fieldString, ok } from "@/lib/agents/types";
import type { RiskLevel } from "@/lib/agent/types";
import {
  getAdapterForCategory,
  type SubmissionInput,
  type SubmissionResult,
} from "@/lib/execution-adapters";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  action: string;
  executionId: string;
  externalRef: string | null;
  idempotent: boolean; // true if the action was already completed previously
  allowed: boolean;
  reason: string;
  nextStatus: "executed" | "awaiting_payment" | "failed" | "approved";
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

export async function execute(input: AgentInput): Promise<AgentOutput> {
  const taskId = (input.task?.id as string | undefined) ?? undefined;
  const opportunityId =
    (input.opportunity?.id as string | undefined) ?? undefined;

  if (!opportunityId) {
    return fail("execution agent requires an opportunity id");
  }

  const action = fieldString(input.context, "action", "submit_solution");
  const executionId = `${opportunityId}:${action}`;

  try {
    const op = await db.opportunity.findUnique({
      where: { id: opportunityId },
    });
    if (!op) {
      return fail(`opportunity ${opportunityId} not found`);
    }

    // --- 1. Idempotency check (spec §30) --------------------------------
    const existing = await db.idempotencyRecord.findUnique({
      where: { executionId },
    });
    if (existing && existing.status === "completed") {
      await logEvent(
        "execution",
        "info",
        "execution_idempotent_skip",
        {
          opportunityId,
          action,
          executionId,
          externalRef: existing.externalRef,
        },
        { taskId, opportunityId }
      );
      // The action already completed — if it was a real GitHub PR, make sure
      // the opportunity reflects the "submitted" state so the PR monitor
      // picks it up (and so a re-dispatch can't loop the execution agent).
      if (existing.externalRef?.startsWith("github-pr:")) {
        await db.opportunity
          .update({
            where: { id: opportunityId },
            data: { status: "submitted" },
          })
          .catch((err) => {
            console.error(
              "[execution-agent] idempotent-skip status sync failed:",
              err
            );
          });
      }
      return ok(
        {
          action,
          executionId,
          externalRef: existing.externalRef,
          idempotent: true,
          allowed: true,
          reason: "Action was already completed previously — skipping (spec §30).",
          nextStatus: "awaiting_payment" as const,
        } as unknown as Record<string, unknown>,
        { nextAgent: "payment" }
      );
    }

    // --- 2. Policy gate (spec §11, §21) ----------------------------------
    const riskLevel: RiskLevel =
      (fieldString(input.context, "riskLevel", "low") as RiskLevel) || "low";
    const policyAction: PolicyAction = {
      type: action,
      riskLevel,
      opportunityId,
      details: input.context,
    };
    const verdict = await assertPolicy(policyAction, {
      opportunity: undefined,
      taskId,
    });

    if (!verdict.allowed) {
      await logEvent(
        "execution",
        "warn",
        "execution_policy_blocked",
        {
          opportunityId,
          action,
          requiredLevel: verdict.requiredLevel,
          reason: verdict.reason,
        },
        { taskId, opportunityId }
      );
      return ok(
        {
          action,
          executionId,
          externalRef: null,
          idempotent: false,
          allowed: false,
          reason: verdict.reason,
          nextStatus: "approved" as const,
        } as unknown as Record<string, unknown>,
        {
          notes: [
            `Policy blocked action '${action}': ${verdict.reason}. Create an Approval row to proceed.`,
          ],
        }
      );
    }

    // --- 3. Approval gate (level 2+) -------------------------------------
    if (verdict.requiredLevel >= 2) {
      const approval = await db.approval.findFirst({
        where: {
          opportunityId,
          status: "approved",
        },
        orderBy: { decidedAt: "desc" },
      });
      if (!approval) {
        await logEvent(
          "execution",
          "warn",
          "execution_missing_approval",
          {
            opportunityId,
            action,
            requiredLevel: verdict.requiredLevel,
          },
          { taskId, opportunityId }
        );
        return ok(
          {
            action,
            executionId,
            externalRef: null,
            idempotent: false,
            allowed: false,
            reason: `Action requires level-${verdict.requiredLevel} approval — no approved Approval row found.`,
            nextStatus: "approved" as const,
          } as unknown as Record<string, unknown>,
          {
            notes: [
              "Create an Approval row (status='approved') for this opportunity before retrying.",
            ],
          }
        );
      }
    }

    // --- 4. Create the idempotency record BEFORE executing (spec §30) ----
    try {
      await db.idempotencyRecord.upsert({
        where: { executionId },
        create: {
          executionId,
          opportunityId,
          action,
          status: "pending",
        },
        update: {},
      });
    } catch (err) {
      console.error("[execution-agent] idempotencyRecord create failed:", err);
    }

    // --- 5. Execution gate (Phase 3.1 §8, §9, §13) ---------------------------
    // Phase 3.1: SIMULATION_MODE is ONLY activated by an explicit MOCK_MODE=true
    // env var. In observe mode, the agent does NOT execute at all — it returns
    // early with "observe mode — no execution". In semi/full autonomy, it
    // dispatches to a REAL submission adapter (or the EmailDraftAdapter
    // fallback). The agent NEVER fakes a submission in production.
    const autonomyMode = getCachedState().autonomyMode;
    const mockMode = (process.env.MOCK_MODE ?? "").toLowerCase() === "true";
    const category = op.category || "unknown";

    // Observe mode: NO execution at all (Phase 3.1 §33).
    if (autonomyMode === "observe" && !mockMode) {
      await logEvent(
        "execution",
        "info",
        "execution_skipped_observe_mode",
        {
          opportunityId,
          action,
          executionId,
          autonomyMode,
        },
        { taskId, opportunityId }
      );
      return ok(
        {
          skipped: true,
          reason: "observe mode — no execution",
          opportunityId,
        } as unknown as Record<string, unknown>,
        {}
      );
    }

    // MOCK_MODE: simulated execution (for tests + the mock simulation script).
    if (mockMode) {
      // --- 6. SIMULATED execution (MOCK_MODE only) ------------------------
      const externalRef = `simulated:${executionId}:${Date.now()}`;
      try {
        await db.opportunity.update({
          where: { id: opportunityId },
          data: { status: "executed" },
        });
      } catch (err) {
        console.error("[execution-agent] opportunity status update failed:", err);
      }

      try {
        await db.idempotencyRecord.update({
          where: { executionId },
          data: {
            status: "completed",
            externalRef,
            completedAt: new Date(),
          },
        });
      } catch (err) {
        console.error("[execution-agent] idempotencyRecord completion failed:", err);
      }

      await logEvent(
        "execution",
        "info",
        "execution_completed",
        {
          opportunityId,
          action,
          executionId,
          externalRef,
          riskLevel,
          requiredLevel: verdict.requiredLevel,
          simulated: true,
          simulationMode: "on",
          autonomyMode,
          mockMode,
          category,
        },
        { taskId, opportunityId }
      );

      return ok(
        {
          action,
          executionId,
          externalRef,
          idempotent: false,
          allowed: true,
          reason: `Action '${action}' executed successfully (SIMULATED — MOCK_MODE=true).`,
          nextStatus: "awaiting_payment" as const,
        } as unknown as Record<string, unknown>,
        { qualityScore: 8, nextAgent: "payment" }
      );
    }

    // --- 7. Production: dispatch to a REAL submission adapter ---------------
    // Phase 3.1 §13: no simulation in the production path. The agent
    // dispatches to the best available adapter for the opportunity's category.
    // If no real adapter is configured, the EmailDraftAdapter prepares a
    // draft but does NOT submit.
    const approvalIdRaw = fieldString(input.context, "approvalId", "");
    return await dispatchToRealAdapter(input, op, {
      taskId: taskId ?? "",
      opportunityId,
      action,
      executionId,
      riskLevel,
      requiredLevel: verdict.requiredLevel,
      approvalId: approvalIdRaw || undefined,
      autonomyMode,
      mockMode,
      category,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[execution-agent] execute threw:", err);
    await logEvent(
      "execution",
      "error",
      "execution_failed",
      { opportunityId, action, executionId, error: message },
      { taskId, opportunityId }
    );

    // Mark the opportunity as failed so the orchestrator can move on.
    try {
      await db.opportunity.update({
        where: { id: opportunityId },
        data: { status: "failed" },
      });
    } catch {
      // ignore
    }

    return fail(`execution agent crashed: ${message}`, {
      action,
      executionId,
      nextStatus: "failed",
    });
  }
}

// ---------------------------------------------------------------------------
// dispatchToRealAdapter — production autonomous mode
// ---------------------------------------------------------------------------

interface RealAdapterContext {
  taskId: string;
  opportunityId: string;
  action: string;
  executionId: string;
  riskLevel: RiskLevel;
  requiredLevel: number;
  approvalId?: string;
  autonomyMode: string;
  mockMode: boolean;
  category: string;
}

/**
 * Production autonomous mode dispatch — pick a real submission adapter,
 * build the SubmissionInput from the opportunity + the prior deliverable,
 * and invoke `adapter.submit()`.
 *
 * Selection:
 *   1. `getAdapterForCategory(category, sourceUrl)` — picks the best
 *      configured adapter (GithubPrAdapter if GitHub URL + token set,
 *      GithubGistAdapter if token set, GitcoinGrantAdapter for grants,
 *      DevpostHackathonAdapter for hackathons, MirrorPostAdapter /
 *      MediumPostAdapter for content, EmailDraftAdapter as the ALWAYS-
 *      AVAILABLE fallback).
 *   2. If the picked adapter is NOT configured (shouldn't happen —
 *      `getAdapterForCategory` already accounts for `isConfigured()` —
 *      but defensive), fall back to EmailDraftAdapter.
 *
 * Result handling:
 *   - On `success: true` → mark opportunity `executed`, persist
 *     `externalRef` on the IdempotencyRecord + Task output, return ok.
 *   - On `success: false` → mark opportunity `failed`, return fail
 *     with the error. NEVER re-throws.
 *
 * NEVER throws. NEVER fakes a submission.
 */
async function dispatchToRealAdapter(
  _input: AgentInput,
  op: { id: string; category: string; sourceUrl: string; title: string; description: string; organization: string; rewardAmount: number; rewardCurrency: string },
  ctx: RealAdapterContext
): Promise<AgentOutput> {
  const logCtx = { taskId: ctx.taskId, opportunityId: ctx.opportunityId };

  // --- 1. Pick the adapter -------------------------------------------------
  const adapter = getAdapterForCategory(ctx.category, op.sourceUrl);

  await logEvent(
    "execution",
    "info",
    "execution_adapter_selected",
    {
      opportunityId: ctx.opportunityId,
      action: ctx.action,
      executionId: ctx.executionId,
      adapterId: adapter.id,
      adapterConfigured: adapter.isConfigured(),
      adapterCategory: adapter.category,
      autonomyMode: ctx.autonomyMode,
      mockMode: ctx.mockMode,
      category: ctx.category,
      sourceUrl: op.sourceUrl,
    },
    logCtx
  );

  // --- 2. Build the SubmissionInput from the prior deliverable -------------
  const deliverable = await loadPriorDeliverable(ctx.opportunityId).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[execution-agent] loadPriorDeliverable failed:", msg);
    return emptyDeliverable();
  });

  const submissionInput: SubmissionInput = {
    opportunityId: ctx.opportunityId,
    taskId: ctx.taskId,
    workspacePath: "", // the coding agent's workspace is cleaned up by now;
    // the deliverable's `files` array carries everything we need.
    opportunity: {
      title: op.title,
      description: op.description ?? "",
      sourceUrl: op.sourceUrl ?? "",
      category: op.category ?? ctx.category,
      organization: op.organization ?? "",
      rewardAmount: op.rewardAmount ?? 0,
      rewardCurrency: op.rewardCurrency ?? "",
    },
    deliverable,
    approvalId: ctx.approvalId,
  };

  // --- 3. Invoke the adapter (NEVER throws) --------------------------------
  let result: SubmissionResult;
  try {
    result = await adapter.submit(submissionInput);
  } catch (err) {
    // Defensive — adapters are required to never throw, but if one does
    // we capture the error and return a failure result.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[execution-agent] adapter '${adapter.id}' threw (should not happen):`,
      err
    );
    result = {
      success: false,
      externalRef: `error:${adapter.id}`,
      status: "failed",
      details: `Adapter threw an uncaught error: ${msg}`,
      error: msg,
      adapterId: adapter.id,
    };
  }

  // --- 4. Persist the result on the IdempotencyRecord + Task output --------
  const externalRef = result.externalRef;
  // Real-submission SUCCESS means the deliverable is now SUBMITTED to the
  // external platform (the pull request is open). The PR monitor watches
  // "submitted" opportunities and transitions them to awaiting_payment
  // (merged) / needs_improvement (changes requested) / failed (closed).
  // (Previously "executed", which would re-trigger the review agent and
  // loop the lifecycle.)
  const nextStatus: "submitted" | "failed" =
    result.success && result.status !== "failed"
      ? "submitted"
      : "failed";

  try {
    await db.opportunity.update({
      where: { id: ctx.opportunityId },
      data: { status: nextStatus },
    });
  } catch (err) {
    console.error(
      `[execution-agent] opportunity status update (${nextStatus}) threw:`,
      err
    );
  }

  try {
    await db.idempotencyRecord.update({
      where: { executionId: ctx.executionId },
      data: {
        status: result.success ? "completed" : "failed",
        externalRef,
        completedAt: new Date(),
      },
    });
  } catch (err) {
    console.error(
      "[execution-agent] idempotencyRecord completion failed:",
      err
    );
  }

  // Persist the full SubmissionResult on the Task output (so the dashboard
  // + review agent can inspect what was actually submitted).
  if (ctx.taskId) {
    try {
      await db.task.update({
        where: { id: ctx.taskId },
        data: {
          output: JSON.stringify({
            adapterId: adapter.id,
            adapterConfigured: adapter.isConfigured(),
            submission: result,
            executionId: ctx.executionId,
            action: ctx.action,
          }),
          status: result.success ? "success" : "failed",
          completedAt: new Date(),
        },
      });
    } catch (err) {
      console.error("[execution-agent] task output persist failed:", err);
    }
  }

  // --- 5. Log + return -----------------------------------------------------
  await logEvent(
    "execution",
    result.success ? "info" : "error",
    result.success ? "execution_completed" : "execution_failed",
    {
      opportunityId: ctx.opportunityId,
      action: ctx.action,
      executionId: ctx.executionId,
      externalRef,
      submissionUrl: result.submissionUrl,
      submissionStatus: result.status,
      submissionDetails: result.details,
      adapterId: adapter.id,
      adapterConfigured: adapter.isConfigured(),
      riskLevel: ctx.riskLevel,
      requiredLevel: ctx.requiredLevel,
      simulated: false,
      simulationMode: "off",
      autonomyMode: ctx.autonomyMode,
      mockMode: ctx.mockMode,
      category: ctx.category,
      ...(result.error ? { error: result.error } : {}),
    },
    logCtx
  );

  if (!result.success) {
    return fail(
      result.error ?? `submission via adapter '${adapter.id}' failed`,
      {
        action: ctx.action,
        executionId: ctx.executionId,
        adapterId: adapter.id,
        externalRef,
        submissionUrl: result.submissionUrl,
        submissionStatus: result.status,
        nextStatus: "failed",
      }
    );
  }

  return ok(
    {
      action: ctx.action,
      executionId: ctx.executionId,
      externalRef,
      idempotent: false,
      allowed: true,
      reason: result.details,
      adapterId: adapter.id,
      submissionUrl: result.submissionUrl,
      submissionStatus: result.status,
      nextStatus: result.status === "draft" ? "executed" : "awaiting_payment",
    } as unknown as Record<string, unknown>,
    {
      qualityScore: result.status === "draft" ? 6 : 8,
      nextAgent: "payment",
      notes:
        result.status === "draft"
          ? [
              `Adapter '${adapter.id}' prepared a draft — operator must complete the submission manually. ` +
                `Submission URL: ${result.submissionUrl ?? "(none)"}`,
            ]
          : undefined,
    }
  );
}

// ---------------------------------------------------------------------------
// loadPriorDeliverable — find the prior coding/writing agent's Task output
// and normalise it into the SubmissionInput.deliverable shape.
// ---------------------------------------------------------------------------

interface DeliverableFile {
  path: string;
  language: string;
  content: string;
}

interface NormalizedDeliverable {
  approach: string;
  files: DeliverableFile[];
  tests: string[];
  diff?: string;
  patch?: string;
}

/**
 * Look up the most recent successful Task for this opportunity where the
 * `toAgent` is one of the deliverable-producing specialists (coding /
 * writing / web3), parse its `output` JSON, and normalise it into the
 * `SubmissionInput.deliverable` shape.
 *
 * Returns an empty deliverable when no prior task is found (the adapter
 * will then receive an empty files array — most adapters will fail with
 * an actionable error, which is the honest behaviour).
 */
async function loadPriorDeliverable(
  opportunityId: string
): Promise<NormalizedDeliverable> {
  const priorTask = await db.task.findFirst({
    where: {
      opportunityId,
      toAgent: { in: ["coding", "writing", "web3"] },
      status: "success",
    },
    orderBy: { completedAt: "desc" },
    select: { toAgent: true, output: true },
  });

  if (!priorTask || !priorTask.output) {
    return emptyDeliverable();
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(priorTask.output) as Record<string, unknown>;
  } catch {
    return emptyDeliverable();
  }

  if (priorTask.toAgent === "writing") {
    return normaliseWritingOutput(parsed);
  }
  // coding + web3 share the CodingSolutionOutline shape.
  return normaliseCodingOutput(parsed);
}

function emptyDeliverable(): NormalizedDeliverable {
  return {
    approach: "",
    files: [],
    tests: [],
  };
}

/**
 * Normalise a CodingSolutionOutline (the coding/web3 agent's output JSON)
 * into the SubmissionInput.deliverable shape.
 */
function normaliseCodingOutput(parsed: Record<string, unknown>): NormalizedDeliverable {
  const approach = strField(parsed, "approach");
  const filesRaw = Array.isArray(parsed.files) ? parsed.files : [];
  const files: DeliverableFile[] = filesRaw
    .map((f) => {
      if (typeof f !== "object" || f === null) return null;
      const file = f as Record<string, unknown>;
      const path = strField(file, "path");
      const language = strField(file, "language");
      const content = strField(file, "content");
      if (!path || !content) return null;
      return { path, language, content };
    })
    .filter((f): f is DeliverableFile => f !== null);

  const testsRaw = Array.isArray(parsed.tests) ? parsed.tests : [];
  const tests: string[] = [];
  // CodingSolutionOutline.tests is CodingTestFile[] — the test FILES are part
  // of the deliverable (bounties routinely require "add comprehensive tests
  // to tests/<file>"). Previously these were reduced to string summaries for
  // the PR body and their CONTENT was dropped, so submissions shipped the
  // source change without the required tests (observed: fibonacci PR #16
  // carried only src/math_utils.py). Commit them alongside the source files.
  for (const t of testsRaw) {
    if (typeof t === "string") {
      tests.push(t);
      continue;
    }
    if (typeof t !== "object" || t === null) continue;
    const tf = t as Record<string, unknown>;
    const testPath = strField(tf, "path");
    const testContent = strField(tf, "content");
    if (testPath && testContent && !files.some((f) => f.path === testPath)) {
      files.push({
        path: testPath,
        language: languageForPath(testPath),
        content: testContent,
      });
    }
    const framework = strField(tf, "framework") || "test";
    tests.push(
      `${framework} suite at ${testPath || "(in-memory)"}`
    );
  }
  // If the parsed output includes a testResults block, surface that too.
  const testResults = parsed.testResults as Record<string, unknown> | undefined;
  if (testResults && typeof testResults === "object") {
    const passed = numField(testResults, "passed");
    const failed = numField(testResults, "failed");
    const ok = testResults.ok === true;
    const framework = strField(testResults, "framework") || "tests";
    tests.push(
      `${framework}: ${passed} passed, ${failed} failed (${ok ? "PASS" : "FAIL"})`
    );
  }

  const diff = strField(parsed, "diff") || undefined;
  return {
    approach,
    files,
    tests,
    diff: diff && diff.length > 0 ? diff : undefined,
    // patch is not separately produced by the coding agent — `diff` IS the
    // unified patch. Surface it as `patch` too so adapters that look for
    // `patch` see it.
    patch: diff && diff.length > 0 ? diff : undefined,
  };
}

/**
 * Normalise a WritingDraft (the writing agent's output JSON) into the
 * SubmissionInput.deliverable shape.
 */
function normaliseWritingOutput(parsed: Record<string, unknown>): NormalizedDeliverable {
  const format = strField(parsed, "format") || "markdown";
  const content = strField(parsed, "content");
  const meetsRequirements = parsed.meets_requirements === true;
  const notesRaw = Array.isArray(parsed.notes) ? parsed.notes : [];
  const notes = notesRaw.filter((n): n is string => typeof n === "string");

  const approach =
    (content && content.length > 0 ? content.slice(0, 400) : "(no draft content)") +
    (meetsRequirements ? " [meets requirements]" : " [needs revision]");

  // The draft content IS the file — put it as a single markdown file.
  const files: DeliverableFile[] =
    content.length > 0
      ? [{ path: `article.${format === "markdown" ? "md" : "txt"}`, language: format, content }]
      : [];

  const tests: string[] = [
    `word_count: ${numField(parsed, "word_count")}`,
    `meets_requirements: ${meetsRequirements}`,
    ...notes.map((n) => `note: ${n}`),
  ];

  return { approach, files, tests };
}

/** Derive a language label from a file path (for committed test files). */
function languageForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "py":
      return "python";
    case "ts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "jsx";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "java":
      return "java";
    default:
      return "text";
  }
}

function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

function numField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
