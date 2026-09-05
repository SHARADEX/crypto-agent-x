// Web3 Agent (spec §4B).
//
// For Web3 / smart-contract opportunities ONLY. Uses the LLM to analyse
// smart-contract requirements (the contract's interface, the calls the agent
// would need to make, the trust assumptions), then runs `inspectGeneratedCode`
// on any Solidity snippets in the response (spec §32).
//
// HARD RULE (spec §4B): "It must NEVER automatically approve unknown contract
// interactions." This agent returns analysis + safety findings only. The
// orchestrator MUST escalate any contract interaction to human approval
// (level 3) before the Execution Agent is allowed to act.

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import { callLLM } from "@/lib/llm/provider";
import { route } from "@/lib/llm/router";
import { validateJSON } from "@/lib/llm/deterministic";
import { inspectGeneratedCode } from "@/lib/security/code-safety";
import { sanitizeExternalContent } from "@/lib/security/prompt-injection";
import type { AgentInput, AgentOutput } from "@/lib/agents/types";
import { fail, fieldString, fieldStringArray, ok } from "@/lib/agents/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Web3AnalysisResult {
  contract_summary: string;
  required_interactions: Array<{
    target: string;
    method: string;
    risk: "read" | "low" | "moderate" | "high";
    rationale: string;
  }>;
  trust_assumptions: string[];
  red_flags: string[];
  requires_human_approval: boolean;
  safety: {
    safe: boolean;
    riskScore: number;
    findings: Array<{ id: string; severity: string; detail: string }>;
  };
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
    return fail("web3 agent requires an opportunity id");
  }

  try {
    const op = await db.opportunity.findUnique({
      where: { id: opportunityId },
    });
    if (!op) {
      return fail(`opportunity ${opportunityId} not found`);
    }

    const contractSource = fieldString(input.context, "contractSource", "");
    const sanitize = sanitizeExternalContent(
      `${op.title}\n${op.description ?? ""}\n${contractSource}`,
      `opportunity:${opportunityId}:web3`
    );
    const safeContext = sanitize.sanitized || (op.description ?? "");

    // --- 1. Route to a web3-capable model ----------------------------------
    const routeResult = await route(
      `Analyse smart contract: ${op.title}`,
      { domain: "web3", riskLevel: "moderate" }
    );
    const model = routeResult.models[0]?.model_id ?? "zai/glm-4.6";

    // --- 2. Call the LLM for the analysis ---------------------------------
    const analysis = await callWeb3LLM(
      model,
      {
        title: op.title,
        description: safeContext,
        contractSource,
        requirements: fieldStringArray(
          { requirements: op.requirements },
          "requirements"
        ),
        skillsRequired: fieldStringArray(
          { skillsRequired: op.skillsRequired },
          "skillsRequired"
        ),
      },
      { taskId, opportunityId }
    );

    // --- 3. Inspect any Solidity snippets in the contract source ----------
    let worstRisk = 0;
    const allFindings: Web3AnalysisResult["safety"]["findings"] = [];
    if (contractSource) {
      const inspection = inspectGeneratedCode(contractSource, "solidity");
      worstRisk = inspection.riskScore;
      for (const f of inspection.findings) {
        allFindings.push({
          id: f.id,
          severity: f.severity,
          detail: f.detail,
        });
      }
    }
    // Any contract interaction more dangerous than a read requires human
    // approval (spec §4B — "NEVER automatically approve unknown contract
    // interactions").
    const requiresHumanApproval =
      analysis.required_interactions.some((i) => i.risk !== "read") ||
      worstRisk >= 30 ||
      analysis.red_flags.length > 0;

    analysis.safety = {
      safe: worstRisk < 50 && !requiresHumanApproval,
      riskScore: worstRisk,
      findings: allFindings,
    };
    analysis.requires_human_approval = requiresHumanApproval;

    // --- 4. Persist + log --------------------------------------------------
    if (taskId) {
      try {
        await db.task.update({
          where: { id: taskId },
          data: {
            output: JSON.stringify(analysis),
            modelId: model,
            qualityScore: analysis.safety.safe ? 7 : 3,
          },
        });
      } catch (err) {
        console.error("[web3-agent] task output persist failed:", err);
      }
    }

    await logEvent(
      "web3",
      requiresHumanApproval ? "warn" : "info",
      requiresHumanApproval
        ? "web3_analysis_requires_approval"
        : "web3_analysis_complete",
      {
        opportunityId,
        model,
        contractSummary: analysis.contract_summary,
        interactionCount: analysis.required_interactions.length,
        redFlagCount: analysis.red_flags.length,
        trustAssumptions: analysis.trust_assumptions.length,
        safetyRiskScore: worstRisk,
        requiresHumanApproval,
      },
      { taskId, opportunityId }
    );

    return ok(
      analysis as unknown as Record<string, unknown>,
      {
        qualityScore: analysis.safety.safe ? 7 : 3,
        nextAgent: requiresHumanApproval ? undefined : "review",
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[web3-agent] execute threw:", err);
    await logEvent(
      "web3",
      "error",
      "web3_analysis_failed",
      { opportunityId, error: message },
      { taskId, opportunityId }
    );
    return fail(`web3 agent crashed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

interface LlmInput {
  title: string;
  description: string;
  contractSource: string;
  requirements: string[];
  skillsRequired: string[];
}

async function callWeb3LLM(
  modelId: string,
  op: LlmInput,
  ctx: { taskId?: string; opportunityId?: string }
): Promise<Web3AnalysisResult> {
  const systemPrompt = [
    "You are the Web3 Agent for an autonomous crypto-earning system.",
    "Analyse the smart-contract requirements below. Return STRICT JSON:",
    "{",
    '  "contract_summary": string,',
    '  "required_interactions": [',
    '    {"target": string, "method": string, "risk": "read"|"low"|"moderate"|"high", "rationale": string}',
    "  ],",
    '  "trust_assumptions": string[],',
    '  "red_flags": string[]',
    "}",
    "",
    "Rules:",
    "- Be conservative. If an interaction involves spending, signing, or approving,",
    "  set risk to 'high'.",
    "- Never approve contract interactions automatically.",
    "- Return ONLY the JSON object.",
  ].join("\n");

  const userPrompt = [
    `Title: ${op.title}`,
    `Skills required: ${op.skillsRequired.join(", ") || "(none)"}`,
    `Requirements: ${op.requirements.join("; ") || "(none)"}`,
    op.contractSource
      ? `Contract source:\n${op.contractSource}`
      : "(no contract source provided)",
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
      maxTokens: 1500,
      temperature: 0.3,
      responseFormat: "json",
      taskType: "web3",
      estimatedTokens: 2200,
      taskId: ctx.taskId,
      opportunityId: ctx.opportunityId,
    });

    if (result.success && result.content) {
      const parsed = parseAnalysis(result.content);
      if (parsed) {
        parsed.model = modelId;
        return parsed;
      }
    }

    await logEvent(
      "web3",
      "warn",
      "web3_llm_failed_fallback",
      {
        opportunityId: ctx.opportunityId,
        model: modelId,
        error: result.error,
      },
      ctx
    );
  } catch (err) {
    console.error("[web3-agent] callLLM threw:", err);
  }

  // Deterministic fallback: empty analysis, requires human approval.
  return {
    contract_summary: "LLM unavailable — manual review required.",
    required_interactions: [],
    trust_assumptions: [],
    red_flags: ["LLM analysis unavailable — escalate for human review."],
    requires_human_approval: true,
    safety: { safe: false, riskScore: 0, findings: [] },
    model: modelId,
  };
}

function parseAnalysis(raw: string): Web3AnalysisResult | null {
  const validated = validateJSON(raw);
  if (!validated.valid || !validated.parsed || typeof validated.parsed !== "object") {
    return null;
  }
  const obj = validated.parsed as Record<string, unknown>;
  const contractSummary =
    typeof obj.contract_summary === "string" ? obj.contract_summary : "";
  const interactionsRaw = Array.isArray(obj.required_interactions)
    ? obj.required_interactions
    : [];
  const required_interactions: Web3AnalysisResult["required_interactions"] = [];
  for (const i of interactionsRaw) {
    if (typeof i !== "object" || i === null) continue;
    const item = i as Record<string, unknown>;
    const risk = item.risk;
    required_interactions.push({
      target: typeof item.target === "string" ? item.target : "",
      method: typeof item.method === "string" ? item.method : "",
      risk:
        risk === "read" || risk === "low" || risk === "moderate" || risk === "high"
          ? risk
          : "moderate",
      rationale:
        typeof item.rationale === "string" ? item.rationale : "",
    });
  }
  const trust_assumptions = Array.isArray(obj.trust_assumptions)
    ? obj.trust_assumptions.filter((x): x is string => typeof x === "string")
    : [];
  const red_flags = Array.isArray(obj.red_flags)
    ? obj.red_flags.filter((x): x is string => typeof x === "string")
    : [];

  return {
    contract_summary: contractSummary,
    required_interactions,
    trust_assumptions,
    red_flags,
    requires_human_approval: false, // computed by the caller
    safety: { safe: true, riskScore: 0, findings: [] },
    model: "",
  };
}
