// Cloudflare Workers AI provider adapter (Phase-2 P2-1, P2-2, P2-3, P2-7).
//
// Cloudflare's Workers AI endpoint lives under a per-account path:
//
//   https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions
//
// It accepts the OpenAI chat-completions body shape and returns OpenAI-shaped
// JSON. Auth: `Authorization: Bearer $CLOUDFLARE_API_TOKEN`.
//
// Model discovery: best-effort via the /ai/models/search endpoint. The
// endpoint returns models available to THIS account — we filter to those
// suitable for chat. Cloudflare's catalogue changes frequently; the discovery
// list should NOT be trusted as authoritative for routing — treat all
// discovered capability fields as `null` (unknown) unless the body
// explicitly populates them.

import { BudgetManager } from "@/lib/budget/manager";
import { logEvent } from "@/lib/agent/events";
import type { ModelCapabilities } from "@/lib/agent/types";
import type {
  AIProvider,
  DiscoveredModel,
  GenerateOpts,
  GenerateResult,
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

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.7;

interface CloudflareDiscoveredModel {
  id?: string;
  name?: string;
  description?: string;
  task?: { type?: string } | string;
}

export class CloudflareProvider implements AIProvider {
  readonly name = "cloudflare";
  readonly displayName = "Cloudflare Workers AI";

  private _usage: ProviderUsage & {
    requests: number;
    tokens: number;
    rateLimitRemaining?: number;
    rateLimitReset?: number;
    cooldownUntil: number;
    lastError?: string;
  } = {
    requests: 0,
    tokens: 0,
    cooldownUntil: 0,
  };

  private accountId(): string | undefined {
    return process.env.CLOUDFLARE_ACCOUNT_ID;
  }

  private apiToken(): string | undefined {
    return process.env.CLOUDFLARE_API_TOKEN;
  }

  isConfigured(): boolean {
    const id = this.accountId();
    const tok = this.apiToken();
    return !!id && id.trim().length > 0 && !!tok && tok.trim().length > 0;
  }

  private baseUrl(): string {
    const id = this.accountId() ?? "";
    return `https://api.cloudflare.com/client/v4/accounts/${id}/ai/v1`;
  }

  private authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiToken() ?? ""}`,
    };
  }

  private async recordQuota(rateLimit?: RateLimitHeaders) {
    if (!rateLimit) return;
    if (rateLimit.remaining !== undefined) {
      this._usage.rateLimitRemaining = rateLimit.remaining;
    }
    if (rateLimit.reset !== undefined) {
      this._usage.rateLimitReset = rateLimit.reset * 1000;
    }
    if (rateLimit.retryAfter && rateLimit.retryAfter > 0) {
      this._usage.cooldownUntil = Date.now() + rateLimit.retryAfter * 1000;
    }
  }

  async healthCheck(): Promise<{
    status: ProviderStatus;
    detail: string;
    latencyMs?: number;
  }> {
    if (!this.isConfigured()) {
      return {
        status: "not_configured",
        detail: "CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN is not set",
      };
    }
    const startedAt = Date.now();
    // A 1-token ping on a known-cheap model. Note: @cf/meta/llama-3.1-8b-instruct
    // was deprecated on 2026-05-30. Using @cf/meta/llama-3-8b-instruct instead.
    try {
      const result = await this.generate({
        model: "@cf/meta/llama-3-8b-instruct",
        messages: [
          { role: "system", content: "respond 'ok'" },
          { role: "user", content: "ping" },
        ],
        maxTokens: 1,
        temperature: 0,
      });
      const latencyMs = Date.now() - startedAt;
      if (result.success) {
        return { status: "healthy", detail: "1-token ping succeeded", latencyMs };
      }
      return {
        status: result.status ?? "unhealthy",
        detail: result.error ?? "unknown error",
        latencyMs,
      };
    } catch (err) {
      return {
        status: "unhealthy",
        detail: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    if (!this.isConfigured()) return [];
    try {
      await BudgetManager.getInstance().recordWebRequest();
      const url = `${this.baseUrl().replace(/\/ai\/v1$/, "")}/ai/models/search`;
      const res = await fetchWithTimeout(url, {
        method: "GET",
        headers: this.authHeaders(),
      }, DEFAULT_TIMEOUT_MS);
      if (!res.ok) {
        await logEvent(
          "model_router",
          "warn",
          "provider_discovery_failed",
          {
            provider: this.name,
            httpStatus: res.status,
            error: res.text.slice(0, 280),
          },
          {}
        ).catch(() => null);
        return [];
      }
      const data = (res.json ?? {}) as {
        result?: { models?: CloudflareDiscoveredModel[] };
        models?: CloudflareDiscoveredModel[];
      };
      const list = data.result?.models ?? data.models ?? [];
      const discovered: DiscoveredModel[] = list
        .filter((m) => {
          // Filter to chat-capable models — Cloudflare tags task types.
          const task = typeof m.task === "string" ? m.task : m.task?.type;
          return (
            !task ||
            task === "chat" ||
            task === "text-generation" ||
            task === "conversational"
          );
        })
        .map((m) => ({
          modelId: String(m.id ?? m.name ?? "").trim(),
          displayName: typeof m.name === "string" ? m.name : undefined,
          contextWindow: null,
          supportsJson: null,
          supportsTools: null,
          supportsVision: null,
          free: true, // Workers AI free tier covers all listed models up to 10k neurons/day.
          rawCapabilities: m as unknown as Record<string, unknown>,
        }))
        .filter((m) => Boolean(m.modelId));
      await logEvent(
        "model_router",
        "info",
        "provider_discovered_models",
        { provider: this.name, count: discovered.length },
        {}
      ).catch(() => null);
      return discovered;
    } catch (err) {
      await logEvent(
        "model_router",
        "warn",
        "provider_discovery_error",
        {
          provider: this.name,
          error: err instanceof Error ? err.message : String(err),
        },
        {}
      ).catch(() => null);
      return [];
    }
  }

  async generate(opts: GenerateOpts): Promise<GenerateResult> {
    const startedAt = Date.now();
    if (!this.isConfigured()) {
      return {
        success: false,
        content: "",
        usage: { promptTokens: 0, completionTokens: 0 },
        latencyMs: 0,
        error:
          "provider not configured: CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN is not set",
        status: "not_configured",
      };
    }
    if (this._usage.cooldownUntil > Date.now()) {
      return {
        success: false,
        content: "",
        usage: { promptTokens: 0, completionTokens: 0 },
        latencyMs: 0,
        error: `provider in cooldown until ${new Date(this._usage.cooldownUntil).toISOString()}`,
        status: "rate_limited",
      };
    }

    const body: Record<string, unknown> = {
      model: opts.model.replace(/^cloudflare\//, ""),
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    };
    if (opts.responseFormat === "json") {
      body.response_format = { type: "json_object" };
    }

    try {
      await BudgetManager.getInstance().recordWebRequest();
    } catch (err) {
      console.error(`[llm:${this.name}] recordWebRequest failed:`, err);
    }

    const url = `${this.baseUrl()}/chat/completions`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    }, DEFAULT_TIMEOUT_MS);

    const rateLimit = parseRateLimitHeaders(res.headers);
    await this.recordQuota(rateLimit);

    if (!res.ok) {
      const status: ProviderStatus = statusFromHttp(res.status, res.text);
      const error = `HTTP ${res.status} ${res.statusText} from cloudflare: ${res.text.slice(0, 280)}`;
      this._usage.lastError = error;
      try {
        await BudgetManager.getInstance().recordLlmCall(
          `cloudflare/${opts.model}`,
          0,
          false
        );
      } catch (err) {
        console.error(`[llm:${this.name}] recordLlmCall(fail) errored:`, err);
      }
      await logEvent(
        "model_router",
        status === "rate_limited" || status === "quota_exhausted" ? "warn" : "error",
        "provider_call_failed",
        {
          provider: this.name,
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

    const data = (res.json as Record<string, unknown> | null) ?? {};
    // Cloudflare returns the OpenAI shape directly: { choices: [...], usage: {...} }
    // Some response wrappers wrap it in `result` — handle both.
    const inner =
      (data.result as Record<string, unknown> | undefined) ?? data;
    const choices = (inner.choices as Array<Record<string, unknown>> | undefined) ?? [];
    const content: string =
      (choices[0]?.message as { content?: string } | undefined)?.content ??
      (choices[0]?.text as string | undefined) ??
      "";
    const usageBlock = (inner.usage as Record<string, unknown> | undefined) ?? {};
    const promptTokens: number =
      Number(usageBlock.prompt_tokens) || estimateTokens(JSON.stringify(opts.messages));
    const completionTokens: number =
      Number(usageBlock.completion_tokens) || estimateTokens(content);

    this._usage.requests += 1;
    this._usage.tokens += promptTokens + completionTokens;
    // NOTE: Budget recording for SUCCESSFUL calls is done ONCE by the
    // central `callLLM` in src/lib/llm/provider.ts. We deliberately do
    // NOT call `recordLlmCall` here on the success path — doing so would
    // double-count tokens (provider adapter + callLLM both incrementing
    // the same BudgetUsage row). The failure path below still records
    // a 0-token request so the request counter reflects every attempt.

    if (!content) {
      const error = `${this.name} returned empty content`;
      this._usage.lastError = error;
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
      model: opts.model,
      rateLimitHeaders: rateLimit,
      raw: data,
    };
  }

  structuredOutput(opts: GenerateOpts, schema?: unknown): Promise<GenerateResult> {
    const enriched: GenerateOpts = { ...opts, responseFormat: "json" };
    if (schema) {
      const hint = JSON.stringify(schema);
      enriched.messages = [
        ...opts.messages,
        {
          role: "system",
          content: `Respond with a JSON object matching this schema: ${hint}`,
        },
      ];
    }
    return this.generate(enriched);
  }

  async toolCall(opts: GenerateOpts, _tools: ToolDef[]): Promise<GenerateResult> {
    // Cloudflare Workers AI does not yet support tool-calling — return a
    // structured error so the caller can fall back to a different provider.
    return {
      success: false,
      content: "",
      usage: { promptTokens: 0, completionTokens: 0 },
      latencyMs: 0,
      error: `${this.name} does not support tool-calling`,
      status: "not_configured",
    };
  }

  usage(): ProviderUsage {
    return { ...this._usage };
  }

  limits(): ProviderLimits {
    return {
      supportsDiscovery: true,
      supportsJsonMode: true,
      supportsToolCalls: false,
    };
  }

  async capabilityProbe(modelId: string): Promise<Partial<ModelCapabilities>> {
    const result = await this.generate({
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
  }
}
