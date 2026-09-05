// Provider abstraction interface (Phase-2 spec §2, P2-1, P2-2, P2-3, P2-7).
//
// Every supported LLM provider (OpenRouter, Gemini, Groq, Cerebras, Hugging
// Face, Mistral, Cloudflare Workers AI, Z.AI, NVIDIA) implements the same
// `AIProvider` interface. The router / dispatch layer talks ONLY through this
// interface — there is no `switch (provider)` anywhere in the call path.
//
// Implementations MUST:
//   - Never throw out of public methods. Always return a result object.
//   - Use `fetch()` with an `AbortController` timeout on every HTTP call.
//   - Record `BudgetManager.recordWebRequest()` BEFORE every HTTP call and
//     `BudgetManager.recordLlmCall(model, tokens, success)` AFTER.
//   - Map HTTP 401 → `invalid_credentials`, 429 → `rate_limited` (or
//     `quota_exhausted` if the body says so), 5xx → `unhealthy`, network
//     errors → `unhealthy`.
//   - Parse `X-RateLimit-*` / `Retry-After` headers and surface them via
//     `usage()` + `limits()` so the QuotaTracker can pre-emptively cool a
//     provider that has nothing left in its budget.

import type { ModelCapabilities } from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// Status (provider-level, distinct from per-model ModelStatus)
// ---------------------------------------------------------------------------

export type ProviderStatus =
  | "healthy"
  | "degraded"
  | "unhealthy"
  | "blacklisted"
  | "not_configured"
  | "rate_limited"
  | "quota_exhausted"
  | "invalid_credentials";

// ---------------------------------------------------------------------------
// Chat message + generation request shape
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Optional tool-call id when role === "tool". */
  tool_call_id?: string;
  /** Optional name (function name) for tool messages. */
  name?: string;
}

export interface GenerateOpts {
  /** Model id scoped to this provider (e.g. `"glm-4.6"` — WITHOUT the `zai/` prefix). */
  model: string;
  /** Conversation history. At least one message is required. */
  messages: ChatMessage[];
  /** Max output tokens. Defaults to 1024 per provider's discretion. */
  maxTokens?: number;
  /** Sampling temperature 0..2. Defaults to 0.7. */
  temperature?: number;
  /** Force JSON-parseable output if the provider supports it. */
  responseFormat?: "text" | "json";
  /** Optional tools to expose (used by `toolCall`). */
  tools?: ToolDef[];
  /** Optional abort signal (callers can pass a custom timeout). */
  signal?: AbortSignal;
  /** Optional: caller-supplied request id for log correlation. */
  requestId?: string;
}

export interface GenerateResult {
  /** Did the provider return a usable completion? */
  success: boolean;
  /** The completion text (or `""` on failure). */
  content: string;
  /** Token usage reported by the provider. */
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  /** Wall-clock latency of the call in ms. */
  latencyMs: number;
  /** Structured error when `success === false`. */
  error?: string;
  /** Mapped status for the failure (when applicable). */
  status?: ProviderStatus;
  /** Raw provider response (for debugging). Stripped of auth headers. */
  raw?: unknown;
  /** Parsed rate-limit headers (snake_cased for consistency). */
  rateLimitHeaders?: RateLimitHeaders;
  /** The model id that actually produced this (may differ from opts.model
   *  when the provider transparently substituted a sibling). */
  model?: string;
}

export interface RateLimitHeaders {
  /** Total requests allowed in the current window. */
  limit?: number;
  /** Requests remaining in the current window. */
  remaining?: number;
  /** Epoch-seconds (or relative seconds — provider-dependent) when the
   *  limit resets. */
  reset?: number;
  /** Tokens remaining in the current window (when separately tracked). */
  tokensRemaining?: number;
  /** Seconds the client should wait before retrying (from `Retry-After`). */
  retryAfter?: number;
}

// ---------------------------------------------------------------------------
// Discovery + capability probing
// ---------------------------------------------------------------------------

export interface DiscoveredModel {
  /** Provider-scoped model id (e.g. `"glm-4.6"`, NOT `"zai/glm-4.6"`). */
  modelId: string;
  /** Optional display name. */
  displayName?: string;
  /** Optional context-window size in tokens. `null` when unknown. */
  contextWindow?: number | null;
  /** Provider reports JSON-mode support. `null` when unknown. */
  supportsJson?: boolean | null;
  /** Provider reports tool-calling support. `null` when unknown. */
  supportsTools?: boolean | null;
  /** Provider reports vision/multimodal support. `null` when unknown. */
  supportsVision?: boolean | null;
  /** Provider labels the model as free-tier. `null` when unknown. */
  free?: boolean | null;
  /** Raw capability hints from the provider's `/models` payload. */
  rawCapabilities?: Record<string, unknown>;
}

export interface ProviderUsage {
  /** Total requests recorded by this instance since process start. */
  requests: number;
  /** Total tokens recorded by this instance since process start. */
  tokens: number;
  /** Most recent rate-limit remaining value (when known). */
  rateLimitRemaining?: number;
  /** Epoch-ms when the rate-limit window resets. */
  rateLimitReset?: number;
  /** Epoch-ms when a manual cooldown expires. 0 = no cooldown. */
  cooldownUntil?: number;
  /** Last error string (if any). */
  lastError?: string;
}

export interface ProviderLimits {
  /** Requests-per-minute cap (when known). */
  requestsPerMinute?: number;
  /** Tokens-per-minute cap (when known). */
  tokensPerMinute?: number;
  /** Daily request cap (when known). */
  dailyRequests?: number;
  /** Daily token cap (when known). */
  dailyTokens?: number;
  /** Whether the provider supports model discovery via `/models`. */
  supportsDiscovery: boolean;
  /** Whether the provider supports JSON-mode responses. */
  supportsJsonMode: boolean;
  /** Whether the provider supports tool-calling. */
  supportsToolCalls: boolean;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// The interface every adapter implements
// ---------------------------------------------------------------------------

export interface AIProvider {
  /** Canonical provider id (e.g. `"openrouter"`, `"gemini"`, `"zai"`). */
  readonly name: string;
  /** Human-friendly label for dashboards. */
  readonly displayName: string;

  /** Returns true if the env var(s) this provider needs are set. */
  isConfigured(): boolean;

  /** Validate credentials with a minimal API call (1-token ping or `/models` GET). */
  healthCheck(): Promise<{
    status: ProviderStatus;
    detail: string;
    latencyMs?: number;
  }>;

  /** List available models (where supported). Returns `[]` if unsupported. */
  listModels(): Promise<DiscoveredModel[]>;

  /** Generate a chat completion. */
  generate(opts: GenerateOpts): Promise<GenerateResult>;

  /** Request a structured JSON response. */
  structuredOutput(opts: GenerateOpts, schema?: unknown): Promise<GenerateResult>;

  /** Tool-calling request. No-op if unsupported by the provider. */
  toolCall(opts: GenerateOpts, tools: ToolDef[]): Promise<GenerateResult>;

  /** Return the last-known usage + remaining quota for this provider. */
  usage(): ProviderUsage;

  /** Return the provider's rate limits if known. */
  limits(): ProviderLimits;

  /** Capability probe — run a tiny test to detect model capabilities. */
  capabilityProbe(modelId: string): Promise<Partial<ModelCapabilities>>;
}

// ---------------------------------------------------------------------------
// Shared HTTP helper
// ---------------------------------------------------------------------------

/**
 * Standard OpenAI-compatible response shape (subset). Adapters cast to this
 * shape defensively because each provider returns slightly different JSON.
 */
export interface OpenAiChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string; tool_calls?: unknown[] };
    text?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Fetch JSON with an AbortController timeout. Never throws — returns a
 * discriminated union so adapters can dispatch on `ok`.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 30_000
): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  json: unknown;
  text: string;
  error?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // If the caller passed their own signal, wire it through so either aborts.
  const externalSignal = init.signal;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
  }
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON — leave json null, return text
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      json,
      text,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      statusText: err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error",
      headers: new Headers(),
      json: null,
      text: "",
      error: msg,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse the standard `X-RateLimit-*` and `Retry-After` headers into a
 * normalized {@link RateLimitHeaders} object. Handles epoch-seconds (OpenRouter
 * / Mistral / Groq) and relative-seconds (Hugging Face / Cloudflare / NVIDIA).
 */
export function parseRateLimitHeaders(headers: Headers): RateLimitHeaders {
  const out: RateLimitHeaders = {};
  const limit = headers.get("x-ratelimit-limit") ?? headers.get("x-ratelimit-limit-requests");
  const remaining =
    headers.get("x-ratelimit-remaining") ??
    headers.get("x-ratelimit-remaining-requests");
  const reset =
    headers.get("x-ratelimit-reset") ??
    headers.get("x-ratelimit-reset-requests") ??
    headers.get("x-ratelimit-reset-tokens");
  const tokensRemaining =
    headers.get("x-ratelimit-remaining-tokens") ?? undefined;
  const retryAfter = headers.get("retry-after") ?? undefined;

  if (limit !== null) out.limit = Number(limit) || undefined;
  if (remaining !== null) out.remaining = Number(remaining) || undefined;
  if (reset !== null) {
    const n = Number(reset);
    if (Number.isFinite(n)) {
      // Heuristic: if the number is < 1e9, treat it as relative seconds from
      // now. Otherwise treat it as an epoch timestamp.
      out.reset = n < 1e9 ? Math.floor(Date.now() / 1000) + n : n;
    }
  }
  if (tokensRemaining !== null) out.tokensRemaining = Number(tokensRemaining) || undefined;
  if (retryAfter !== null) {
    const n = Number(retryAfter);
    if (Number.isFinite(n)) out.retryAfter = n;
    else {
      // HTTP-date format — convert to seconds.
      const t = Date.parse(retryAfter ?? "");
      if (Number.isFinite(t)) out.retryAfter = Math.max(0, Math.floor((t - Date.now()) / 1000));
    }
  }
  return out;
}

/**
 * Map an HTTP status code to a {@link ProviderStatus}. Adapters use this to
 * translate provider responses into the unified status enum.
 */
export function statusFromHttp(
  status: number,
  bodyText: string
): ProviderStatus {
  if (status === 401 || status === 403) return "invalid_credentials";
  if (status === 429) {
    const lower = (bodyText ?? "").toLowerCase();
    if (
      lower.includes("quota") ||
      lower.includes("exhausted") ||
      lower.includes("exceeded") ||
      lower.includes("billing") ||
      lower.includes("limit_reached")
    ) {
      return "quota_exhausted";
    }
    return "rate_limited";
  }
  if (status >= 500) return "unhealthy";
  return "degraded";
}

/**
 * Rough token estimate — `chars / 4`. The standard OpenAI heuristic. Used
 * when a provider doesn't return usage info in its response.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
