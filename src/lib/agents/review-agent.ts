// Review Agent (spec §4B).
//
// Independently reviews important work produced by other specialists,
// identifies errors, challenges assumptions, detects hallucinations, and
// verifies the task output satisfies the original opportunity requirements.
//
// Spec §4B: "The Review Agent should preferably use a different model from
// the primary execution agent." This agent explicitly requests a
// `reviewer`-role model from the router so a fresh perspective is brought
// to bear on the work.

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import { callLLM } from "@/lib/llm/provider";
import { getModels } from "@/lib/llm/registry";
import { validateJSON } from "@/lib/llm/deterministic";
import type { AgentInput, AgentOutput } from "@/lib/agents/types";
import { fail, ok } from "@/lib/agents/types";
import type { AgentName } from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReviewVerdict = "accept" | "reject" | "needs_revision";

export interface ReviewResult {
  verdict: ReviewVerdict;
  qualityScore: number; // 0..10
  issues: Array<{ severity: "info" | "warn" | "critical"; detail: string }>;
  summary: string;
  model: string;
  reviewerDifferentFromExecutor: boolean;
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

export async function execute(input: AgentInput): Promise<AgentOutput> {
  const taskId = (input.task?.id as string | undefined) ?? undefined;
  const opportunityId =
    (input.opportunity?.id as string | undefined) ?? undefined;

  if (!opportunityId) {
    return fail("review agent requires an opportunity id");
  }

  try {
    // Load the most recent task for this opportunity that produced output.
    // We look for tasks in (coding, web3, writing, execution) — the
    // specialists whose work is reviewable.
    const candidateTasks = await db.task.findMany({
      where: {
        opportunityId,
        toAgent: { in: ["coding", "web3", "writing", "execution"] },
        status: "success",
        output: { not: null },
      },
      orderBy: { completedAt: "desc" },
      take: 5,
    });

    if (candidateTasks.length === 0) {
      return ok(
        {
          verdict: "accept" as const,
          qualityScore: 5,
          issues: [],
          summary: "No reviewable task output found — auto-accept.",
          model: "none",
          reviewerDifferentFromExecutor: false,
        } as unknown as Record<string, unknown>
      );
    }

    const targetTask = candidateTasks[0];
    const executorModel = targetTask.modelId ?? undefined;

    // --- 1. Pick a REVIEWER model — prefer one different from the executor -
    const reviewerModel = await pickReviewerModel(executorModel);
    const reviewerDifferentFromExecutor =
      !!executorModel && reviewerModel !== executorModel;

    // --- 2. Load the opportunity + the executor's output ----------------
    const op = await db.opportunity.findUnique({
      where: { id: opportunityId },
      select: {
        id: true,
        title: true,
        description: true,
        requirements: true,
        category: true,
      },
    });
    if (!op) {
      return fail(`opportunity ${opportunityId} not found`);
    }

    let executorOutput: Record<string, unknown> = {};
    try {
      executorOutput = targetTask.output
        ? (JSON.parse(targetTask.output) as Record<string, unknown>)
        : {};
    } catch {
      executorOutput = { raw: targetTask.output };
    }

    // --- 3. Call the LLM for the review ----------------------------------
    const review = await callReviewLLM(
      reviewerModel,
      {
        opportunityTitle: op.title,
        opportunityDescription: op.description,
        opportunityRequirements: op.requirements,
        executorAgent: targetTask.toAgent,
        executorModel: executorModel ?? "unknown",
        executorObjective: targetTask.objective,
        executorOutput: JSON.stringify(executorOutput).slice(0, 4000),
      },
      { taskId, opportunityId }
    );

    review.model = reviewerModel;
    review.reviewerDifferentFromExecutor = reviewerDifferentFromExecutor;

    // --- 4. Persist the review onto the Task row ------------------------
    try {
      await db.task.update({
        where: { id: targetTask.id },
        data: {
          qualityScore: review.qualityScore,
        },
      });
    } catch (err) {
      console.error("[review-agent] task qualityScore update failed:", err);
    }

    // --- 4b. Propagate the review's qualityScore into the executor's
    // ModelPerformance row (Phase-2 P1-8 — closed).
    //
    // The executor's `ModelPerformance.avg_quality` EMA was previously stuck
    // at its seed value forever because nothing recorded the reviewer's
    // verdict against the executor's (modelId, taskType). Now the review
    // agent records a synthetic "review:<executorAgent>" task-type entry
    // against the executor's model so the router's adaptive scoring sees
    // the reviewer signal on future routing decisions.
    if (executorModel && executorModel !== "unknown") {
      try {
        const { recordModelPerformance } = await import("@/lib/llm/registry");
        // verdict → success boolean: "accept" = success, "needs_revision"
        // = soft success (still recorded, lower quality), "reject" = failure.
        const reviewSuccess = review.verdict === "accept";
        // The qualityScore from the reviewer is 0..10; pass it straight through.
        // Latency/tokens are 0 here because this isn't a real LLM call against
        // the executor — it's the reviewer's judgement OF the executor's output.
        await recordModelPerformance(
          executorModel,
          `review:${targetTask.toAgent}`,
          reviewSuccess,
          0,
          0,
          review.qualityScore,
          undefined
        );
      } catch (err) {
        console.error("[review-agent] recordModelPerformance failed:", err);
      }
    }

    await logEvent(
      "review",
      review.verdict === "accept" ? "info" : "warn",
      "review_completed",
      {
        opportunityId,
        targetTaskId: targetTask.id,
        executorAgent: targetTask.toAgent,
        executorModel,
        reviewerModel,
        reviewerDifferentFromExecutor,
        verdict: review.verdict,
        qualityScore: review.qualityScore,
        issueCount: review.issues.length,
      },
      { taskId, opportunityId }
    );

    return ok(
      review as unknown as Record<string, unknown>,
      {
        qualityScore: review.qualityScore,
        nextAgent:
          review.verdict === "accept"
            ? "execution"
            : review.verdict === "needs_revision"
            ? (targetTask.toAgent as AgentName)
            : undefined,
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[review-agent] execute threw:", err);
    await logEvent(
      "review",
      "error",
      "review_failed",
      { opportunityId, error: message },
      { taskId, opportunityId }
    );
    return fail(`review agent crashed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Reviewer model selection
// ---------------------------------------------------------------------------

/**
 * Pick a reviewer-ROLE model, preferring one that differs from the executor
 * model that produced the work being reviewed (spec §4B).
 */
async function pickReviewerModel(
  executorModel: string | undefined
): Promise<string> {
  try {
    const reviewerModels = await getModels({
      enabled: true,
      role: "reviewer",
    });
    if (reviewerModels.length > 0) {
      // Prefer a model whose id differs from the executor's.
      const different = reviewerModels.find(
        (m) => m.model_id !== executorModel
      );
      return (different ?? reviewerModels[0]).model_id;
    }
    // Fall back to a healthy primary if no reviewer-role model is configured.
    const primaries = await getModels({ enabled: true, role: "primary" });
    const different = primaries.find((m) => m.model_id !== executorModel);
    return (different ?? primaries[0] ?? { model_id: "zai/glm-4.6" }).model_id;
  } catch (err) {
    console.error("[review-agent] pickReviewerModel failed:", err);
    return "zai/glm-4.6";
  }
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

interface LlmInput {
  opportunityTitle: string;
  opportunityDescription: string;
  opportunityRequirements: string;
  executorAgent: string;
  executorModel: string;
  executorObjective: string;
  executorOutput: string;
}

async function callReviewLLM(
  modelId: string,
  input: LlmInput,
  ctx: { taskId?: string; opportunityId?: string }
): Promise<ReviewResult> {
  const systemPrompt = [
    "You are the Review Agent for an autonomous crypto-earning system.",
    "Independently review the work produced by a specialist agent. Identify",
    "errors, challenge assumptions, detect hallucinations, and verify the",
    "work satisfies the original opportunity requirements.",
    "",
    "Return STRICT JSON with this shape:",
    "{",
    '  "verdict": "accept" | "reject" | "needs_revision",',
    '  "qualityScore": number (0..10),',
    '  "issues": [{"severity": "info" | "warn" | "critical", "detail": string}],',
    '  "summary": string',
    "}",
    "",
    "Rules:",
    "- Be conservative. Set verdict='reject' for any critical issue.",
    "- Set verdict='needs_revision' for fixable problems.",
    "- Set verdict='accept' only if the work fully addresses the opportunity.",
    "- Return ONLY the JSON object.",
  ].join("\n");

  const userPrompt = [
    `Opportunity title: ${input.opportunityTitle}`,
    `Opportunity requirements: ${input.opportunityRequirements}`,
    `Opportunity description:\n${input.opportunityDescription}`,
    "",
    `Executor agent: ${input.executorAgent}`,
    `Executor model: ${input.executorModel}`,
    `Executor objective: ${input.executorObjective}`,
    "",
    `Executor output (JSON):\n${input.executorOutput}`,
  ].join("\n");

  try {
    const result = await callLLM({
      modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      maxTokens: 1000,
      temperature: 0.3,
      responseFormat: "json",
      taskType: "review",
      estimatedTokens: 2000,
      taskId: ctx.taskId,
      opportunityId: ctx.opportunityId,
    });

    if (result.success && result.content) {
      const parsed = parseReview(result.content);
      if (parsed) return parsed;
    }

    await logEvent(
      "review",
      "warn",
      "review_llm_failed_fallback",
      {
        opportunityId: ctx.opportunityId,
        model: modelId,
        error: result.error,
      },
      ctx
    );
  } catch (err) {
    console.error("[review-agent] callLLM threw:", err);
  }

  // Deterministic fallback: needs_revision — do NOT auto-accept work the
  // reviewer couldn't verify.
  return {
    verdict: "needs_revision",
    qualityScore: 4,
    issues: [
      {
        severity: "warn",
        detail:
          "Reviewer LLM unavailable — could not independently verify the work. Defaulting to needs_revision for human review.",
      },
    ],
    summary: "Reviewer LLM unavailable — manual review required.",
    model: modelId,
    reviewerDifferentFromExecutor: false,
  };
}

function parseReview(raw: string): ReviewResult | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }

  const verdict = obj.verdict;
  const validVerdict =
    verdict === "accept" || verdict === "reject" || verdict === "needs_revision"
      ? verdict
      : "needs_revision";

  const qualityScore =
    typeof obj.qualityScore === "number" && Number.isFinite(obj.qualityScore)
      ? clamp(obj.qualityScore, 0, 10)
      : 5;

  const issues: ReviewResult["issues"] = Array.isArray(obj.issues)
    ? obj.issues
        .map((i): ReviewResult["issues"][number] | null => {
          if (typeof i !== "object" || i === null) return null;
          const item = i as Record<string, unknown>;
          const severity = item.severity;
          const detail = item.detail;
          return {
            severity:
              severity === "info" || severity === "warn" || severity === "critical"
                ? severity
                : "info",
            detail: typeof detail === "string" ? detail : "",
          };
        })
        .filter((x): x is ReviewResult["issues"][number] => x !== null)
    : [];

  const summary =
    typeof obj.summary === "string" ? obj.summary : "No summary provided.";

  return {
    verdict: validVerdict,
    qualityScore,
    issues,
    summary,
    model: "",
    reviewerDifferentFromExecutor: false,
  };
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
