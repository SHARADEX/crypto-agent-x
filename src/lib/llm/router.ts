// LLM Model Router (spec §4F–§4R).
//
// The router answers a single question: "given a task description, which
// model(s) should handle it?" It does this in three stages:
//
//   1. classifyTask  — analyse the task description and decide the routing
//                      level (1 deterministic, 2 cheap, 3 specialist, 4
//                      panel) + the required capabilities. Phase-2 §8:
//                      the classifier is now hierarchical (LEVEL 1
//                      deterministic → LEVEL 2 LLM → LEVEL 3 rule-based),
//                      implemented in `src/lib/llm/classifier.ts`. The
//                      legacy `classifyTask(taskDescription, opts)` is kept
//                      here as a thin sync wrapper that runs LEVEL 1 +
//                      LEVEL 3 only (no LLM) for callers that can't await.
//                      The async `route()` and the new
//                      `routeWithClassification()` run the full
//                      hierarchical classifier including LEVEL 2.
//   2. selectModel   — filter eligible models by health + capabilities, then
//                      rank by `weighted_score` and pick top-1 (or top-N for
//                      panel routing).
//   3. route         — convenience wrapper that chains classifyTask →
//                      selectModel and returns a single RoutingDecision.
//
// Spec §4G LEVEL 1 is handled by `src/lib/llm/deterministic.ts` — the router
// only emits a routing_level=1 decision; the orchestrator is responsible for
// dispatching to the deterministic module.
//
// Spec §4I/§4K adaptive scoring: the router reads per-task-type performance
// stats from the registry and uses them to bias the weighted score. Models
// with no recorded samples fall back to their seed `performance` block.

import {
  getModels,
  getModelPerformanceForTask,
} from "@/lib/llm/registry";
import { getCircuitBreaker } from "@/lib/llm/circuit-breaker";
import { quotaTracker } from "@/lib/llm/quota-tracker";
import { providerRegistry } from "@/lib/llm/provider-registry";
import {
  isTaskEligibleCached,
  refreshCooldownCache,
} from "@/lib/llm/task-cooldown";
import { ROUTING_EXPLORATION } from "@/config/providers";
import type {
  ModelCapabilities,
  ModelPerformance,
  ModelRecord,
  ModelStatus,
  RiskLevel,
  RoutingDecision,
} from "@/lib/agent/types";
import {
  classifyTaskHierarchical,
  classifyTaskSync,
  capabilitiesToThresholds,
  type ClassifyOpts,
  type ClassifyResult,
  type CoarseTaskType,
} from "@/lib/llm/classifier";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClassifyTaskOpts {
  /** Domain hint (e.g. "web3", "research") used to bias classification. */
  domain?: string;
  /** Risk level of the originating task — affects routing_level. */
  riskLevel?: RiskLevel;
}

export interface ClassifyTaskResult {
  task_type: string;
  complexity: "low" | "medium" | "high";
  required_capabilities: Partial<ModelCapabilities>;
  routing_level: 1 | 2 | 3 | 4;
  reason: string;
}

export interface RoutingDecisionInput {
  task_type: string;
  complexity: "low" | "medium" | "high";
  required_capabilities: Partial<ModelCapabilities>;
  routing_level: 1 | 2 | 3 | 4;
  risk_level: RiskLevel;
  /** Number of models to return (1 for levels 1-3, 3 for level 4 panel). */
  panel_size?: number;
  /** Optional context size in characters — affects latency_requirement. */
  context_size?: number;
  /**
   * Model ids to exclude from consideration (Phase-2 P2-6 re-routing loop).
   * Used when the caller has already tried + failed on these models and is
   * re-running the router to pick the next-best candidate.
   */
  excludeModelIds?: string[];
}

export interface RouteResult {
  decision: RoutingDecision;
  models: ModelRecord[];
}

// ---------------------------------------------------------------------------
// classifyTask (spec §4F, §4G, §4H — Phase-2 §8 hierarchical classifier)
// ---------------------------------------------------------------------------

/**
 * Classify a free-text task description into a routing decision.
 *
 * SYNC wrapper around the new hierarchical classifier
 * (`src/lib/llm/classifier.ts`). Runs LEVEL 1 (deterministic) + LEVEL 3
 * (rule-based) only — NO LLM call — so it is safe to call from
 * non-async contexts and from the deterministic dispatch path. The
 * async `route()` and `routeWithClassification()` run the FULL
 * classifier (including the LEVEL 2 LLM classifier) for ambiguous cases.
 *
 * The legacy return shape (task_type / complexity /
 * required_capabilities / routing_level / reason) is preserved for
 * backward compat with `callLLMWithRouter` and `selectModel`.
 *
 * The `task_type` field is the COARSE task type ("web3", "research",
 * "coding", "security", "writing", "general", "wallet_balance",
 * "arithmetic", "json_validation", "file_operation") — the rich fine-
 * grained type ("web3_research", "coding_bounty"…) is exposed via
 * `routeWithClassification()`.
 */
export function classifyTask(
  taskDescription: string,
  opts: ClassifyTaskOpts = {}
): ClassifyTaskResult {
  const result = classifyTaskSync(taskDescription, opts);
  return mapClassifyResultToLegacy(result);
}

/**
 * Map the rich `ClassifyResult` to the legacy `ClassifyTaskResult` shape.
 * Used by `classifyTask` and by `route()` (which goes through the async
 * path).
 */
function mapClassifyResultToLegacy(
  result: ClassifyResult
): ClassifyTaskResult {
  const requiredCapabilities = capabilitiesToThresholds(
    result.required_capabilities
  );
  return {
    task_type: result.coarse_task_type,
    complexity: result.complexity,
    required_capabilities: requiredCapabilities,
    routing_level: result.routing_level,
    reason: result.reason,
  };
}

// ---------------------------------------------------------------------------
// Deterministic detection + keyword classifier — kept for backward compat
// with the legacy `classifyTask` API. The richer hierarchical classifier
// lives in `src/lib/llm/classifier.ts`. Both functions here mirror the
// LEVEL 1 + LEVEL 3 logic so callers that can't await the LLM (LEVEL 2)
// still get a deterministic classification.
// ---------------------------------------------------------------------------

// (LEVEL 1 + LEVEL 3 logic now lives in src/lib/llm/classifier.ts.)

// ---------------------------------------------------------------------------
// selectModel (spec §4H, §4I, §4J, §4K, §4L)
// ---------------------------------------------------------------------------

/**
 * Filter eligible models and pick the best (or best-N for panel routing).
 *
 * Eligibility (spec §4H):
 *   - `enabled === true`
 *   - breaker status != "blacklisted"
 *   - meets every required_capability threshold (>= required value)
 *
 * Ranking (spec §4I, §4K):
 *   `weighted_score =
 *      avg_capability_for_required*0.4
 *    + success_rate*30
 *    + avg_quality*3
 *    - latency_penalty*0.001`
 *
 * Exploration / exploitation (spec §4J):
 *   - 80% exploit best
 *   - 15% explore promising (top-3 randomly)
 *   - 5%  experiment unknown (random pick from eligible)
 *
 * @param decision the routing decision from classifyTask
 * @returns 1 model for routing_level 1-3, or N models for level 4 (panel)
 */
export async function selectModel(
  decision: RoutingDecisionInput
): Promise<ModelRecord[]> {
  // LEVEL 1 has no model — caller dispatches to the deterministic module.
  if (decision.routing_level === 1) {
    return [];
  }

  const requiredCaps = decision.required_capabilities ?? {};
  const requiredKeys = Object.keys(requiredCaps) as (keyof ModelCapabilities)[];
  const excludeModelIds = new Set(decision.excludeModelIds ?? []);

  const panelSize =
    decision.routing_level === 4
      ? Math.max(1, Math.min(5, decision.panel_size ?? 3))
      : 1;

  // --- fetch all enabled models, then filter on capabilities + breaker -----
  const all = await getModels({ enabled: true });
  const breaker = getCircuitBreaker();

  // Phase-3 fix: refresh the in-memory cooldown cache once per routing
  // decision so we exclude models whose (model, taskType) pair is in
  // cooldown WITHOUT a DB round-trip per candidate. Also consults the
  // quota tracker so providers in cooldown (or with zero remaining
  // rate-limit) are excluded upfront rather than failing at call time.
  await refreshCooldownCache();
  const taskType = decision.task_type;

  const eligible: ModelRecord[] = [];
  for (const m of all) {
    if (m.status === "blacklisted") continue;
    if (!breaker.isAvailable(m.model_id)) continue;
    // Phase-2 P2-6: exclude failed models from the re-routing loop.
    if (excludeModelIds.has(m.model_id)) continue;
    // Phase-3 fix: exclude providers whose quota is exhausted (in cooldown
    // or zero remaining rate-limit). The quotaTracker comment claimed the
    // router consulted this — now it actually does.
    if (!quotaTracker.canCall(m.provider)) continue;
    // Phase-3 fix: exclude (model, taskType) pairs in cooldown. The
    // task-cooldown comment claimed the router consulted this — now it
    // does, at route time (previously only checked at call time in
    // callLLM, causing wasted routing + fallback logic on every call).
    if (!isTaskEligibleCached(m.model_id, taskType)) continue;
    // Provider-config gate: the provider-registry docstring claims the
    // router consults it — now it actually does. A model on a provider
    // whose credentials are missing / invalid / quota-exhausted can
    // never succeed, so routing to it just burns the retry + reroute
    // budget (observed: coding tasks routed to gemini-2.5-pro (coding
    // 9.1) with NO GEMINI_API_KEY, failing 3× + 3 reroutes before
    // giving up, while the healthy zai/glm-4.6 was never tried).
    if (providerRegistry.isExcluded(m.provider)) continue;

    // Capabilities threshold check.
    const meetsCaps = requiredKeys.every(
      (k) => (m.capabilities[k] ?? 0) >= (requiredCaps[k] ?? 0)
    );
    if (!meetsCaps) continue;

    eligible.push(m);
  }

  if (eligible.length === 0) {
    // Fall back to ANY enabled model so the router still returns something.
    // The caller (provider.callLLM) will handle the case where the chosen
    // model doesn't actually meet the capability bar.
    return [];
  }

  // --- score every eligible model -----------------------------------------
  const scored = await Promise.all(
    eligible.map(async (m) => ({
      model: m,
      score: await scoreModel(m, decision.task_type, requiredKeys),
    }))
  );

  // Sort by weighted score desc, then by capability average as tiebreaker.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return avgCap(b.model, requiredKeys) - avgCap(a.model, requiredKeys);
  });

  // --- exploration / exploitation (spec §4J) -------------------------------
  const roll = Math.random();
  const explorePromising = ROUTING_EXPLORATION.explore_promising;
  const experimentUnknown = ROUTING_EXPLORATION.experiment_unknown;

  if (decision.routing_level === 4) {
    // Panel routing — return top-N, with a slight exploration bias: if we
    // roll into "explore promising", prepend a random model from positions
    // 2-5 of the ranking (so the panel sees one slightly-off-best model).
    const top = scored.slice(0, panelSize).map((s) => s.model);
    if (roll < explorePromising && scored.length > panelSize) {
      const idx =
        1 + Math.floor(Math.random() * Math.min(scored.length - 1, 5));
      const explorer = scored[idx].model;
      if (!top.find((m) => m.model_id === explorer.model_id)) {
        top[0] = explorer;
      }
    }
    return top;
  }

  // Single-model routing (levels 2, 3).
  if (roll < experimentUnknown && eligible.length > 1) {
    // 5% — try a random eligible model (could be brand new / unknown).
    const idx = Math.floor(Math.random() * eligible.length);
    return [eligible[idx]];
  }
  if (roll < experimentUnknown + explorePromising && scored.length > 1) {
    // 15% — explore top-3 promising (weighted toward rank 1).
    const top3 = scored.slice(0, Math.min(3, scored.length));
    // 60% pick rank 1, 30% rank 2, 10% rank 3 — biased exploration.
    const pickRoll = Math.random();
    const idx =
      pickRoll < 0.6 ? 0 : pickRoll < 0.9 && top3.length > 1 ? 1 : 2;
    return [top3[Math.min(idx, top3.length - 1)].model];
  }

  // 80% — exploit the top-ranked model.
  return [scored[0].model];
}

/**
 * Compute the weighted score (spec §4I, §4K) for a model on a given task type.
 *
 *   weighted_score =
 *     avg_capability_for_required*0.4
 *   + success_rate*30
 *   + avg_quality*3
 *   - latency_penalty*0.001
 *
 * Where:
 *   - `avg_capability_for_required` is the mean of the model's capability
 *     scores in the dimensions the task requires.
 *   - `success_rate`, `avg_quality`, `avg_tokens`, `average_latency` come
 *     from the per-task-type `ModelPerformance` row if it exists; otherwise
 *     they fall back to the seed `performance` block.
 */
async function scoreModel(
  model: ModelRecord,
  taskType: string,
  requiredKeys: (keyof ModelCapabilities)[]
): Promise<number> {
  // Capability average across the required dimensions.
  const avgCapRequired =
    requiredKeys.length > 0
      ? requiredKeys.reduce((sum, k) => sum + (model.capabilities[k] ?? 0), 0) /
        requiredKeys.length
      : 5;

  // Per-task-type performance (falls back to seed perf).
  const perfStat = await getModelPerformanceForTask(model.model_id, taskType);
  const basePerf: ModelPerformance = perfStat
    ? {
        success_rate: perfStat.success_rate,
        average_quality: perfStat.avg_quality || model.performance.average_quality,
        average_latency: perfStat.avg_latency || model.performance.average_latency,
        average_tokens: perfStat.avg_tokens || model.performance.average_tokens,
        failure_rate: perfStat.failure_rate,
      }
    : model.performance;

  const success_rate = clamp01(basePerf.success_rate);
  const avg_quality = basePerf.average_quality;
  const avg_latency = basePerf.average_latency;

  // Weighted score (spec §4I).
  const score =
    avgCapRequired * 0.4 +
    success_rate * 30 +
    avg_quality * 3 -
    avg_latency * 0.001;

  return score;
}

function avgCap(
  model: ModelRecord,
  requiredKeys: (keyof ModelCapabilities)[]
): number {
  if (requiredKeys.length === 0) {
    const all = Object.values(model.capabilities) as number[];
    return all.reduce((a, b) => a + b, 0) / Math.max(1, all.length);
  }
  return (
    requiredKeys.reduce((s, k) => s + (model.capabilities[k] ?? 0), 0) /
    requiredKeys.length
  );
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ---------------------------------------------------------------------------
// route — top-level convenience (classifyTask → selectModel → RoutingDecision)
// ---------------------------------------------------------------------------

export interface RouteOpts extends ClassifyTaskOpts {
  /**
   * Model ids to exclude from consideration (Phase-2 P2-6 re-routing loop).
   * Forwarded to `selectModel` so the re-routing loop can pass a growing
   * exclusion list when previous models failed.
   */
  excludeModelIds?: string[];
  /** Override the panel size for level-4 routing. */
  panelSize?: number;
  /**
   * Phase-2 §8: whether to use the LEVEL 2 LLM classifier for ambiguous
   * tasks. Defaults to `true`. Set `false` to force LEVEL 3 (rule-based).
   */
  useLLM?: boolean;
}

/**
 * Top-level routing convenience. Chains `classifyTaskHierarchical` →
 * `selectModel` and returns a complete `RoutingDecision` along with the
 * selected model(s).
 *
 * Phase-2 §8: now runs the FULL hierarchical classifier (LEVEL 1
 * deterministic → LEVEL 2 LLM → LEVEL 3 rule-based) via
 * `classifyTaskHierarchical`. Callers that need the rich
 * `ClassifyResult` (with `web_access_required`, `coding_required`,
 * `risk_level`, etc.) should call `routeWithClassification()` instead.
 *
 * The returned `decision` is suitable for persisting on a `Task` row's
 * metadata so the dashboard / review agent can reconstruct routing intent.
 *
 * Pass `excludeModelIds` to re-route after a failed call (P2-6).
 */
export async function route(
  taskDescription: string,
  opts: RouteOpts = {}
): Promise<RouteResult> {
  const fullResult = await routeWithClassification(taskDescription, opts);
  return { decision: fullResult.decision, models: fullResult.models };
}

/**
 * Full hierarchical routing — runs `classifyTaskHierarchical` and returns
 * the rich `ClassifyResult` ALONGSIDE the legacy `RoutingDecision` + the
 * selected models. This is the entry point callers should use when they
 * need to know e.g. `web_access_required` (to decide whether to invoke
 * the research tools) or `tool_use_required` (to decide whether to expose
 * tools to the model).
 *
 * Pass `excludeModelIds` to re-route after a failed call (P2-6).
 * Pass `useLLM: false` to force LEVEL 3 (rule-based only) — useful for
 * tests / offline runs / cost-sensitive callers.
 */
export async function routeWithClassification(
  taskDescription: string,
  opts: RouteOpts = {}
): Promise<RouteWithClassificationResult> {
  const classifyOpts: ClassifyOpts = {
    domain: opts.domain,
    riskLevel: opts.riskLevel,
    useLLM: opts.useLLM,
  };
  const classification = await classifyTaskHierarchical(
    taskDescription,
    classifyOpts
  );
  const legacy = mapClassifyResultToLegacy(classification);

  const risk: RiskLevel = opts.riskLevel ?? classification.risk_level;
  const decisionInput: RoutingDecisionInput = {
    task_type: legacy.task_type,
    complexity: legacy.complexity,
    required_capabilities: legacy.required_capabilities,
    routing_level: legacy.routing_level,
    risk_level: risk,
    panel_size: opts.panelSize ?? 3,
    context_size: taskDescription.length,
    excludeModelIds: opts.excludeModelIds,
  };

  const models = await selectModel(decisionInput);

  const decision: RoutingDecision = {
    task_type: legacy.task_type,
    complexity: legacy.complexity,
    required_capabilities: legacy.required_capabilities,
    context_size: taskDescription.length,
    latency_requirement: deriveLatencyRequirement(legacy.complexity),
    reliability_requirement: deriveReliabilityRequirement(risk),
    risk_level: risk,
    routing_level: legacy.routing_level,
    selected_models: models.map((m) => m.model_id),
    reason: legacy.reason,
  };

  return { decision, models, classification };
}

export interface RouteWithClassificationResult {
  decision: RoutingDecision;
  models: ModelRecord[];
  /** Rich hierarchical classification (Phase-2 §8). */
  classification: ClassifyResult;
}

function deriveLatencyRequirement(
  complexity: ClassifyTaskResult["complexity"]
): "low" | "medium" | "high" {
  // Low-complexity tasks → low latency tolerance (must be fast).
  // High-complexity tasks → high latency tolerance (slow is OK).
  if (complexity === "low") return "low";
  if (complexity === "medium") return "medium";
  return "high";
}

function deriveReliabilityRequirement(
  risk: RiskLevel
): "low" | "medium" | "high" {
  if (risk === "high" || risk === "moderate") return "high";
  if (risk === "low") return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Status helpers (re-exported for callers that need ModelStatus checks)
// ---------------------------------------------------------------------------

export function isModelHealthy(status: ModelStatus): boolean {
  return status === "healthy";
}

export function isModelRoutable(status: ModelStatus): boolean {
  return status === "healthy" || status === "degraded";
}
