// LLM provider abstraction (spec §19, §4C–§4R, Phase-2 P2-1 / P2-6 / P2-7).
//
// `callLLM` is the single entry point every specialist agent uses to ask an
// LLM a question. It owns the full call lifecycle:
//
//   1. Budget pre-check     — `BudgetManager.canRunTask(estimatedTokens)`
//   2. Circuit-breaker gate — `CircuitBreaker.isAvailable(modelId)`
//   3. Provider dispatch   — looks up the provider adapter by
//                            `model.provider` and calls `.generate(opts)`
//                            (Phase-2 P2-1: replaces the inline switch).
//   4. Retry with backoff  — up to 2 retries, `500ms * 2^attempt`
//   5. Re-routing fallback — Phase-2 P2-6: instead of a one-shot
//                            `pickFallbackModel`, exclude the failed
//                            model from the router's ranking and
//                            re-run `selectModel` to pick the next-best.
//                            Loop up to N=3 distinct models before
//                            degrading to deterministic.
//   6. Budget post-record   — `BudgetManager.recordLlmCall(modelId, tokens, success)`
//   7. Performance record   — `recordModelPerformance(modelId, taskType, ...)`
//   8. Circuit-breaker tick — `recordSuccess` / `recordFailure`
//   9. Quota tracking       — `quotaTracker.record(provider, usage, rateLimit)`
//  10. Event log            — `logEvent("model_router", ...)` for audit trail
//
// `callLLM` NEVER throws — it always returns a `CallLLMResult` object with
// `success: boolean` and a structured `error` string when something went
// wrong. Callers can dispatch on `success` and inspect `fallback_action`
// when the LLM stack was completely unreachable.

import { BudgetManager } from "@/lib/budget/manager";
import { logEvent, getProcessRunId } from "@/lib/agent/events";
import {
  getModel,
  getModels,
  recordModelPerformance,
} from "@/lib/llm/registry";
import { getCircuitBreaker } from "@/lib/llm/circuit-breaker";
import { recordTaskOutcome, isTaskEligibleCached, refreshCooldownCache } from "@/lib/llm/task-cooldown";
import { route, selectModel } from "@/lib/llm/router";
import type { RoutingDecisionInput } from "@/lib/llm/router";
import type { ModelCapabilities, ModelRecord, Provider } from "@/lib/agent/types";
import { getProvider } from "@/lib/llm/providers";
import { providerRegistry } from "@/lib/llm/provider-registry";
import { quotaTracker } from "@/lib/llm/quota-tracker";
import type {
  AIProvider,
  GenerateOpts,
  GenerateResult,
  ProviderStatus,
} from "@/lib/llm/providers/types";

// Re-export so callers that want to attribute a runId to their own logEvent
// calls (e.g. the orchestrator loop, the benchmark runner) can reuse the
// process-default when they don't have a cycle-scoped runId handy.
export { getProcessRunId };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CallLLMOpts {
  /** The model to route to (e.g. "zai/glm-4.6"). */
  modelId: string;
  /** Conversation history. At least one message is required. */
  messages: ChatMessage[];
  /** Max output tokens. Defaults to 1024. */
  maxTokens?: number;
  /** Sampling temperature 0..2. Defaults to 0.7. */
  temperature?: number;
  /** Force the response to be parseable as JSON. Defaults to "text". */
  responseFormat?: "text" | "json";
  /** Task id (for event-log linkage + per-task budget attribution). */
  taskId?: string;
  /** Opportunity id (for event-log linkage). */
  opportunityId?: string;
  /**
   * Task-type hint used when recording per-task-type performance stats.
   * Defaults to "general".
   */
  taskType?: string;
  /**
   * Estimated total tokens (prompt + completion). Used for the budget
   * pre-check only — actual usage is recorded after the call. Defaults to
   * a conservative 1500.
   */
  estimatedTokens?: number;
  /**
   * Phase-2 P2-21: runId used to correlate every `logEvent` call inside
   * this `callLLM` invocation. When omitted, the per-process default is
   * used. The orchestrator loop generates a fresh runId per cycle and
   * threads it through every callLLM so the dashboard can group events
   * by cycle.
   */
  runId?: string;
}

export interface CallLLMResult {
  /** Did the LLM produce a usable response? */
  success: boolean;
  /** The text the model returned (or the deterministic fallback). */
  content: string;
  /** Token usage. Zero on failure. */
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  /** Wall-clock latency of the successful attempt, in ms. */
  latencyMs: number;
  /** The model id that actually produced the response (may differ from the
   *  requested modelId if a fallback was used). */
  model: string;
  /** Provider that produced the response. */
  provider: Provider | "deterministic";
  /** Number of retries used. */
  retries: number;
  /** Structured error string when `success === false`. */
  error?: string;
  /** When the LLM stack was completely unreachable, this signals the
   *  orchestrator to degrade / queue / escalate. */
  fallback_action?: "degrade_to_deterministic" | "queue_task" | "human_intervention";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TASK_TYPE = "general";
const DEFAULT_ESTIMATED_TOKENS = 1500;

const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;

/** Maximum distinct models the re-routing loop will try before degrading. */
const MAX_RE_ROUTE_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// callLLM — the main entry point
// ---------------------------------------------------------------------------

/**
 * Send a chat-completion request to an LLM. Handles budget, circuit-breaker,
 * retries, the Phase-2 re-routing fallback loop, and performance recording.
 *
 * Never throws — always returns a `CallLLMResult`.
 *
 * MOCK MODE (Phase-2 §31, P2-16): when `process.env.MOCK_MODE === "true"`,
 * `callLLM` short-circuits and returns a canned response from
 * `tests/fixtures/mock-llm-responses.ts` based on `opts.taskType`. This lets
 * the test suite + the mock-simulation script + CI run the full agent
 * lifecycle without spending real LLM tokens or hitting rate-limited APIs.
 * The canned responses are deterministic — the same taskType always returns
 * the same string.
 */
export async function callLLM(opts: CallLLMOpts): Promise<CallLLMResult> {
  const modelId = opts.modelId;
  const taskType = opts.taskType ?? DEFAULT_TASK_TYPE;
  const taskId = opts.taskId;
  const opportunityId = opts.opportunityId;
  // Phase-2 P2-21: every event this call emits shares the same runId so the
  // dashboard can correlate budget_precheck_failed → llm_call_failed →
  // llm_call_rerouting → llm_call_succeeded across the full call lifecycle.
  const runId = opts.runId ?? getProcessRunId();

  // ----- MOCK MODE short-circuit -------------------------------------------
  // Tests + the mock simulation script set MOCK_MODE=true so the full agent
  // pipeline runs without burning real LLM tokens. The canned response is
  // keyed by taskType (research / coding / review / writing / task_classifier
  // / web3 / general). See `tests/fixtures/mock-llm-responses.ts`.
  if ((process.env.MOCK_MODE ?? "").toLowerCase() === "true") {
    return getMockCallResult(taskType, modelId, opts);
  }

  // ----- validate inputs -------------------------------------------------
  if (!modelId || typeof modelId !== "string") {
    return makeErrorResult(
      "",
      "zai",
      "callLLM: modelId is required",
      { fallback_action: "degrade_to_deterministic" }
    );
  }
  if (!Array.isArray(opts.messages) || opts.messages.length === 0) {
    return makeErrorResult(
      modelId,
      "zai",
      "callLLM: at least one message is required",
      { fallback_action: "degrade_to_deterministic" }
    );
  }

  const model = await getModel(modelId);
  if (!model) {
    return makeErrorResult(
      modelId,
      "zai",
      `callLLM: model "${modelId}" not found in registry`,
      { fallback_action: "degrade_to_deterministic" }
    );
  }

  // ----- Phase-2 P2-8 — per-(model, taskType) cooldown check ---------------
  // Refresh the in-memory cooldown cache (5s TTL) + check if this model is
  // currently in cooldown for this task type. If so, re-route to a fallback.
  await refreshCooldownCache();
  if (!isTaskEligibleCached(modelId, taskType)) {
    await logEvent(
      "model_router",
      "warn",
      "task_cooldown_active",
      { modelId, taskType, taskId, opportunityId },
      { taskId, opportunityId, runId, provider: model.provider, model: modelId }
    );
    // Try a fallback model that's not in cooldown for this task type.
    const fallback = await pickReRoutedModel(model, taskType, [modelId]);
    if (fallback) {
      return callLLM({
        ...opts,
        modelId: fallback.model_id,
      });
    }
    return makeErrorResult(
      modelId,
      model.provider,
      `callLLM: model "${modelId}" is in cooldown for task type "${taskType}"`,
      { fallback_action: "degrade_to_deterministic" }
    );
  }

  // ----- budget pre-check (spec §27) ------------------------------------
  const estimatedTokens =
    opts.estimatedTokens && opts.estimatedTokens > 0
      ? opts.estimatedTokens
      : DEFAULT_ESTIMATED_TOKENS;
  try {
    const bm = BudgetManager.getInstance();
    const allowed = await bm.canRunTask(estimatedTokens);
    if (!allowed) {
      await logEvent(
        "model_router",
        "warn",
        "budget_precheck_failed",
        { modelId, taskType, estimatedTokens, taskId, opportunityId },
        { taskId, opportunityId, runId, provider: model.provider, model: modelId }
      );
      return makeErrorResult(
        modelId,
        model.provider,
        `callLLM: budget pre-check failed (estimated ${estimatedTokens} tokens would exceed daily/hourly/per-task cap)`,
        { fallback_action: "queue_task", retries: 0 }
      );
    }
  } catch (err) {
    // Budget manager should never throw, but if it does we don't want to
    // crash the agent — log and proceed cautiously.
    console.error("[llm] budget pre-check threw:", err);
  }

  // ----- attempt the call (with Phase-2 re-routing loop) -----------------
  const failedModelIds: string[] = [];
  let currentModel = model;
  let lastError: string | undefined;
  let totalRetries = 0;
  const startedAt = Date.now();

  for (
    let routeAttempt = 0;
    routeAttempt < MAX_RE_ROUTE_ATTEMPTS;
    routeAttempt++
  ) {
    // ----- circuit-breaker gate ------------------------------------------
    const breaker = getCircuitBreaker();
    if (!breaker.isAvailable(currentModel.model_id)) {
      await logEvent(
        "model_router",
        "warn",
        "circuit_breaker_open",
        {
          modelId: currentModel.model_id,
          taskType,
          status: breaker.getStatus(currentModel.model_id),
          attempt: routeAttempt,
          taskId,
          opportunityId,
        },
        {
          taskId,
          opportunityId,
          runId,
          provider: currentModel.provider,
          model: currentModel.model_id,
          fallback: routeAttempt > 0,
        }
      );
      // Re-route to next-best model — don't burn a routeAttempt on this.
      const next = await pickReRoutedModel(
        currentModel,
        taskType,
        failedModelIds
      );
      if (!next) {
        return makeErrorResult(
          currentModel.model_id,
          currentModel.provider,
          `callLLM: circuit breaker open for ${currentModel.model_id} and no re-route candidate left`,
          { fallback_action: "degrade_to_deterministic" }
        );
      }
      failedModelIds.push(currentModel.model_id);
      currentModel = next;
      continue; // re-check breaker on the new model
    }

    // ----- attempt the call with retry + backoff -------------------------
    let attemptRetries = 0;
    let attemptFailed = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delayMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        await sleep(delayMs);
        attemptRetries = attempt;
      }

      try {
        const attemptStart = Date.now();
        const raw = await dispatchToProvider(currentModel, opts);
        const attemptLatency = Date.now() - attemptStart;

        if (!raw.success) {
          lastError = raw.error ?? "unknown provider error";
          breaker.recordFailure(currentModel.model_id);
          // Update provider-registry + quota tracker based on mapped status.
          if (raw.status) {
            providerRegistry.setStatus(currentModel.provider, raw.status);
            if (
              raw.status === "rate_limited" ||
              raw.status === "quota_exhausted"
            ) {
              quotaTracker.setCooldown(
                currentModel.provider,
                raw.rateLimitHeaders?.retryAfter ?? 60
              );
            }
          }
          if (raw.rateLimitHeaders) {
            quotaTracker.record(
              currentModel.provider,
              { requests: 1, tokens: raw.usage.promptTokens + raw.usage.completionTokens },
              raw.rateLimitHeaders
            );
          } else {
            quotaTracker.record(
              currentModel.provider,
              { requests: 1, tokens: raw.usage.promptTokens + raw.usage.completionTokens },
              undefined
            );
          }
          // Phase-2 P2-8 — record the per-(model, taskType) failure so the
          // task-cooldown subsystem can engage after N consecutive failures.
          await recordTaskOutcome(currentModel.model_id, taskType, false);
          await logEvent(
            "model_router",
            "warn",
            "llm_call_failed",
            {
              modelId: currentModel.model_id,
              taskType,
              attempt,
              routeAttempt,
              error: lastError,
              status: raw.status,
              taskId,
              opportunityId,
            },
            {
              taskId,
              opportunityId,
              runId,
              provider: currentModel.provider,
              model: currentModel.model_id,
              tokens: raw.usage.promptTokens + raw.usage.completionTokens,
              fallback: routeAttempt > 0,
              error: lastError,
            }
          );
          attemptFailed = true;
          continue; // retry
        }

        // ---- success ----
        const totalLatency = Date.now() - startedAt;
        const promptTokens = raw.usage.promptTokens;
        const completionTokens = raw.usage.completionTokens;
        const totalTokens = promptTokens + completionTokens;

        breaker.recordSuccess(currentModel.model_id);
        totalRetries += attemptRetries;
        await Promise.all([
          BudgetManager.getInstance().recordLlmCall(
            currentModel.model_id,
            totalTokens,
            true
          ),
          recordModelPerformance(
            currentModel.model_id,
            taskType,
            true,
            attemptLatency,
            totalTokens
          ),
          // Phase-2 P2-8 — record the per-(model, taskType) outcome so the
          // task-cooldown subsystem can exclude this model from this task type
          // if it keeps failing.
          recordTaskOutcome(currentModel.model_id, taskType, true),
          logEvent(
            "model_router",
            "info",
            "llm_call_succeeded",
            {
              modelId: currentModel.model_id,
              taskType,
              attempt,
              routeAttempt,
              promptTokens,
              completionTokens,
              latencyMs: attemptLatency,
              taskId,
              opportunityId,
            },
            {
              taskId,
              opportunityId,
              runId,
              provider: currentModel.provider,
              model: currentModel.model_id,
              tokens: totalTokens,
              latencyMs: attemptLatency,
              fallback: routeAttempt > 0,
            }
          ),
        ]);
        if (raw.rateLimitHeaders) {
          quotaTracker.record(
            currentModel.provider,
            { requests: 1, tokens: totalTokens },
            raw.rateLimitHeaders
          );
        } else {
          quotaTracker.record(
            currentModel.provider,
            { requests: 1, tokens: totalTokens },
            undefined
          );
        }

        return {
          success: true,
          content: raw.content,
          usage: { promptTokens, completionTokens },
          latencyMs: attemptLatency,
          model: currentModel.model_id,
          provider: currentModel.provider,
          retries: totalRetries,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        breaker.recordFailure(currentModel.model_id);
        console.error(
          `[llm] callLLM attempt ${attempt} (route ${routeAttempt}) threw:`,
          err
        );
        attemptFailed = true;
      }
    }

    // ----- inner retry loop exhausted — re-route to next-best model ------
    await logEvent(
      "model_router",
      "error",
      "llm_call_exhausted_retries",
      {
        modelId: currentModel.model_id,
        taskType,
        retries: attemptRetries,
        routeAttempt,
        lastError,
        taskId,
        opportunityId,
      },
      {
        taskId,
        opportunityId,
        runId,
        provider: currentModel.provider,
        model: currentModel.model_id,
        fallback: true,
        error: lastError,
      }
    );

    totalRetries += attemptRetries;
    failedModelIds.push(currentModel.model_id);

    const next = await pickReRoutedModel(currentModel, taskType, failedModelIds);
    if (!next) {
      // No more candidates — degrade to deterministic.
      return makeErrorResult(
        currentModel.model_id,
        currentModel.provider,
        lastError ?? "all providers failed",
        { fallback_action: "degrade_to_deterministic", retries: totalRetries }
      );
    }

    await logEvent(
      "model_router",
      "info",
      "llm_call_rerouting",
      {
        fromModel: currentModel.model_id,
        toModel: next.model_id,
        taskType,
        routeAttempt: routeAttempt + 1,
        excludeModelIds: failedModelIds,
        taskId,
        opportunityId,
      },
      {
        taskId,
        opportunityId,
        runId,
        provider: next.provider,
        model: next.model_id,
        fallback: true,
        error: lastError,
      }
    );
    currentModel = next;
  }

  // ----- re-routing loop exhausted --------------------------------------
  return makeErrorResult(
    currentModel.model_id,
    currentModel.provider,
    lastError ?? "all re-route candidates failed",
    { fallback_action: "degrade_to_deterministic", retries: totalRetries }
  );
}

// ---------------------------------------------------------------------------
// Provider dispatch (Phase-2 P2-1: registry lookup, not a switch)
// ---------------------------------------------------------------------------

interface ProviderRawResult {
  success: boolean;
  content: string;
  usage: { promptTokens: number; completionTokens: number };
  error?: string;
  status?: ProviderStatus;
  rateLimitHeaders?: import("@/lib/llm/providers/types").RateLimitHeaders;
}

/**
 * Look up the AIProvider adapter for the model's provider and call
 * `.generate(opts)`. Returns a normalized {@link ProviderRawResult} so the
 * retry loop above can dispatch on `success` uniformly.
 */
async function dispatchToProvider(
  model: ModelRecord,
  opts: CallLLMOpts
): Promise<ProviderRawResult> {
  const provider = getProvider(model.provider);
  if (!provider) {
    return {
      success: false,
      content: "",
      usage: { promptTokens: 0, completionTokens: 0 },
      error: `unsupported provider: ${model.provider} (no adapter registered)`,
      status: "not_configured",
    };
  }

  if (!provider.isConfigured()) {
    return {
      success: false,
      content: "",
      usage: { promptTokens: 0, completionTokens: 0 },
      error: `provider not configured: ${model.provider}`,
      status: "not_configured",
    };
  }

  const genOpts: GenerateOpts = {
    model: model.model_id,
    messages: opts.messages,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    responseFormat: opts.responseFormat,
  };

  let result: GenerateResult;
  try {
    result = await provider.generate(genOpts);
  } catch (err) {
    // The provider should never throw (per the AIProvider contract), but
    // wrap defensively so callLLM never throws.
    return {
      success: false,
      content: "",
      usage: { promptTokens: 0, completionTokens: 0 },
      error: err instanceof Error ? err.message : String(err),
      status: "unhealthy",
    };
  }

  return {
    success: result.success,
    content: result.content,
    usage: result.usage,
    error: result.error,
    status: result.status,
    rateLimitHeaders: result.rateLimitHeaders,
  };
}

// ---------------------------------------------------------------------------
// Phase-2 P2-6 re-routing fallback
// ---------------------------------------------------------------------------

/**
 * Pick the next-best model when the primary failed. Re-runs `selectModel`
 * with the growing exclusion set so the ranking recomputes from the
 * remaining eligible models (Phase-2 §10 / P2-6).
 *
 * Returns null when no candidates remain.
 */
async function pickReRoutedModel(
  failed: ModelRecord,
  taskType: string,
  excludeModelIds: string[]
): Promise<ModelRecord | null> {
  // Build a minimal routing decision from the failed model's capabilities
  // so the next pick has roughly the same capability bar (within ±2).
  const requiredCaps: Partial<ModelCapabilities> = {};
  const capKeys = Object.keys(failed.capabilities) as (keyof ModelCapabilities)[];
  for (const k of capKeys) {
    const v = failed.capabilities[k] ?? 0;
    requiredCaps[k] = Math.max(1, Math.min(10, v - 2));
  }

  const decision: RoutingDecisionInput = {
    task_type: taskType,
    complexity: "medium",
    required_capabilities: requiredCaps,
    routing_level: 2,
    risk_level: "low",
    excludeModelIds,
  };

  try {
    const remaining = await selectModel(decision);
    if (remaining.length > 0) return remaining[0];
  } catch (err) {
    console.error("[llm] pickReRoutedModel: selectModel failed:", err);
  }

  // Last resort: any enabled model that isn't excluded + isn't breaker-open +
  // isn't in task cooldown for this task type (Phase-2 P2-8).
  try {
    const all = await getModels({ enabled: true });
    const breaker = getCircuitBreaker();
    const anyCandidate = all.find(
      (m) =>
        !excludeModelIds.includes(m.model_id) &&
        m.model_id !== failed.model_id &&
        m.status !== "blacklisted" &&
        breaker.isAvailable(m.model_id) &&
        isTaskEligibleCached(m.model_id, taskType)
    );
    return anyCandidate ?? null;
  } catch (err) {
    console.error("[llm] pickReRoutedModel: getModels fallback failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeErrorResult(
  modelId: string,
  provider: Provider | "deterministic",
  error: string,
  extra?: Partial<CallLLMResult>
): CallLLMResult {
  return {
    success: false,
    content: "",
    usage: { promptTokens: 0, completionTokens: 0 },
    latencyMs: 0,
    model: modelId,
    provider,
    retries: extra?.retries ?? 0,
    error,
    fallback_action: extra?.fallback_action,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// MOCK MODE helper (Phase-2 §31, P2-16)
// ---------------------------------------------------------------------------

/**
 * Build a `CallLLMResult` carrying a canned mock response. Used when
 * `process.env.MOCK_MODE === "true"` so tests + the mock simulation never
 * hit a real LLM provider.
 *
 * The canned content is looked up by `taskType` in
 * `tests/fixtures/mock-llm-responses.ts`. When no entry exists, falls back
 * to a tiny JSON stub.
 *
 * NOTE: we lazy-import the mock-response table so production bundles don't
 * pull the test fixtures into the server runtime.
 */
async function getMockCallResult(
  taskType: string,
  modelId: string,
  opts: CallLLMOpts
): Promise<CallLLMResult> {
  let content = "";
  try {
    // Local copy of the mock-response catalogue (lives under src/ so the
    // Next.js bundler + tsc both resolve it cleanly; the tests/fixtures copy
    // is kept in sync for the test runner).
    const { getMockResponse } = await import("./mock-responses");
    content = getMockResponse(taskType, taskType);
  } catch {
    // Fall back to a tiny stub if the import fails at runtime.
    content = JSON.stringify({ summary: "mock LLM stub", ok: true });
  }

  const promptTokens = estimateTokens(
    opts.messages.map((m) => m.content).join("\n")
  );
  const completionTokens = estimateTokens(content);

  // Record the call against the budget so the daily/hourly counters
  // reflect usage even in mock mode (useful for budget-cap tests).
  try {
    await BudgetManager.getInstance().recordLlmCall(
      modelId,
      promptTokens + completionTokens,
      true
    );
  } catch {
    // ignore — budget failures should never block the mock call.
  }

  return {
    success: true,
    content,
    usage: { promptTokens, completionTokens },
    latencyMs: 1, // mock = instant
    model: modelId,
    provider: "zai",
    retries: 0,
  };
}

/** Cheap token estimator: ~4 chars per token, clamped to a 1-token floor. */
function estimateTokens(text: string): number {
  if (!text) return 1;
  return Math.max(1, Math.ceil(text.length / 4));
}

// ---------------------------------------------------------------------------
// Convenience: callLLMWithRouter — pick the model + call in one shot
// ---------------------------------------------------------------------------

export interface CallWithRouterOpts extends Omit<CallLLMOpts, "modelId"> {
  taskDescription: string;
  riskLevel?: "read" | "low" | "moderate" | "high";
  domain?: string;
}

/**
 * Convenience: classify a task description, route to the best model, and call
 * the LLM in a single function. Returns the routing decision alongside the
 * call result so the caller can persist both.
 *
 * If the router returns a LEVEL 1 deterministic task (no model needed), the
 * function returns a `success: false, fallback_action: "degrade_to_deterministic"`
 * result with `error: "deterministic routing"`. The orchestrator should
 * dispatch to the corresponding deterministic function in that case.
 */
export async function callLLMWithRouter(
  opts: CallWithRouterOpts
): Promise<{ routing: Awaited<ReturnType<typeof route>>; result: CallLLMResult }> {
  const routing = await route(opts.taskDescription, {
    domain: opts.domain,
    riskLevel: opts.riskLevel,
  });

  if (routing.decision.routing_level === 1) {
    return {
      routing,
      result: makeErrorResult(
        "",
        "deterministic",
        "deterministic routing — dispatch to src/lib/llm/deterministic.ts",
        { fallback_action: "degrade_to_deterministic" }
      ),
    };
  }

  if (routing.models.length === 0) {
    return {
      routing,
      result: makeErrorResult(
        "",
        "deterministic",
        "no eligible models for this task — degrade / queue",
        { fallback_action: "queue_task" }
      ),
    };
  }

  // Phase-3 fix: LEVEL 4 panel routing — actually call every panelist in
  // parallel (spec §4H). Previously this branch used `models[0]` only,
  // discarding the rest of the panel and defeating the purpose of LEVEL 4.
  if (routing.decision.routing_level === 4 && routing.models.length > 1) {
    const panelResult = await callLLMPanel(
      { ...opts, taskType: routing.decision.task_type },
      routing.models
    );
    return { routing, result: panelResult };
  }

  const result = await callLLM({
    ...opts,
    modelId: routing.models[0].model_id,
    taskType: routing.decision.task_type,
  });

  return { routing, result };
}

// ---------------------------------------------------------------------------
// Phase-3 fix: callLLMPanel — multi-model panel execution (spec §4H).
//
// When the router returns LEVEL 4 (high-stakes / high-complexity), it
// produces a panel of N models (default 3). Previously every caller
// discarded all but `models[0]`, so the panel was dead code. This function
// actually calls every panelist in parallel, records each one's budget +
// ModelPerformance, and returns the best result (longest non-empty content
// — a cheap proxy for quality when we don't have a reviewer model scoring
// each response).
//
// Failures from individual panelists are recorded but don't fail the whole
// panel — we return the best successful result. If every panelist fails,
// we return the first failure so the caller's fallback logic engages.
// ---------------------------------------------------------------------------

export interface PanelistOutcome {
  modelId: string;
  success: boolean;
  content: string;
  tokens: number;
  latencyMs: number;
  error?: string;
}

export interface CallLLMPanelResult extends CallLLMResult {
  /** The model that produced the winning content. */
  winningModelId: string;
  /** Every panelist's outcome (for audit + ModelPerformance recording). */
  panelists: PanelistOutcome[];
}

export async function callLLMPanel(
  opts: Omit<CallLLMOpts, "modelId">,
  models: Array<{ model_id: string }>
): Promise<CallLLMPanelResult> {
  if (models.length === 0) {
    return {
      ...makeErrorResult("", "deterministic", "callLLMPanel: empty models list", {
        fallback_action: "queue_task",
      }),
      winningModelId: "",
      panelists: [],
    };
  }

  // Call every panelist in parallel. We use allSettled so one panelist
  // throwing doesn't reject the whole panel.
  const settled = await Promise.allSettled(
    models.map((m) =>
      callLLM({ ...opts, modelId: m.model_id }).then((res) => ({
        modelId: m.model_id,
        result: res,
      }))
    )
  );

  const panelists: PanelistOutcome[] = settled.map((s, i) => {
    const modelId = models[i].model_id;
    if (s.status === "fulfilled") {
      const r = s.value.result;
      return {
        modelId,
        success: r.success,
        content: r.content,
        tokens: r.usage.promptTokens + r.usage.completionTokens,
        latencyMs: r.latencyMs,
        error: r.success ? undefined : r.error,
      };
    }
    // Rejected promise — record as a failure.
    const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
    return {
      modelId,
      success: false,
      content: "",
      tokens: 0,
      latencyMs: 0,
      error: reason,
    };
  });

  // Pick the winner: longest non-empty content among successful panelists.
  // Tiebreak by lowest latency, then by model id for determinism.
  const successful = panelists.filter((p) => p.success && p.content.length > 0);
  if (successful.length === 0) {
    // Every panelist failed — return the first failure.
    const first = panelists[0];
    return {
      ...makeErrorResult(
        first.modelId,
        "deterministic",
        `All ${panelists.length} panelists failed. First error: ${first.error}`,
        { fallback_action: "queue_task" }
      ),
      winningModelId: "",
      panelists,
    };
  }

  successful.sort((a, b) => {
    if (b.content.length !== a.content.length) {
      return b.content.length - a.content.length;
    }
    if (a.latencyMs !== b.latencyMs) {
      return a.latencyMs - b.latencyMs;
    }
    return a.modelId.localeCompare(b.modelId);
  });

  const winner = successful[0];
  // Reconstruct a CallLLMResult from the winner. We already have the content
  // from the winner's callLLM invocation (which also recorded the budget +
  // ModelPerformance). We synthesize the panel result without re-calling.
  // Derive the provider from the winning model id (strip the `<provider>/`
  // prefix). Falls back to "deterministic" if we can't parse it.
  const slashIdx = winner.modelId.indexOf("/");
  const providerFromModel =
    slashIdx > 0
      ? (winner.modelId.slice(0, slashIdx) as Provider | "deterministic")
      : "deterministic";
  return {
    success: true,
    content: winner.content,
    usage: {
      promptTokens: 0, // Already recorded per-panelist; we don't double-count.
      completionTokens: winner.tokens,
    },
    latencyMs: winner.latencyMs,
    model: winner.modelId,
    provider: providerFromModel,
    retries: 0,
    winningModelId: winner.modelId,
    panelists,
  };
}

// Re-export the deterministic helpers + budget recordLlmCall for callers that
// need to record usage without going through callLLM (e.g. for streaming or
// direct SDK callers that want budget tracking only).
export { recordModelPerformance };
export { BudgetManager };
export type { AIProvider };

// ---------------------------------------------------------------------------
// callLLMWithMemory — builds a bounded memory context + calls the LLM.
//
// Phase 3.2: This is the recommended entry point for specialist agents.
// It:
//   1. Calls buildMemoryContext() to retrieve ONLY relevant records (bounded).
//   2. Calls serializeForLLM() to convert the context to a compact string.
//   3. Prepends the memory context to the system prompt.
//   4. Calls callLLM() with the augmented messages.
//
// The memory context is bounded by MAX_MEMORY_TOKENS (default 4000). Even
// if the database has 100,000+ records, the LLM only sees ~4000 tokens
// of context.
// ---------------------------------------------------------------------------

export interface CallLLMWithMemoryOpts extends CallLLMOpts {
  /** The task type (e.g. "research", "coding"). Used for model stats retrieval. */
  memoryTaskType?: string;
  /** The opportunity ID (for episodic memory). */
  memoryOpportunityId?: string;
  /** The strategy family (for episodic memory fallback). */
  memoryStrategy?: string;
}

export async function callLLMWithMemory(
  opts: CallLLMWithMemoryOpts
): Promise<{ result: CallLLMResult; memoryReport: unknown }> {
  // Build the bounded memory context.
  let memoryContextStr = "";
  let memoryReport: unknown = null;

  try {
    const { buildMemoryContext, serializeForLLM } = await import(
      "@/lib/memory/memory-manager"
    );

    const ctx = await buildMemoryContext({
      taskId: opts.taskId,
      taskType: opts.memoryTaskType ?? opts.taskType,
      opportunityId: opts.memoryOpportunityId,
      strategy: opts.memoryStrategy,
    });

    memoryContextStr = serializeForLLM(ctx);
    memoryReport = ctx.report;
  } catch (err) {
    console.error("[llm] buildMemoryContext failed:", err);
    // Continue without memory context — the call should still work.
  }

  // Prepend the memory context to the first system message.
  let messages = opts.messages;
  if (memoryContextStr) {
    const systemMessage = messages.find((m) => m.role === "system");
    if (systemMessage) {
      messages = messages.map((m) =>
        m.role === "system"
          ? { ...m, content: `${m.content}\n\n--- MEMORY CONTEXT (bounded) ---\n${memoryContextStr}` }
          : m
      );
    } else {
      messages = [{ role: "system", content: memoryContextStr }, ...messages];
    }
  }

  const result = await callLLM({
    ...opts,
    messages,
  });

  return { result, memoryReport };
}
