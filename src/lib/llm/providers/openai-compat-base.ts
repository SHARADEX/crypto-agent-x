// Shared OpenAI-compatible adapter base (Phase-2 P2-1).
//
// Most providers (OpenRouter, Gemini-compat, Groq, Cerebras, HuggingFace
// router, Mistral, NVIDIA NIM) speak the OpenAI Chat Completions wire
// format. Their differences are limited to:
//
//   - base URL
//   - auth header env var name
//   - whether `/models` discovery is supported
//   - whether JSON-mode / tool-calling is supported
//   - rate-limit header conventions (most use `X-RateLimit-*`, a few use
//     vendor-specific names)
//
// This module exports a `makeOpenAiCompatProvider` factory that returns a
// fully-implemented {@link AIProvider}. Each provider file then only needs
// to supply the constants + a couple of overrides.

import { BudgetManager } from "@/lib/budget/manager";
import { logEvent } from "@/lib/agent/events";
import type { ModelCapabilities } from "@/lib/agent/types";
import type {
  AIProvider,
  DiscoveredModel,
  GenerateOpts,
  GenerateResult,
  OpenAiChatResponse,
  ProviderLimits,
  ProviderStatus,
  ProviderUsage,
  RateLimitHeaders,
  ToolDef,
} from "@/lib/llm/providers/types";
import {
  estimateTokens,
  fetchWithTimeout,
  parseRateLimitHeaders,
  statusFromHttp,
} from "@/lib/llm/providers/types";

// ---------------------------------------------------------------------------
// Config shape consumed by the factory
// ---------------------------------------------------------------------------

export interface OpenAiCompatConfig {
  /** Canonical provider id — e.g. `"openrouter"`. */
  name: string;
  /** Human-friendly label — e.g. `"OpenRouter"`. */
  displayName: string;
  /** Base URL ending in `/v1`-style root (no trailing slash). */
  baseUrl: string;
  /** Env var name that holds the API key. */
  envKey: string;
  /**
   * Optional override for the chat-completions path. Defaults to
   * `/chat/completions` appended to `baseUrl`. Gemini's OpenAI-compat
   * endpoint needs `/openai/chat/completions`.
   */
  chatCompletionsPath?: string;
  /**
   * Optional override for the `/models` discovery path. Defaults to
   * `/models` appended to `baseUrl`. Set to `null` to disable discovery.
   */
  modelsPath?: string | null;
  /** Whether the provider supports `response_format: json_object`. */
  supportsJsonMode: boolean;
  /** Whether the provider supports OpenAI-style tool-calling. */
  supportsToolCalls: boolean;
  /** Optional default request timeout (ms). */
  defaultTimeoutMs?: number;
  /** Optional default max tokens. */
  defaultMaxTokens?: number;
  /** Optional default temperature. */
  defaultTemperature?: number;
  /** Optional extra headers (e.g. `HTTP-Referer` for OpenRouter). */
  extraHeaders?: () => Record<string, string>;
  /**
   * Optional model slug used for an auth-validating 1-token chat ping.
   *
   * P0-2 fix: some providers (OpenRouter, NVIDIA) expose a PUBLIC `/models`
   * discovery endpoint that returns HTTP 200 even with an invalid API key.
   * For those providers, the default `/models` GET healthCheck is a false
   * positive — it reports `healthy` for any value of the env var, and the
   * first real `generate()` call then fails with 401/403.
   *
   * When `healthProbeModel` is set, the healthCheck does a
   * `POST /chat/completions` with `{model, messages:[{role:"user",
   * content:"ping"}], max_tokens:1}` instead. This endpoint requires auth
   * on every provider, so an invalid key returns 401/403 →
   * `invalid_credentials` (correctly reported as unhealthy).
   *
   * The probe burns at most 1 token per health check — acceptable for a
   * startup / dashboard-refresh probe that runs infrequently.
   */
  healthProbeModel?: string;
  /**
   * Optional model-id normalizer. Some providers (Gemini) require the raw
   * model name (no provider prefix); others (OpenRouter) want the full id.
   * Default: strip the `provider/` prefix.
   */
  normalizeModelId?: (model: string) => string;
  /**
   * Optional: filter the discovered models list (e.g. drop `:free` suffix
   * variants the operator didn't ask for).
   */
  filterDiscovered?: (m: DiscoveredModel) => boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makeOpenAiCompatProvider(
  config: OpenAiCompatConfig
): AIProvider {
  const defaultTimeout = config.defaultTimeoutMs ?? 30_000;
  const defaultMaxTokens = config.defaultMaxTokens ?? 1024;
  const defaultTemperature = config.defaultTemperature ?? 0.7;
  const chatPath = config.chatCompletionsPath ?? "/chat/completions";
  const modelsPath = config.modelsPath ?? "/models";
  const normalize =
    config.normalizeModelId ??
    ((m: string) => m.replace(/^[a-z]+\//, ""));

  // In-memory per-instance usage + quota snapshot.
  const usage: ProviderUsage & {
    rateLimitRemaining?: number;
    rateLimitReset?: number;
    cooldownUntil: number;
    lastError?: string;
    requests: number;
    tokens: number;
  } = {
    requests: 0,
    tokens: 0,
    cooldownUntil: 0,
  };

  function configured(): boolean {
    const v = process.env[config.envKey];
    return typeof v === "string" && v.trim().length > 0;
  }

  function apiKey(): string | undefined {
    return process.env[config.envKey];
  }

  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey() ?? ""}`,
    };
    if (config.extraHeaders) Object.assign(h, config.extraHeaders());
    return h;
  }

  async function recordQuota(rateLimit?: RateLimitHeaders) {
    if (!rateLimit) return;
    if (rateLimit.remaining !== undefined) {
      usage.rateLimitRemaining = rateLimit.remaining;
    }
    if (rateLimit.reset !== undefined) {
      usage.rateLimitReset = rateLimit.reset * 1000;
    }
    if (rateLimit.retryAfter && rateLimit.retryAfter > 0) {
      usage.cooldownUntil = Date.now() + rateLimit.retryAfter * 1000;
    }
  }

  async function buildGenerate(
    opts: GenerateOpts,
    overrides?: {
      responseFormat?: "text" | "json";
      tools?: ToolDef[];
      maxTokens?: number;
    }
  ): Promise<GenerateResult> {
    const startedAt = Date.now();
    if (!configured()) {
      return {
        success: false,
        content: "",
        usage: { promptTokens: 0, completionTokens: 0 },
        latencyMs: 0,
        error: `provider not configured: env var ${config.envKey} is not set`,
        status: "not_configured",
      };
    }
    if (usage.cooldownUntil > Date.now()) {
      return {
        success: false,
        content: "",
        usage: { promptTokens: 0, completionTokens: 0 },
        latencyMs: 0,
        error: `provider in cooldown until ${new Date(usage.cooldownUntil).toISOString()}`,
        status: "rate_limited",
      };
    }

    const body: Record<string, unknown> = {
      model: normalize(opts.model),
      messages: opts.messages,
      max_tokens: overrides?.maxTokens ?? opts.maxTokens ?? defaultMaxTokens,
      temperature: opts.temperature ?? defaultTemperature,
    };
    if (overrides?.responseFormat === "json" && config.supportsJsonMode) {
      body.response_format = { type: "json_object" };
    } else if (opts.responseFormat === "json" && config.supportsJsonMode) {
      body.response_format = { type: "json_object" };
    }
    if (overrides?.tools && overrides.tools.length > 0 && config.supportsToolCalls) {
      body.tools = overrides.tools;
    } else if (opts.tools && opts.tools.length > 0 && config.supportsToolCalls) {
      body.tools = opts.tools;
    }

    // Budget: count this as a web request BEFORE the call goes out.
    try {
      await BudgetManager.getInstance().recordWebRequest();
    } catch (err) {
      console.error(`[llm:${config.name}] recordWebRequest failed:`, err);
    }

    const url = `${config.baseUrl}${chatPath}`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    }, defaultTimeout);

    const rateLimit = parseRateLimitHeaders(res.headers);
    await recordQuota(rateLimit);

    if (!res.ok) {
      const status: ProviderStatus = statusFromHttp(res.status, res.text);
      const error = `HTTP ${res.status} ${res.statusText} from ${config.name}: ${res.text.slice(0, 280)}`;
      usage.lastError = error;
      // Record failure against budget (0 tokens so we don't double-count).
      try {
        await BudgetManager.getInstance().recordLlmCall(
          `${config.name}/${opts.model}`,
          0,
          false
        );
      } catch (err) {
        console.error(`[llm:${config.name}] recordLlmCall(fail) errored:`, err);
      }
      await logEvent(
        "model_router",
        status === "rate_limited" || status === "quota_exhausted" ? "warn" : "error",
        "provider_call_failed",
        {
          provider: config.name,
          model: opts.model,
          status,
          httpStatus: res.status,
          error: error.slice(0, 280),
        },
        {}
      ).catch(() => null);
      return {
        success: false,
        content: "",
        usage: { promptTokens: 0, completionTokens: 0 },
        latencyMs: Date.now() - startedAt,
        error,
        status,
        rateLimitHeaders: rateLimit,
      };
    }

    const data = (res.json as OpenAiChatResponse | null) ?? {};
    const content: string =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      "";
    const promptTokens: number =
      data?.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(opts.messages));
    const completionTokens: number =
      data?.usage?.completion_tokens ?? estimateTokens(content);

    usage.requests += 1;
    usage.tokens += promptTokens + completionTokens;

    // NOTE: Budget recording for SUCCESSFUL calls is done ONCE by the
    // central `callLLM` in src/lib/llm/provider.ts. We deliberately do
    // NOT call `recordLlmCall` here on the success path — doing so would
    // double-count tokens (provider adapter + callLLM both incrementing
    // the same BudgetUsage row). The failure path below still records
    // a 0-token request so the request counter reflects every attempt.

    if (!content) {
      const error = `${config.name} returned empty content`;
      usage.lastError = error;
      return {
        success: false,
        content: "",
        usage: { promptTokens, completionTokens },
        latencyMs: Date.now() - startedAt,
        error,
        status: "degraded",
        rateLimitHeaders: rateLimit,
      };
    }

    return {
      success: true,
      content,
      usage: { promptTokens, completionTokens },
      latencyMs: Date.now() - startedAt,
      model: data.model ?? opts.model,
      rateLimitHeaders: rateLimit,
      raw: data,
    };
  }

  const provider: AIProvider = {
    name: config.name,
    displayName: config.displayName,

    isConfigured: configured,

    async healthCheck() {
      if (!configured()) {
        return {
          status: "not_configured" as ProviderStatus,
          detail: `env var ${config.envKey} is not set`,
        };
      }
      const startedAt = Date.now();
      // Phase-3 fix: previously this sent a chat-completion request with
      // `model: "ping"` — a fake model ID that every provider rejects with
      // HTTP 400, producing a false "degraded" verdict even when the API
      // key was perfectly valid. We now hit the `/models` discovery
      // endpoint (GET), which:
      //   - validates the API key (401/403 if bad),
      //   - doesn't require a valid model slug,
      //   - doesn't burn tokens,
      //   - returns 200 on success.
      // If a provider doesn't expose `/models` (modelsPath === null), we
      // fall back to a HEAD request on the base URL.
      //
      // P0-2 fix: the `/models` endpoint is PUBLIC on some providers
      // (OpenRouter, NVIDIA) — it returns 200 even with an invalid key,
      // causing a false `healthy` verdict. When `config.healthProbeModel`
      // is set, we instead do a `POST /chat/completions` 1-token ping on
      // that real model slug — the chat endpoint requires auth on every
      // provider, so invalid keys are correctly mapped to
      // `invalid_credentials`.
      try {
        await BudgetManager.getInstance().recordWebRequest();
        let probeUrl: string;
        let probeMethod: string;
        let probeBody: string | undefined;
        if (config.healthProbeModel) {
          // Auth-validating chat ping (OpenRouter, NVIDIA).
          probeUrl = `${config.baseUrl}${chatPath}`;
          probeMethod = "POST";
          probeBody = JSON.stringify({
            model: normalize(config.healthProbeModel),
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            temperature: 0,
          });
        } else if (modelsPath !== null) {
          probeUrl = `${config.baseUrl}${modelsPath}`;
          probeMethod = "GET";
        } else {
          probeUrl = config.baseUrl;
          probeMethod = "HEAD";
        }
        const res = await fetchWithTimeout(
          probeUrl,
          {
            method: probeMethod,
            headers: authHeaders(),
            ...(probeBody !== undefined ? { body: probeBody } : {}),
          },
          defaultTimeout
        );
        const latencyMs = Date.now() - startedAt;
        if (res.ok) {
          return {
            status: "healthy" as ProviderStatus,
            detail: config.healthProbeModel
              ? `1-token chat ping on ${config.healthProbeModel} succeeded`
              : modelsPath !== null
                ? "/models list succeeded"
                : "base URL HEAD succeeded",
            latencyMs,
          };
        }
        // 401/403 → invalid credentials (definitely unhealthy).
        // 429 → rate-limited (degraded, not unhealthy).
        // 5xx → provider down (unhealthy).
        // 404/400/402 on the probe is unlikely but we treat as degraded.
        const status = statusFromHttp(res.status, res.text);
        return {
          status,
          detail: `HTTP ${res.status} on ${probeMethod} ${probeUrl}: ${res.text.slice(0, 180)}`,
          latencyMs,
        };
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        return {
          status: "unhealthy" as ProviderStatus,
          detail: err instanceof Error ? err.message : String(err),
          latencyMs,
        };
      }
    },

    async listModels() {
      if (!configured() || modelsPath === null) return [];
      try {
        await BudgetManager.getInstance().recordWebRequest();
        const res = await fetchWithTimeout(
          `${config.baseUrl}${modelsPath}`,
          { method: "GET", headers: authHeaders() },
          defaultTimeout
        );
        if (!res.ok) {
          await logEvent(
            "model_router",
            "warn",
            "provider_discovery_failed",
            {
              provider: config.name,
              httpStatus: res.status,
              error: res.text.slice(0, 280),
            },
            {}
          ).catch(() => null);
          return [];
        }
        const data = (res.json ?? {}) as {
          data?: Array<Record<string, unknown>>;
          models?: Array<Record<string, unknown>>;
        };
        const list = data.data ?? data.models ?? [];
        let discovered: DiscoveredModel[] = list.map((m) => {
          const id = String(m.id ?? m.name ?? "").trim();
          return {
            modelId: id,
            displayName: typeof m.name === "string" ? m.name : id,
            contextWindow:
              typeof m.context_length === "number"
                ? m.context_length
                : typeof m.context_window === "number"
                  ? m.context_window
                  : null,
            supportsJson:
              typeof m.supports_response_format === "boolean"
                ? m.supports_response_format
                : null,
            supportsTools:
              typeof m.supported_tools === "object" && m.supported_tools
                ? Array.isArray(m.supported_tools) &&
                  (m.supported_tools as unknown[]).length > 0
                : null,
            supportsVision:
              typeof m.supports_vision === "boolean" ? m.supports_vision : null,
            free:
              typeof m.pricing === "object" && m.pricing
                ? false
                : null,
            rawCapabilities: m as Record<string, unknown>,
          };
        });
        discovered = discovered.filter((m) => Boolean(m.modelId));
        if (config.filterDiscovered) {
          discovered = discovered.filter(config.filterDiscovered);
        }
        await logEvent(
          "model_router",
          "info",
          "provider_discovered_models",
          { provider: config.name, count: discovered.length },
          {}
        ).catch(() => null);
        return discovered;
      } catch (err) {
        await logEvent(
          "model_router",
          "warn",
          "provider_discovery_error",
          {
            provider: config.name,
            error: err instanceof Error ? err.message : String(err),
          },
          {}
        ).catch(() => null);
        return [];
      }
    },

    generate(opts: GenerateOpts) {
      return buildGenerate(opts);
    },

    structuredOutput(opts: GenerateOpts, _schema?: unknown) {
      // Most OpenAI-compat providers accept `response_format: json_object`.
      // We embed the JSON-schema hint into the system prompt as a fallback.
      const enriched: GenerateOpts = {
        ...opts,
        responseFormat: "json",
      };
      if (_schema && config.supportsJsonMode) {
        // Some providers (Mistral, OpenRouter) accept `response_format: json_schema`.
        // We pass it as a string hint inside the system message — the provider
        // doesn't have to honor it.
        const hint = JSON.stringify(_schema);
        enriched.messages = [
          ...opts.messages,
          {
            role: "system",
            content: `Respond with a JSON object matching this schema: ${hint}`,
          },
        ];
      }
      return buildGenerate(enriched, { responseFormat: "json" });
    },

    toolCall(opts: GenerateOpts, tools: ToolDef[]) {
      if (!config.supportsToolCalls) {
        // No-op — return a structured error so the caller can fall back.
        return Promise.resolve({
          success: false,
          content: "",
          usage: { promptTokens: 0, completionTokens: 0 },
          latencyMs: 0,
          error: `${config.name} does not support tool-calling`,
          status: "not_configured" as ProviderStatus,
        });
      }
      return buildGenerate(opts, { tools });
    },

    usage(): ProviderUsage {
      return {
        requests: usage.requests,
        tokens: usage.tokens,
        rateLimitRemaining: usage.rateLimitRemaining,
        rateLimitReset: usage.rateLimitReset,
        cooldownUntil: usage.cooldownUntil,
        lastError: usage.lastError,
      };
    },

    limits(): ProviderLimits {
      return {
        supportsDiscovery: modelsPath !== null,
        supportsJsonMode: config.supportsJsonMode,
        supportsToolCalls: config.supportsToolCalls,
      };
    },

    async capabilityProbe(modelId: string): Promise<Partial<ModelCapabilities>> {
      // Run a tiny test: ask for a 2-token JSON response. If it parses, the
      // model supports JSON-mode + structured output.
      const result = await buildGenerate({
        model: modelId,
        messages: [
          { role: "system", content: "respond with a JSON object {\"ok\":true}" },
          { role: "user", content: "ping" },
        ],
        maxTokens: 16,
        temperature: 0,
      });
      const caps: Partial<ModelCapabilities> = {};
      if (result.success) {
        try {
          const obj = JSON.parse(result.content);
          if (obj && typeof obj === "object") {
            caps.structured_output = 7;
            caps.reasoning = 6;
          }
        } catch {
          caps.structured_output = 3;
        }
      }
      return caps;
    },
  };

  return provider;
}
