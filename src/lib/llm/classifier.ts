// Hierarchical task classifier (Phase-2 spec §8, P2-1).
//
// The previous `classifyTask` in `router.ts` was pure keyword matching + a
// character-count complexity heuristic. This module replaces it with a
// 3-level hierarchical classifier that returns rich structured output:
//
//   LEVEL 1 — DETERMINISTIC  (no LLM, confidence 1.0). Detects "wallet
//                            balance", "arithmetic", "JSON validation",
//                            "file operation" tasks that the deterministic
//                            module can answer authoritatively (spec §4G).
//
//   LEVEL 2 — LLM CLASSIFIER (small/fast model, confidence 0.7). For
//                            ambiguous tasks the keyword matcher can't
//                            confidently place, ask a cheap LLM for a
//                            strict-JSON classification. Validates the
//                            JSON and falls back to LEVEL 3 on failure.
//
//   LEVEL 3 — RULE-BASED     (no LLM, confidence 0.5). Enhanced keyword
//                            matching with domain inference, characteristic-
//                            based complexity, web/coding/security/tool
//                            flags, and routing_level escalation.
//
// `classifyTaskHierarchical` is the public entry point. `router.ts` keeps
// the legacy `classifyTask(taskDescription, opts)` signature as a thin
// wrapper that delegates here and maps the rich result to the legacy
// `ClassifyTaskResult` shape (for backward compat with `callLLMWithRouter`
// and `selectModel`).

import { callLLM } from "@/lib/llm/provider";
import { validateJSON } from "@/lib/llm/deterministic";
import { logEvent } from "@/lib/agent/events";
import type { ModelCapabilities, RiskLevel } from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Coarse routing task_type — kept stable for the existing router / scorer. */
export type CoarseTaskType =
  | "web3"
  | "security"
  | "coding"
  | "research"
  | "writing"
  | "general"
  | "wallet_balance"
  | "arithmetic"
  | "json_validation"
  | "file_operation";

/** Rich structured output of the hierarchical classifier. */
export interface ClassifyResult {
  /** Fine-grained task type (e.g. "web3_research", "coding_bounty"). */
  task_type: string;
  /**
   * Coarse task type consumed by the existing router / scorer — kept stable
   * so this drop-in doesn't break `selectModel` / `scoreModel` / per-task
   * performance tracking in the registry.
   */
  coarse_task_type: CoarseTaskType;
  /** Inferred domain ("ethereum", "solana", "rust", "typescript", "" …). */
  domain: string;
  complexity: "low" | "medium" | "high";
  /** Capability NAMES (not thresholds) — ["research","web3","reasoning"]. */
  required_capabilities: string[];
  web_access_required: boolean;
  coding_required: boolean;
  security_required: boolean;
  tool_use_required: boolean;
  output_format: "structured_json" | "text" | "code" | "diff";
  risk_level: RiskLevel;
  routing_level: 1 | 2 | 3 | 4;
  /** Classifier self-confidence in [0,1]. */
  confidence: number;
  /** Short human-readable explanation of the decision. */
  reason: string;
  /** Which classification level handled the task. */
  classified_by: "level1_deterministic" | "level2_llm" | "level3_rule";
}

export interface ClassifyOpts {
  /** Domain hint (e.g. "web3", "research") used to bias classification. */
  domain?: string;
  /** Risk level of the originating task — affects routing_level. */
  riskLevel?: RiskLevel;
  /**
   * Whether to consult the LEVEL 2 LLM classifier for ambiguous cases.
   * Defaults to `true`. Set `false` to force LEVEL 3 (rule-based) only —
   * useful for tests / offline runs / cost-sensitive callers.
   */
  useLLM?: boolean;
}

// ---------------------------------------------------------------------------
// Capability name → ModelCapabilities key map
// ---------------------------------------------------------------------------

/** Map a coarse capability name to the corresponding ModelCapabilities key. */
const CAPABILITY_KEYS: Record<string, keyof ModelCapabilities> = {
  reasoning: "reasoning",
  coding: "coding",
  research: "research",
  web_research: "web_research",
  web3: "web3",
  security: "security",
  writing: "writing",
  tool_use: "tool_use",
  structured_output: "structured_output",
};

/**
 * Convert a list of capability names to the partial ModelCapabilities shape
 * the existing `selectModel` expects (with conservative default thresholds
 * of 7 for primary capabilities, 6 for secondary).
 */
export function capabilitiesToThresholds(
  caps: string[]
): Partial<ModelCapabilities> {
  const out: Partial<ModelCapabilities> = {};
  for (const c of caps) {
    const key = CAPABILITY_KEYS[c];
    if (key) {
      out[key] = Math.max(out[key] ?? 0, 7);
    }
  }
  return out;
}

/** Convert a coarse task type to the rich task_type label. */
function richTaskType(coarse: CoarseTaskType, desc: string): string {
  switch (coarse) {
    case "wallet_balance":
      return "wallet_balance_query";
    case "arithmetic":
      return "arithmetic_computation";
    case "json_validation":
      return "json_validation";
    case "file_operation":
      return "file_operation";
    case "web3": {
      if (/\b(audit|security|vulnerab|exploit)\b/.test(desc))
        return "security_audit";
      if (/\b(bounty|bug bounty)\b/.test(desc)) return "web3_bounty";
      if (/\b(research|investigate|analyse|analyze)\b/.test(desc))
        return "web3_research";
      return "web3_task";
    }
    case "security":
      return "security_audit";
    case "coding":
      if (/\b(bounty|pr|pull request)\b/.test(desc)) return "coding_bounty";
      if (/\b(refactor)\b/.test(desc)) return "code_refactor";
      return "coding_task";
    case "research":
      return "research_task";
    case "writing":
      return "writing_task";
    default:
      return "general_task";
  }
}

// ---------------------------------------------------------------------------
// LEVEL 1 — deterministic detection (spec §4G)
// ---------------------------------------------------------------------------

interface Level1Match {
  task_type: CoarseTaskType;
  reason: string;
}

function detectDeterministic(desc: string): Level1Match | null {
  if (/\b(wallet|balance|wallet balance|funds?|holdings?)\b/.test(desc)) {
    return { task_type: "wallet_balance", reason: "wallet-balance query detected" };
  }
  if (/\b(arithmetic|calculate|compute|how much is|what is \d|\d\s*[+\-*/]\s*\d)\b/.test(desc)) {
    return { task_type: "arithmetic", reason: "arithmetic expression detected" };
  }
  if (/\b(json|validate json|parse json|is valid json)\b/.test(desc)) {
    return { task_type: "json_validation", reason: "JSON validation detected" };
  }
  if (/\b(file operation|read file|write file|fs\.|file system)\b/.test(desc)) {
    return { task_type: "file_operation", reason: "file operation detected" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// LEVEL 3 — rule-based classification (enhanced keyword matcher)
// ---------------------------------------------------------------------------

const DOMAIN_PATTERNS: Array<{ regex: RegExp; domain: string }> = [
  { regex: /\b(ethereum|eth|evm|solidity|erc20|erc721|erc1155|smart contract|uniswap|aave|compound|defi)\b/i, domain: "ethereum" },
  { regex: /\b(solana|sol|rust|anchor|metaplex|magic eden)\b/i, domain: "solana" },
  { regex: /\b(bitcoin|btc|lightning|ordinals|brc20)\b/i, domain: "bitcoin" },
  { regex: /\b(tron|trx|trc20|just swap|sun\.io)\b/i, domain: "tron" },
  { regex: /\b(ronin|axie|sky mavis)\b/i, domain: "ronin" },
  { regex: /\b(cosmos|atom|ibc|tendermint|osmosis)\b/i, domain: "cosmos" },
  { regex: /\b(polkadot|dot|substrate)\b/i, domain: "polkadot" },
  { regex: /\b(typescript|javascript|ts|js|node|nodejs|react|next\.?js)\b/i, domain: "typescript" },
  { regex: /\b(rust|cargo)\b/i, domain: "rust" },
  { regex: /\b(python|py|django|flask|fastapi)\b/i, domain: "python" },
  { regex: /\b(golang|go lang|gopher)\b/i, domain: "go" },
];

/**
 * Infer the technical / chain domain from the description. The first match
 * wins — order matters so a "solidity on solana" query is classified by the
 * most specific match (none of our patterns are mutually exclusive here, so
 * the first hit is the most specific).
 */
function inferDomain(desc: string, hint?: string): string {
  if (hint) {
    const h = hint.toLowerCase();
    // Domain hint overrides inference — the caller usually knows better.
    if (
      [
        "ethereum",
        "solana",
        "bitcoin",
        "tron",
        "ronin",
        "cosmos",
        "polkadot",
        "typescript",
        "rust",
        "python",
        "go",
        "web3",
        "blockchain",
      ].includes(h)
    ) {
      // Map "web3" / "blockchain" generic hints to "" — the inference
      // engine will then try to identify a specific chain.
      if (h === "web3" || h === "blockchain") {
        // fall through to inference
      } else {
        return h;
      }
    }
  }
  for (const p of DOMAIN_PATTERNS) {
    if (p.regex.test(desc)) return p.domain;
  }
  return "";
}

interface RuleClass {
  coarse: CoarseTaskType;
  capabilities: string[];
}

function ruleClassify(desc: string, domainHint?: string): RuleClass {
  // Domain hint can short-circuit the keyword scan — but we still infer
  // capabilities from the description below.
  if (domainHint) {
    const d = domainHint.toLowerCase();
    if (d === "web3" || d === "blockchain") {
      return { coarse: "web3", capabilities: ["web3", "security", "reasoning"] };
    }
    if (d === "security" || d === "audit") {
      return { coarse: "security", capabilities: ["security", "reasoning"] };
    }
    if (d === "coding" || d === "code") {
      return { coarse: "coding", capabilities: ["coding", "tool_use"] };
    }
    if (d === "research") {
      return { coarse: "research", capabilities: ["research", "web_research", "reasoning"] };
    }
    if (d === "writing" || d === "docs") {
      return { coarse: "writing", capabilities: ["writing"] };
    }
  }

  // Keyword precedence — most specific first.
  if (/\b(smart contract|solidity|web3|evm|erc20|erc721|nft|defi|uniswap|aave|compound)\b/.test(desc)) {
    return { coarse: "web3", capabilities: ["web3", "security", "reasoning"] };
  }
  if (/\b(verify|scam|security|malicious|phishing|drainer|exploit|vulnerab|attack vector)\b/.test(desc)) {
    return { coarse: "security", capabilities: ["security", "reasoning"] };
  }
  if (/\b(code|implement|debug|refactor|fix bug|typescript|javascript|python|rust|api|endpoint|function)\b/.test(desc)) {
    return { coarse: "coding", capabilities: ["coding", "tool_use"] };
  }
  if (/\b(research|investigate|analyze|analyse|explore|compare|survey|literature|benchmark)\b/.test(desc)) {
    return { coarse: "research", capabilities: ["research", "web_research", "reasoning"] };
  }
  if (/\b(document|tutorial|readme|guide|how-to|write article|blog post|essay|summary|report)\b/.test(desc)) {
    return { coarse: "writing", capabilities: ["writing"] };
  }
  return { coarse: "general", capabilities: ["reasoning"] };
}

// ---------------------------------------------------------------------------
// LEVEL 3 — derived flags (web/coding/security/tool/output/risk/complexity)
// ---------------------------------------------------------------------------

function deriveWebAccess(desc: string): boolean {
  return /\b(research|investigate|find|latest|current|compare sources|search the web|web search|browse|fetch url|what'?s new)\b/.test(desc);
}

function deriveCoding(desc: string): boolean {
  return /\b(implement|fix|code|function|pr\b|pull request|refactor|patch|commit|bug fix|debug|test|build|deploy)\b/.test(desc);
}

function deriveSecurity(desc: string): boolean {
  return /\b(audit|vulnerab|exploit|malicious|scam|phishing|drainer|attack vector|security)\b/.test(desc);
}

function deriveToolUse(desc: string): boolean {
  return /\b(fetch|search|browse|call api|invoke|use tool|tool use|rpc|http request|api call)\b/.test(desc);
}

function deriveOutputFormat(
  coarse: CoarseTaskType,
  desc: string
): "structured_json" | "text" | "code" | "diff" {
  if (coarse === "coding") {
    if (/\b(diff|patch|pr\b|pull request|review changes)\b/.test(desc)) return "diff";
    return "code";
  }
  if (coarse === "research" || coarse === "security" || coarse === "json_validation") {
    return "structured_json";
  }
  if (coarse === "writing") return "text";
  // General + wallet_balance + arithmetic + file_operation → JSON-friendly.
  return "structured_json";
}

function deriveComplexity(
  caps: string[],
  desc: string,
  coarse: CoarseTaskType
): "low" | "medium" | "high" {
  // Count distinct required capabilities + explicit constraint markers
  // + integration / multi-step cues. This is characteristic-based, NOT
  // length-based — a 50-char "integrate web3 + audit + write tests" task
  // is high-complexity even though the old character-count heuristic
  // would have called it "low".
  let score = 0;
  score += Math.min(caps.length, 4); // up to 4 points for capability breadth
  if (/\b(multi-step|multi step|end-to-end|end to end|integrate|integration|orchestrat|pipeline|workflow)\b/.test(desc)) {
    score += 2;
  }
  // Count "and" / "then" / "also" as a weak proxy for constraint count.
  const conjunctions = (desc.match(/\b(and|then|also|plus|finally)\b/gi) || []).length;
  score += Math.min(conjunctions, 3);
  if (coarse === "security" || coarse === "web3") score += 1; // these are inherently harder.

  if (score <= 2) return "low";
  if (score <= 5) return "medium";
  return "high";
}

function deriveRiskLevel(
  desc: string,
  coarse: CoarseTaskType,
  fallback: RiskLevel
): RiskLevel {
  const hasFinancial = /\b(payment|pay|fund|wallet|transfer|reward|bounty|prize|earn|deposit|withdraw|stake|airdrop)\b/i.test(desc);
  const hasExecution = /\b(execute|sign|approve|transaction|swap|deploy|send|interact|call contract)\b/i.test(desc);
  const hasObservationOnly = /\b(read|check|balance|view|inspect|list|show|fetch)\b/i.test(desc) && !hasExecution && !hasFinancial;

  if (deriveSecurity(desc) && hasFinancial) return "high";
  if (coarse === "web3" && hasExecution) return "moderate";
  if (coarse === "security" || (coarse === "web3" && hasFinancial)) return "moderate";
  if (hasObservationOnly) return "read";
  if (fallback === "high" || fallback === "moderate") return fallback;
  return "low";
}

function deriveRoutingLevel(
  coarse: CoarseTaskType,
  complexity: "low" | "medium" | "high",
  risk: RiskLevel,
  isLevel1: boolean
): 1 | 2 | 3 | 4 {
  if (isLevel1) return 1;
  if (risk === "high" || complexity === "high") return 4;
  if (coarse === "security" || coarse === "web3") return 3;
  if (complexity === "medium" || risk === "moderate") return 3;
  return 2;
}

// ---------------------------------------------------------------------------
// LEVEL 3 — assemble the full result from the rule-based classifier
// ---------------------------------------------------------------------------

function assembleLevel3(
  desc: string,
  opts: ClassifyOpts
): ClassifyResult {
  const rule = ruleClassify(desc, opts.domain);
  const domain = inferDomain(desc, opts.domain);
  const webAccess = deriveWebAccess(desc);
  const coding = deriveCoding(desc);
  const security = deriveSecurity(desc);
  const toolUse = deriveToolUse(desc);
  const outputFormat = deriveOutputFormat(rule.coarse, desc);
  const risk = deriveRiskLevel(desc, rule.coarse, opts.riskLevel ?? "low");
  const complexity = deriveComplexity(rule.capabilities, desc, rule.coarse);
  const routingLevel = deriveRoutingLevel(rule.coarse, complexity, risk, false);
  const rich = richTaskType(rule.coarse, desc);

  return {
    task_type: rich,
    coarse_task_type: rule.coarse,
    domain,
    complexity,
    required_capabilities: rule.capabilities,
    web_access_required: webAccess,
    coding_required: coding,
    security_required: security,
    tool_use_required: toolUse,
    output_format: outputFormat,
    risk_level: risk,
    routing_level: routingLevel,
    confidence: 0.5,
    reason: `LEVEL 3 rule-based: coarse=${rule.coarse}, domain=${domain || "(none)"}, complexity=${complexity}, risk=${risk}, routing_level=${routingLevel}`,
    classified_by: "level3_rule",
  };
}

// ---------------------------------------------------------------------------
// LEVEL 2 — LLM classifier (cheap, fast model + strict JSON)
// ---------------------------------------------------------------------------

const LEVEL2_SYSTEM_PROMPT = [
  "You are a task classifier for an autonomous crypto-earning agent.",
  "Classify the user's task description and return STRICT JSON with this exact shape:",
  "{",
  '  "task_type": "web3_research" | "coding_bounty" | "security_audit" | "research" | "writing" | "general" | "wallet_balance" | "arithmetic" | "json_validation" | "file_operation",',
  '  "domain": "ethereum" | "solana" | "bitcoin" | "tron" | "ronin" | "cosmos" | "polkadot" | "typescript" | "rust" | "python" | "go" | "",',
  '  "complexity": "low" | "medium" | "high",',
  '  "required_capabilities": string[],  // e.g. ["research","web3","reasoning"]',
  '  "web_access_required": boolean,',
  '  "coding_required": boolean,',
  '  "security_required": boolean,',
  '  "tool_use_required": boolean,',
  '  "output_format": "structured_json" | "text" | "code" | "diff",',
  '  "risk_level": "read" | "low" | "moderate" | "high"',
  "}",
  "",
  "Rules:",
  "- complexity is based on capability breadth, constraint count, and integration cues — NOT character count.",
  "- A task with 1 capability + clear single deliverable → low.",
  "- A task mentioning multi-step / integrate / end-to-end → high.",
  "- security + financial → risk_level high; web3 + execution → moderate; pure read-only → read.",
  "Return ONLY the JSON object — no markdown fences, no preamble.",
].join("\n");

/** Map an LLM-reported task_type to the coarse task_type for router compat. */
function coarseFromLLMTaskType(
  taskType: string,
  desc: string
): CoarseTaskType {
  const t = (taskType ?? "").toLowerCase();
  if (t === "wallet_balance") return "wallet_balance";
  if (t === "arithmetic") return "arithmetic";
  if (t === "json_validation") return "json_validation";
  if (t === "file_operation") return "file_operation";
  if (t.startsWith("web3") || t === "security_audit") {
    if (/\b(audit|security|vulnerab|exploit)\b/.test(desc)) return "security";
    return "web3";
  }
  if (t.startsWith("security")) return "security";
  if (t.startsWith("coding")) return "coding";
  if (t.startsWith("research")) return "research";
  if (t.startsWith("writing")) return "writing";
  return "general";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function coerceBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function coerceComplexity(v: unknown, fallback: "low" | "medium" | "high"): "low" | "medium" | "high" {
  if (v === "low" || v === "medium" || v === "high") return v;
  return fallback;
}

function coerceOutputFormat(
  v: unknown,
  fallback: "structured_json" | "text" | "code" | "diff"
): "structured_json" | "text" | "code" | "diff" {
  if (v === "structured_json" || v === "text" || v === "code" || v === "diff") {
    return v;
  }
  return fallback;
}

function coerceRiskLevel(
  v: unknown,
  fallback: RiskLevel
): RiskLevel {
  if (v === "read" || v === "low" || v === "moderate" || v === "high") {
    return v;
  }
  return fallback;
}

/**
 * Run the LEVEL 2 LLM classifier. NEVER throws — returns null on any failure
 * (timeout, invalid JSON, missing fields) so the caller can fall back to
 * LEVEL 3.
 *
 * Uses the existing `callLLM` budget/circuit-breaker/retry/re-routing stack
 * so the classifier respects the same quotas as every other LLM call. The
 * model defaults to "zai/glm-4.6" because that's the auto-provisioned free
 * model in this environment; callers can override via the
 * `CRYPTOEAR_CLASSIFIER_MODEL` env var if they want a cheaper / faster
 * classifier.
 */
async function classifyWithLLM(
  desc: string,
  opts: ClassifyOpts
): Promise<ClassifyResult | null> {
  const modelId =
    process.env.CRYPTOEAR_CLASSIFIER_MODEL ?? "zai/glm-4.6";

  const userPrompt = `Task: "${desc.slice(0, 1500)}"`;

  let content = "";
  try {
    const result = await callLLM({
      modelId,
      messages: [
        { role: "system", content: LEVEL2_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      maxTokens: 400,
      temperature: 0.0,
      responseFormat: "json",
      taskType: "task_classifier",
      estimatedTokens: 800,
    });
    if (!result.success) {
      await logEvent(
        "task_classifier",
        "debug",
        "level2_llm_failed",
        {
          modelId,
          error: result.error,
          fallbackAction: result.fallback_action,
        },
        {}
      ).catch(() => null);
      return null;
    }
    content = result.content;
  } catch (err) {
    console.error("[classifier] LEVEL 2 LLM call threw:", err);
    return null;
  }

  if (!content) return null;
  const validated = validateJSON(stripJsonFences(content));
  if (!validated.valid || !validated.parsed || typeof validated.parsed !== "object") {
    return null;
  }
  const obj = validated.parsed as Record<string, unknown>;

  const taskTypeRaw = typeof obj.task_type === "string" ? obj.task_type : "";
  if (!taskTypeRaw) return null;

  const coarse = coarseFromLLMTaskType(taskTypeRaw, desc);
  const domain = typeof obj.domain === "string" ? obj.domain : "";
  const complexity = coerceComplexity(obj.complexity, deriveComplexity(["reasoning"], desc, coarse));
  const requiredCaps = isStringArray(obj.required_capabilities)
    ? obj.required_capabilities
    : ["reasoning"];
  const webAccess = coerceBool(obj.web_access_required, deriveWebAccess(desc));
  const coding = coerceBool(obj.coding_required, deriveCoding(desc));
  const security = coerceBool(obj.security_required, deriveSecurity(desc));
  const toolUse = coerceBool(obj.tool_use_required, deriveToolUse(desc));
  const outputFormat = coerceOutputFormat(obj.output_format, deriveOutputFormat(coarse, desc));
  const risk = coerceRiskLevel(obj.risk_level, opts.riskLevel ?? "low");
  const routingLevel = deriveRoutingLevel(coarse, complexity, risk, false);

  return {
    task_type: taskTypeRaw,
    coarse_task_type: coarse,
    domain,
    complexity,
    required_capabilities: requiredCaps,
    web_access_required: webAccess,
    coding_required: coding,
    security_required: security,
    tool_use_required: toolUse,
    output_format: outputFormat,
    risk_level: risk,
    routing_level: routingLevel,
    confidence: 0.7,
    reason: `LEVEL 2 LLM classifier: coarse=${coarse}, domain=${domain || "(none)"}, complexity=${complexity}, risk=${risk}, routing_level=${routingLevel}`,
    classified_by: "level2_llm",
  };
}

function stripJsonFences(text: string): string {
  // Some models wrap JSON in ```json ... ``` fences despite the prompt.
  const trimmed = (text ?? "").trim();
  if (trimmed.startsWith("```")) {
    const withoutFence = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "");
    return withoutFence.trim();
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Public entry point: classifyTaskHierarchical
// ---------------------------------------------------------------------------

/**
 * Hierarchically classify a free-text task description.
 *
 *   1. Try LEVEL 1 deterministic detection (no LLM).
 *   2. If LEVEL 1 misses and `useLLM !== false`, try LEVEL 2 LLM classifier.
 *   3. If LEVEL 2 fails or is disabled, fall back to LEVEL 3 rule-based.
 *
 * Never throws — always returns a `ClassifyResult`.
 */
export async function classifyTaskHierarchical(
  taskDescription: string,
  opts: ClassifyOpts = {}
): Promise<ClassifyResult> {
  const desc = (taskDescription ?? "").toLowerCase();
  const fallbackRisk: RiskLevel = opts.riskLevel ?? "low";

  // --- LEVEL 1 -------------------------------------------------------------
  const level1 = detectDeterministic(desc);
  if (level1) {
    const rich = richTaskType(level1.task_type, desc);
    return {
      task_type: rich,
      coarse_task_type: level1.task_type,
      domain: "",
      complexity: "low",
      required_capabilities: [],
      web_access_required: false,
      coding_required: false,
      security_required: false,
      tool_use_required: false,
      output_format: deriveOutputFormat(level1.task_type, desc),
      risk_level: "read",
      routing_level: 1,
      confidence: 1.0,
      reason: `LEVEL 1 deterministic match: ${level1.reason}`,
      classified_by: "level1_deterministic",
    };
  }

  // --- LEVEL 2 (LLM) -------------------------------------------------------
  if (opts.useLLM !== false) {
    try {
      const llm = await classifyWithLLM(taskDescription ?? "", opts);
      if (llm) {
        // Override the risk with the caller-supplied hint when it is stricter.
        if (
          fallbackRisk === "high" &&
          llm.risk_level !== "high"
        ) {
          llm.risk_level = "high";
          llm.routing_level = deriveRoutingLevel(
            llm.coarse_task_type,
            llm.complexity,
            "high",
            false
          );
          llm.reason += " (risk escalated to high by caller hint)";
        }
        return llm;
      }
    } catch (err) {
      // Should never happen — classifyWithLLM already swallows errors — but
      // be defensive anyway so the classifier NEVER throws.
      console.error("[classifier] LEVEL 2 unexpectedly threw:", err);
    }
  }

  // --- LEVEL 3 (rule-based) -----------------------------------------------
  return assembleLevel3(desc, opts);
}

/**
 * Synchronous LEVEL-1 + LEVEL-3 only classifier. Used by callers that can't
 * await an LLM call (e.g. the deterministic dispatch path in `provider.ts`'s
 * re-routing loop). Never throws.
 */
export function classifyTaskSync(
  taskDescription: string,
  opts: ClassifyOpts = {}
): ClassifyResult {
  const desc = (taskDescription ?? "").toLowerCase();
  const level1 = detectDeterministic(desc);
  if (level1) {
    const rich = richTaskType(level1.task_type, desc);
    return {
      task_type: rich,
      coarse_task_type: level1.task_type,
      domain: "",
      complexity: "low",
      required_capabilities: [],
      web_access_required: false,
      coding_required: false,
      security_required: false,
      tool_use_required: false,
      output_format: deriveOutputFormat(level1.task_type, desc),
      risk_level: "read",
      routing_level: 1,
      confidence: 1.0,
      reason: `LEVEL 1 deterministic match: ${level1.reason}`,
      classified_by: "level1_deterministic",
    };
  }
  return assembleLevel3(desc, opts);
}

// ---------------------------------------------------------------------------
// Re-exports for callers that need them
// ---------------------------------------------------------------------------

export type { RiskLevel };
