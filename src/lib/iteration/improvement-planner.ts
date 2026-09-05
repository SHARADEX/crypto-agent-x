// Improvement Planner (Phase 3 §27).
//
// Given a Task + a structured feedback payload from the operator, produces a
// concrete plan for the next iteration:
//
//   {
//     requestedChanges: string[],          // what the agent must change
//     filesAffected: string[],            // which files/areas to touch
//     expectedImprovements: string[],     // quality deltas we expect
//     risk: "low" | "medium" | "high",    // risk of the iteration
//     estimatedTime: number,               // ms
//     estimatedTokens: number,             // LLM token budget
//     specialistAgent: string,            // coding | web3 | writing | security
//     testPlan: string[]                   // tests to write / run
//   }
//
// Phase 3 §28: the planner MUST pick a different model from the one that
// produced the original artifact — fresh perspective on the same problem.
//
// The planner uses `callLLM` with a planning prompt. When the LLM returns
// garbage or the call fails entirely, the planner degrades to a heuristic
// plan derived from the feedback type + prior artifact (so the iteration can
// still proceed — never throws).
//
// MOCK MODE: callLLM short-circuits and returns a canned default object
// (see src/lib/llm/mock-responses.ts). The planner's JSON parser will fail
// on that stub + fall back to the heuristic plan, which is exactly the
// behaviour we want in CI / mock simulation.

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import { callLLM } from "@/lib/llm/provider";
import { getModels } from "@/lib/llm/registry";
import { route } from "@/lib/llm/router";
import { getLatestIteration } from "@/lib/iteration/iteration-service";
import type { IterationArtifact } from "@/lib/iteration/iteration-service";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FeedbackType =
  | "ui"
  | "functionality"
  | "bugs"
  | "performance"
  | "visuals"
  | "gameplay"
  | "security"
  | "documentation"
  | "code_quality"
  | "requirements_mismatch"
  | "missing_feature"
  | "other";

export type FeedbackPriority = "low" | "medium" | "high" | "critical";

export type SpecialistAgent = "coding" | "web3" | "writing" | "security";

export type IterationRisk = "low" | "medium" | "high";

export interface ImprovementPlan {
  requestedChanges: string[];
  filesAffected: string[];
  expectedImprovements: string[];
  risk: IterationRisk;
  estimatedTime: number; // ms
  estimatedTokens: number;
  specialistAgent: SpecialistAgent;
  modelId: string;
  testPlan: string[];
  source: "llm" | "heuristic_fallback";
}

export interface PlanImprovementInput {
  taskId: string;
  feedback: string;
  feedbackType: FeedbackType;
  feedbackPriority: FeedbackPriority;
  /** Optional target areas (file/area paths) the operator called out. */
  feedbackTargetAreas?: string[];
}

export interface PlanResult {
  ok: boolean;
  error?: string;
  plan?: ImprovementPlan;
}

// ---------------------------------------------------------------------------
// planImprovement
// ---------------------------------------------------------------------------

/**
 * Plan the next iteration of a Task given the operator's structured feedback.
 *
 * 1. Loads the latest iteration's artifact + the opportunity requirements.
 * 2. Routes to a specialist based on the feedback type (Phase 3 §27).
 * 3. Picks a DIFFERENT model from the one that produced the prior artifact
 *    (Phase 3 §28). Uses the LLM router's `excludeModelIds` parameter so the
 *    planner never reuses the same model that wrote the buggy code.
 * 4. Calls `callLLM` with a planning prompt asking for a strict-JSON plan.
 * 5. Parses the response; falls back to a heuristic plan derived from the
 *    feedback type if the LLM call fails or the JSON is malformed.
 *
 * NEVER throws — always returns `{ ok, plan | error }`.
 */
export async function planImprovement(
  input: PlanImprovementInput
): Promise<PlanResult> {
  try {
    if (!input.taskId) return { ok: false, error: "taskId is required" };
    if (!input.feedback || input.feedback.trim().length === 0) {
      return { ok: false, error: "feedback text is required" };
    }
    const feedbackType = input.feedbackType ?? "other";
    const feedbackPriority = input.feedbackPriority ?? "medium";

    const task = await db.task.findUnique({
      where: { id: input.taskId },
      select: {
        id: true,
        opportunityId: true,
        toAgent: true,
        modelId: true,
      },
    });
    if (!task) return { ok: false, error: `Task ${input.taskId} not found` };

    // --- 1. Load prior artifact + opportunity ----------------------------
    const latest = await getLatestIteration(input.taskId);
    let artifact: IterationArtifact | null = null;
    let priorModelId: string | undefined = task.modelId ?? undefined;
    if (latest.ok && latest.data) {
      artifact = parseArtifactJson(latest.data.artifactJson);
      priorModelId = latest.data.modelId ?? priorModelId;
    }

    let opportunity: {
      title: string;
      description: string;
      requirements: string;
      category: string;
    } | null = null;
    if (task.opportunityId) {
      const op = await db.opportunity.findUnique({
        where: { id: task.opportunityId },
        select: {
          title: true,
          description: true,
          requirements: true,
          category: true,
        },
      });
      opportunity = op;
    }

    // --- 2. Route to a specialist based on feedback type ------------------
    const specialist = pickSpecialist(feedbackType, opportunity?.category ?? "");

    // --- 3. Pick a DIFFERENT model from the one that produced the prior
    //         artifact (Phase 3 §28). Use the router with excludeModelIds.
    const modelId = await pickImprovementModel(specialist, priorModelId);

    // --- 4. Call the LLM for a structured plan ---------------------------
    const llmPlan = await callPlannerLLM(
      modelId,
      {
        opportunityTitle: opportunity?.title ?? "(no opportunity)",
        opportunityDescription: opportunity?.description ?? "",
        opportunityRequirements: opportunity?.requirements ?? "[]",
        opportunityCategory: opportunity?.category ?? "",
        executorAgent: task.toAgent,
        priorModelId: priorModelId ?? "unknown",
        artifact: artifact,
        feedback: input.feedback,
        feedbackType,
        feedbackPriority,
        feedbackTargetAreas: input.feedbackTargetAreas ?? [],
      },
      { taskId: input.taskId, opportunityId: task.opportunityId ?? undefined }
    );

    // --- 5. Parse the LLM output; fall back to a heuristic plan -----------
    let plan: ImprovementPlan;
    if (llmPlan) {
      plan = {
        requestedChanges: llmPlan.requestedChanges ?? [],
        filesAffected:
          llmPlan.filesAffected ??
          (input.feedbackTargetAreas && input.feedbackTargetAreas.length > 0
            ? input.feedbackTargetAreas
            : deriveFilesAffected(artifact, feedbackType)),
        expectedImprovements: llmPlan.expectedImprovements ?? [],
        risk: clampRisk(llmPlan.risk),
        estimatedTime: clampPositiveNumber(llmPlan.estimatedTime, 60_000),
        estimatedTokens: clampPositiveNumber(llmPlan.estimatedTokens, 4000),
        specialistAgent: specialist,
        modelId,
        testPlan: llmPlan.testPlan ?? defaultTestPlan(feedbackType),
        source: "llm",
      };
    } else {
      plan = heuristicPlan(
        input.feedback,
        feedbackType,
        feedbackPriority,
        specialist,
        modelId,
        artifact,
        input.feedbackTargetAreas
      );
    }

    await logEvent(
      "orchestrator",
      "info",
      "improvement_plan_produced",
      {
        taskId: input.taskId,
        opportunityId: task.opportunityId ?? null,
        specialistAgent: specialist,
        modelId,
        priorModelId: priorModelId ?? null,
        differentFromPrior: priorModelId ? modelId !== priorModelId : true,
        feedbackType,
        feedbackPriority,
        source: plan.source,
        requestedChangesCount: plan.requestedChanges.length,
        filesAffectedCount: plan.filesAffected.length,
        risk: plan.risk,
      },
      task.opportunityId
        ? { opportunityId: task.opportunityId, taskId: input.taskId }
        : { taskId: input.taskId }
    );

    return { ok: true, plan };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[improvement-planner] planImprovement failed:", err);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Specialist routing (Phase 3 §27)
// ---------------------------------------------------------------------------

/**
 * Map a feedback type to the specialist agent best suited to address it.
 *
 *   ui, visuals, gameplay      → coding   (frontend / interactive)
 *   functionality, bugs,
 *     performance, code_quality,
 *     requirements_mismatch,
 *     missing_feature, other    → coding
 *   security                   → security
 *   documentation              → writing
 *
 * The opportunity's category is consulted as a secondary signal: if the
 * opportunity is a grant / docs / content, writing is preferred even for
 * "other" feedback. If the opportunity mentions smart contracts / web3
 * patterns, web3 is preferred for security feedback.
 */
export function pickSpecialist(
  feedbackType: FeedbackType,
  opportunityCategory: string
): SpecialistAgent {
  switch (feedbackType) {
    case "security":
      // Web3 security review goes to the web3 agent when the opportunity is
      // a smart-contract audit / web3 category; otherwise to the security
      // specialist.
      if (
        opportunityCategory === "bug_bounty" ||
        opportunityCategory === "ecosystem"
      ) {
        return "web3";
      }
      return "security";
    case "documentation":
      return "writing";
    case "ui":
    case "visuals":
    case "gameplay":
    case "functionality":
    case "bugs":
    case "performance":
    case "code_quality":
    case "requirements_mismatch":
    case "missing_feature":
    case "other":
    default:
      // Grant applications are mostly narrative — route to writing when the
      // feedback is about general quality on a grant.
      if (
        feedbackType === "code_quality" &&
        (opportunityCategory === "grant" ||
          opportunityCategory === "docs" ||
          opportunityCategory === "content")
      ) {
        return "writing";
      }
      return "coding";
  }
}

// ---------------------------------------------------------------------------
// Model selection — MUST differ from the prior model (Phase 3 §28)
// ---------------------------------------------------------------------------

async function pickImprovementModel(
  specialist: SpecialistAgent,
  priorModelId: string | undefined
): Promise<string> {
  // First, ask the router for a coding/writing/security/web3 model that is
  // NOT the prior model. We pass excludeModelIds so the router never
  // returns the same model that produced the original buggy artifact.
  try {
    const routeResult = await route(
      taskDescriptionForSpecialist(specialist),
      {
        domain: specialist === "web3" ? "web3" : specialist === "security" ? "security" : specialist === "writing" ? "writing" : "coding",
        excludeModelIds: priorModelId ? [priorModelId] : [],
        useLLM: false,
      }
    );
    if (routeResult.models.length > 0) {
      const picked = routeResult.models[0].model_id;
      if (picked !== priorModelId) return picked;
      // Otherwise look further down the list.
      for (const m of routeResult.models) {
        if (m.model_id !== priorModelId) return m.model_id;
      }
    }
  } catch (err) {
    console.warn("[improvement-planner] router failed, falling back:", err);
  }

  // Fallback: query the registry directly for any enabled, healthy model
  // that is NOT the prior model. Prefer the role that fits the specialist.
  try {
    const preferredRole =
      specialist === "security" || specialist === "web3"
        ? "reviewer"
        : "primary";
    const candidates = await getModels({ enabled: true, role: preferredRole as never });
    const different = candidates.find((m) => m.model_id !== priorModelId);
    if (different) return different.model_id;
    if (candidates.length > 0) return candidates[0].model_id;
  } catch (err) {
    console.warn("[improvement-planner] registry fallback failed:", err);
  }

  // Final fallback: a different default model. If we can't find anything,
  // return the prior model + accept the violation (the LLM call will still
  // produce SOMETHING — better than crashing the iteration loop).
  if (priorModelId && priorModelId !== "zai/glm-4.6") {
    return "zai/glm-4.6";
  }
  return priorModelId ?? "zai/glm-4.6";
}

function taskDescriptionForSpecialist(specialist: SpecialistAgent): string {
  switch (specialist) {
    case "web3":
      return "Audit and fix a smart-contract issue in a Web3 bounty";
    case "security":
      return "Security review and remediation of a code vulnerability";
    case "writing":
      return "Revise and improve documentation / writing deliverable";
    case "coding":
    default:
      return "Improve and refactor code based on operator feedback";
  }
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

interface PlannerInput {
  opportunityTitle: string;
  opportunityDescription: string;
  opportunityRequirements: string;
  opportunityCategory: string;
  executorAgent: string;
  priorModelId: string;
  artifact: IterationArtifact | null;
  feedback: string;
  feedbackType: FeedbackType;
  feedbackPriority: FeedbackPriority;
  feedbackTargetAreas: string[];
}

interface LLMPlan {
  requestedChanges?: string[];
  filesAffected?: string[];
  expectedImprovements?: string[];
  risk?: string;
  estimatedTime?: number;
  estimatedTokens?: number;
  testPlan?: string[];
}

async function callPlannerLLM(
  modelId: string,
  input: PlannerInput,
  ctx: { taskId?: string; opportunityId?: string }
): Promise<LLMPlan | null> {
  const systemPrompt = [
    "You are the Improvement Planner for an autonomous crypto-earning agent.",
    "Given a prior artifact (the agent's previous attempt), the operator's",
    "structured feedback, and the original opportunity requirements,",
    "produce a concrete plan for the next iteration.",
    "",
    "Return STRICT JSON with this shape:",
    "{",
    '  "requestedChanges": [string],     // concrete changes the agent must make',
    '  "filesAffected": [string],        // file/area paths to touch',
    '  "expectedImprovements": [string], // quality deltas we expect',
    '  "risk": "low" | "medium" | "high",',
    '  "estimatedTime": number,          // milliseconds',
    '  "estimatedTokens": number,        // LLM token budget',
    '  "testPlan": [string]              // tests to write / run',
    "}",
    "",
    "Rules:",
    "- Be specific. List at least one requested change.",
    "- Files affected should be the actual file paths from the prior artifact",
    "  (or new paths to create).",
    "- Risk = high if the feedback mentions security, data loss, or breaking",
    "  changes. Risk = medium for functionality/performance. Risk = low for",
    "  docs/style/refactors.",
    "- Return ONLY the JSON object.",
  ].join("\n");

  const userPrompt = [
    `Opportunity title: ${input.opportunityTitle}`,
    `Opportunity category: ${input.opportunityCategory}`,
    `Opportunity requirements: ${input.opportunityRequirements}`,
    `Opportunity description:\n${input.opportunityDescription}`,
    "",
    `Executor agent: ${input.executorAgent}`,
    `Prior model: ${input.priorModelId}`,
    "",
    "Prior artifact (JSON):",
    JSON.stringify(input.artifact ?? { approach: "", files: [], tests: [] }).slice(0, 6000),
    "",
    "Operator feedback:",
    `  Text: ${input.feedback}`,
    `  Type: ${input.feedbackType}`,
    `  Priority: ${input.feedbackPriority}`,
    `  Target areas: ${JSON.stringify(input.feedbackTargetAreas)}`,
  ].join("\n");

  try {
    const result = await callLLM({
      modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      maxTokens: 1500,
      temperature: 0.4,
      responseFormat: "json",
      taskType: "planning",
      estimatedTokens: 3000,
      taskId: ctx.taskId,
      opportunityId: ctx.opportunityId,
    });

    if (!result.success || !result.content) {
      await logEvent(
        "orchestrator",
        "warn",
        "improvement_planner_llm_failed",
        {
          taskId: ctx.taskId,
          opportunityId: ctx.opportunityId,
          model: modelId,
          error: result.error,
        },
        ctx
      );
      return null;
    }

    const parsed = parsePlanJson(result.content);
    if (!parsed) {
      await logEvent(
        "orchestrator",
        "warn",
        "improvement_planner_parse_failed",
        {
          taskId: ctx.taskId,
          opportunityId: ctx.opportunityId,
          model: modelId,
        },
        ctx
      );
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("[improvement-planner] callLLM threw:", err);
    return null;
  }
}

function parsePlanJson(raw: string): LLMPlan | null {
  // Accept either a raw JSON object or a JSON object embedded in markdown.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      requestedChanges: stringArrayField(obj, "requestedChanges"),
      filesAffected: stringArrayField(obj, "filesAffected"),
      expectedImprovements: stringArrayField(obj, "expectedImprovements"),
      risk: typeof obj.risk === "string" ? obj.risk : undefined,
      estimatedTime: typeof obj.estimatedTime === "number" ? obj.estimatedTime : undefined,
      estimatedTokens: typeof obj.estimatedTokens === "number" ? obj.estimatedTokens : undefined,
      testPlan: stringArrayField(obj, "testPlan"),
    };
  } catch {
    return null;
  }
}

function stringArrayField(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

// ---------------------------------------------------------------------------
// Heuristic fallback plan
// ---------------------------------------------------------------------------

function heuristicPlan(
  feedback: string,
  feedbackType: FeedbackType,
  feedbackPriority: FeedbackPriority,
  specialist: SpecialistAgent,
  modelId: string,
  artifact: IterationArtifact | null,
  targetAreas: string[] | undefined
): ImprovementPlan {
  const requestedChanges: string[] = [
    `Address operator feedback: ${feedback.slice(0, 200)}`,
  ];
  if (feedbackType === "security") {
    requestedChanges.push("Run the security scanner + remediate every critical finding");
  }
  if (feedbackType === "bugs" || feedbackType === "functionality") {
    requestedChanges.push("Reproduce the failing case + add a regression test");
  }
  if (feedbackType === "performance") {
    requestedChanges.push("Profile the slow path + add a benchmark");
  }
  if (feedbackType === "documentation") {
    requestedChanges.push("Expand the docs section the operator flagged");
  }
  if (feedbackType === "requirements_mismatch" || feedbackType === "missing_feature") {
    requestedChanges.push("Cross-check the deliverable against the opportunity requirements");
  }

  const filesAffected =
    targetAreas && targetAreas.length > 0
      ? targetAreas
      : deriveFilesAffected(artifact, feedbackType);

  const expectedImprovements: string[] = [
    `Reduce ${feedbackType} issues by at least 50%`,
  ];
  if (feedbackPriority === "critical" || feedbackPriority === "high") {
    expectedImprovements.push("Clear all critical/high findings before re-submission");
  }

  const risk: IterationRisk =
    feedbackPriority === "critical"
      ? "high"
      : feedbackPriority === "high"
      ? "medium"
      : "low";

  const estimatedTime =
    feedbackPriority === "critical"
      ? 180_000
      : feedbackPriority === "high"
      ? 120_000
      : feedbackPriority === "medium"
      ? 60_000
      : 30_000;

  const estimatedTokens =
    feedbackPriority === "critical" || feedbackPriority === "high" ? 8000 : 4000;

  return {
    requestedChanges,
    filesAffected,
    expectedImprovements,
    risk,
    estimatedTime,
    estimatedTokens,
    specialistAgent: specialist,
    modelId,
    testPlan: defaultTestPlan(feedbackType),
    source: "heuristic_fallback",
  };
}

function deriveFilesAffected(
  artifact: IterationArtifact | null,
  feedbackType: FeedbackType
): string[] {
  if (!artifact || !artifact.files || artifact.files.length === 0) {
    return feedbackType === "documentation" ? ["docs/"] : ["src/"];
  }
  return artifact.files.map((f) => f.path);
}

function defaultTestPlan(feedbackType: FeedbackType): string[] {
  const base = ["Re-run the existing test suite"];
  if (feedbackType === "security") {
    base.push("Run the security scanner on every changed file");
  }
  if (feedbackType === "bugs" || feedbackType === "functionality") {
    base.push("Add a regression test that reproduces the original failure");
  }
  if (feedbackType === "performance") {
    base.push("Add a benchmark before/after the change");
  }
  base.push("Verify the quality gate returns PASS before re-submission");
  return base;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function parseArtifactJson(json: string): IterationArtifact | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as IterationArtifact;
    if (typeof parsed !== "object" || parsed === null) return null;
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
    return null;
  }
}

function clampRisk(value: unknown): IterationRisk {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

function clampPositiveNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return fallback;
}
