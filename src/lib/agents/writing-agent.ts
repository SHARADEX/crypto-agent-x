// Writing / Documentation Agent (spec §4B).
//
// For documentation / content opportunities ONLY. Uses the LLM to draft a
// doc / article / README based on the opportunity's requirements. Returns the
// draft so the Review Agent can verify it satisfies the original
// opportunity requirements before submission.
//
// Spec §4B note: "Only use this agent when the opportunity actually rewards
// this type of work." The orchestrator is responsible for routing only
// `docs` / `content` / `oss_contribution`-style opportunities to this agent.

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import { callLLM } from "@/lib/llm/provider";
import { route } from "@/lib/llm/router";
import { sanitizeExternalContent } from "@/lib/security/prompt-injection";
import type { AgentInput, AgentOutput } from "@/lib/agents/types";
import { fail, fieldString, fieldStringArray, ok } from "@/lib/agents/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WritingDraft {
  title: string;
  format: string; // markdown | readme | article | tutorial | api-docs
  content: string;
  word_count: number;
  meets_requirements: boolean;
  notes: string[];
  model: string;
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

export async function execute(input: AgentInput): Promise<AgentOutput> {
  const taskId = (input.task?.id as string | undefined) ?? undefined;
  const opportunityId =
    (input.opportunity?.id as string | undefined) ?? undefined;

  if (!opportunityId) {
    return fail("writing agent requires an opportunity id");
  }

  try {
    const op = await db.opportunity.findUnique({
      where: { id: opportunityId },
    });
    if (!op) {
      return fail(`opportunity ${opportunityId} not found`);
    }

    const format = fieldString(input.context, "format", "markdown");
    const repoContext = fieldString(input.context, "repoContext", "");

    // Sanitize before sending to the LLM (spec §21).
    const sanitize = sanitizeExternalContent(
      `${op.title}\n${op.description ?? ""}\n${
        fieldStringArray({ requirements: op.requirements }, "requirements").join("\n") ?? ""
      }`,
      `opportunity:${opportunityId}:writing`
    );
    const safeContext = sanitize.sanitized || (op.description ?? "");

    // --- 1. Route to a writing-capable model -----------------------------
    const routeResult = await route(
      `Write documentation: ${op.title}`,
      { domain: "writing", riskLevel: "low" }
    );
    const model = routeResult.models[0]?.model_id ?? "zai/glm-4.6";

    // --- 2. Call the LLM for the draft -----------------------------------
    const draft = await callWritingLLM(
      model,
      {
        title: op.title,
        description: safeContext,
        format,
        repoContext,
        requirements: fieldStringArray(
          { requirements: op.requirements },
          "requirements"
        ),
        skillsRequired: fieldStringArray(
          { skillsRequired: op.skillsRequired },
          "skillsRequired"
        ),
        estimatedHours: op.estimatedHours,
        organization: op.organization,
      },
      { taskId, opportunityId }
    );

    // --- 3. Persist the draft to the Task row ----------------------------
    if (taskId) {
      try {
        await db.task.update({
          where: { id: taskId },
          data: {
            output: JSON.stringify(draft),
            modelId: model,
            qualityScore: 7,
          },
        });
      } catch (err) {
        console.error("[writing-agent] task output persist failed:", err);
      }
    }

    await logEvent(
      "writing",
      "info",
      "writing_draft_generated",
      {
        opportunityId,
        model,
        format,
        wordCount: draft.word_count,
        meetsRequirements: draft.meets_requirements,
      },
      { taskId, opportunityId }
    );

    return ok(
      draft as unknown as Record<string, unknown>,
      {
        qualityScore: draft.meets_requirements ? 7 : 4,
        nextAgent: "review",
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[writing-agent] execute threw:", err);
    await logEvent(
      "writing",
      "error",
      "writing_failed",
      { opportunityId, error: message },
      { taskId, opportunityId }
    );
    return fail(`writing agent crashed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

interface LlmInput {
  title: string;
  description: string;
  format: string;
  repoContext: string;
  requirements: string[];
  skillsRequired: string[];
  estimatedHours: number;
  organization: string;
}

async function callWritingLLM(
  modelId: string,
  op: LlmInput,
  ctx: { taskId?: string; opportunityId?: string }
): Promise<WritingDraft> {
  const systemPrompt = [
    "You are the Writing / Documentation Agent for an autonomous crypto-earning system.",
    "Draft a document for the opportunity below.",
    "",
    "Return STRICT JSON with this shape:",
    "{",
    '  "title": string,',
    '  "format": string,',
    '  "content": string (markdown),',
    '  "meets_requirements": boolean,',
    '  "notes": string[]',
    "}",
    "",
    "Rules:",
    "- Only use information supported by the opportunity's description.",
    "- Match the requested format precisely.",
    "- Set meets_requirements=false if you cannot fully address the requirements.",
    "- Return ONLY the JSON object — no preamble, no markdown fences.",
  ].join("\n");

  const userPrompt = [
    `Title: ${op.title}`,
    `Organization: ${op.organization}`,
    `Format: ${op.format}`,
    `Estimated hours: ${op.estimatedHours}`,
    `Skills: ${op.skillsRequired.join(", ") || "(none)"}`,
    `Requirements: ${op.requirements.join("; ") || "(none)"}`,
    op.repoContext ? `Repo context:\n${op.repoContext}` : "",
    `Description:\n${op.description}`,
  ]
    .filter((x) => x.length > 0)
    .join("\n");

  try {
    const result = await callLLM({
      modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      maxTokens: 2500,
      temperature: 0.5,
      taskType: "writing",
      estimatedTokens: 2800,
      taskId: ctx.taskId,
      opportunityId: ctx.opportunityId,
    });

    if (result.success && result.content) {
      const parsed = parseDraft(result.content, op.format);
      if (parsed) {
        parsed.model = modelId;
        return parsed;
      }
    }

    await logEvent(
      "writing",
      "warn",
      "writing_llm_failed_fallback",
      {
        opportunityId: ctx.opportunityId,
        model: modelId,
        error: result.error,
      },
      ctx
    );
  } catch (err) {
    console.error("[writing-agent] callLLM threw:", err);
  }

  // Deterministic fallback: minimal scaffold. The Review Agent will flag
  // it as incomplete.
  return {
    title: op.title,
    format: op.format,
    content: `# ${op.title}\n\n(Documentation draft could not be generated automatically — please write manually.)`,
    word_count: 0,
    meets_requirements: false,
    notes: ["LLM unavailable — placeholder draft returned for human review."],
    model: modelId,
  };
}

function parseDraft(raw: string, requestedFormat: string): WritingDraft | null {
  // The LLM may not strictly follow the JSON contract — extract a {...}
  // block to be tolerant of stray text.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }

  const title = typeof obj.title === "string" ? obj.title : "";
  const format = typeof obj.format === "string" ? obj.format : requestedFormat;
  const content = typeof obj.content === "string" ? obj.content : "";
  const meetsRequirements = obj.meets_requirements === true;
  const notes = Array.isArray(obj.notes)
    ? obj.notes.filter((x): x is string => typeof x === "string")
    : [];

  return {
    title,
    format,
    content,
    word_count: countWords(content),
    meets_requirements: meetsRequirements,
    notes,
    model: "",
  };
}

function countWords(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}
