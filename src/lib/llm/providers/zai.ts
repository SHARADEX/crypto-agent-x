// Z.AI provider adapter (Phase-2 P2-1, P2-2, P2-3, P2-7).
//
// Z.AI is the live reasoning backend used by the dashboard demo — it works
// out-of-the-box in this environment via the `z-ai-web-dev-sdk` package,
// which reads its config from `/etc/.z-ai-config` (provisioned by the
// sandbox). No env var is required in this environment; the operator can
// optionally set `ZAI_API_KEY` to override.
//
// The SDK does NOT expose a `/models` discovery endpoint, so we hard-code
// the known Z.AI model catalogue and mark each model as "configured" only
// when the SDK actually instantiates successfully.

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
  ToolDef,
} from "@/lib/llm/providers/types";
import { estimateTokens } from "@/lib/llm/providers/types";

// ---------------------------------------------------------------------------
// Known Z.AI model catalogue (returned by listModels — no /models endpoint
// exists on the SDK).
// ---------------------------------------------------------------------------

export const ZAI_MODELS: DiscoveredModel[] = [
  { modelId: "glm-4.6", displayName: "GLM-4.6", contextWindow: 128_000, supportsJson: true, supportsTools: true, free: true },
  { modelId: "glm-4.5", displayName: "GLM-4.5", contextWindow: 128_000, supportsJson: true, supportsTools: true, free: true },
  { modelId: "glm-4.5-air", displayName: "GLM-4.5 Air", contextWindow: 128_000, supportsJson: true, supportsTools: false, free: true },
  { modelId: "glm-4.5-flash", displayName: "GLM-4.5 Flash", contextWindow: 128_000, supportsJson: true, supportsTools: false, free: true },
  { modelId: "glm-4.5v", displayName: "GLM-4.5V (vision)", contextWindow: 64_000, supportsJson: true, supportsTools: false, supportsVision: true, free: true },
  { modelId: "glm-4-plus", displayName: "GLM-4-Plus", contextWindow: 128_000, supportsJson: true, supportsTools: true, free: true },
];

// ---------------------------------------------------------------------------
// SDK loader (mirrors the existing `getZaiSdk` from provider.ts)
// ---------------------------------------------------------------------------

let _zaiSdk: unknown | null = null;
let _zaiSdkPromise: Promise<unknown> | null = null;
let _zaiSdkError: string | null = null;

async function getZaiSdk(): Promise<unknown> {
  if (_zaiSdk) return _zaiSdk;
  if (_zaiSdkError) throw new Error(_zaiSdkError);
  if (_zaiSdkPromise) return _zaiSdkPromise;

  _zaiSdkPromise = (async () => {
    try {
      // Dynamic import so the module loads even if the SDK isn't installed.
      const mod: any = await import("z-ai-web-dev-sdk");
      const ZAICtor = mod.default ?? mod.ZAI ?? mod;
      if (typeof ZAICtor?.create !== "function") {
        throw new Error("z-ai-web-dev-sdk does not export a ZAI.create() method");
      }
      const instance = await ZAICtor.create();
      _zaiSdk = instance;
      return instance;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      _zaiSdkError = `z-ai-web-dev-sdk unavailable: ${msg}`;
      console.error("[llm:zai]", _zaiSdkError);
      throw new Error(_zaiSdkError);
    } finally {
      _zaiSdkPromise = null;
    }
  })();

  return _zaiSdkPromise;
}

// ---------------------------------------------------------------------------
// ZaiProvider
// ---------------------------------------------------------------------------

export class ZaiProvider implements AIProvider {
  readonly name = "zai";
  readonly displayName = "Z.AI (GLM)";

  private _usage: ProviderUsage & {
    requests: number;
    tokens: number;
    cooldownUntil: number;
    lastError?: string;
  } = {
    requests: 0,
    tokens: 0,
    cooldownUntil: 0,
  };

  isConfigured(): boolean {
    // The Z.AI SDK auto-provisions when /etc/.z-ai-config exists (sandbox
    // environment). Outside the sandbox, the operator must set ZAI_API_KEY.
    // Phase-3 fix: previously this returned `true` unconditionally, which
    // was correct in the sandbox but misleading outside it (a fresh deploy
    // with no ZAI_API_KEY and no /etc/.z-ai-config would report Z.AI as
    // "configured" — the first real call would then fail). We now probe
    // the sandbox config file synchronously so the report is accurate.
    if (process.env.ZAI_API_KEY && process.env.ZAI_API_KEY.trim().length > 0) {
      return true;
    }
    try {
      // The SDK reads from this path on boot. If the file exists, the SDK
      // will auto-provision credentials on the first call.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { existsSync } = require("node:fs") as {
        existsSync: (p: string) => boolean;
      };
      return existsSync("/etc/.z-ai-config");
    } catch {
      // If fs isn't available for some reason, fall back to the optimistic
      // assumption (the first call will fail loudly if wrong).
      return true;
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
        detail: "z-ai-web-dev-sdk not provisioned and ZAI_API_KEY is not set",
      };
    }
    // CRON-REVIEW-8: previously this did a real 1-token LLM call which
    // tripped Z.AI's rate limit on every health check. Now we just verify
    // the SDK instantiates (which validates the config) — the actual API
    // call is deferred to the first real LLM request. This avoids burning
    // rate-limit quota on health probes.
    const startedAt = Date.now();
    try {
      await getZaiSdk();
      const latencyMs = Date.now() - startedAt;
      return {
        status: "healthy",
        detail: "SDK instantiated (config valid)",
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
    // The SDK doesn't expose a /models endpoint. Return the static catalogue
    // — but only when the SDK instantiates successfully.
    try {
      await getZaiSdk();
      return ZAI_MODELS.map((m) => ({ ...m }));
    } catch {
      return [];
    }
  }

  async generate(opts: GenerateOpts): Promise<GenerateResult> {
    const startedAt = Date.now();
    let sdk: any;
    try {
      sdk = await getZaiSdk();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this._usage.lastError = error;
      return {
        success: false,
        content: "",
        usage: { promptTokens: 0, completionTokens: 0 },
        latencyMs: Date.now() - startedAt,
        error,
        status: "not_configured",
      };
    }

    const body: Record<string, unknown> = {
      model: opts.model.replace(/^zai\//, ""),
      messages: opts.messages,
      // thinking disabled — keep latency predictable for agent tasks.
      thinking: { type: "disabled" },
    };
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.responseFormat === "json") {
      body.response_format = { type: "json_object" };
    }

    // Budget: record this as a web request before going out.
    try {
      await BudgetManager.getInstance().recordWebRequest();
    } catch (err) {
      console.error(`[llm:${this.name}] recordWebRequest failed:`, err);
    }

    try {
      const response: any = await sdk.chat.completions.create(body);
      const data = response as OpenAiChatResponse;
      const content: string =
        data?.choices?.[0]?.message?.content ??
        (data?.choices?.[0] as { text?: string } | undefined)?.text ??
        "";
      const promptTokens: number =
        data?.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(opts.messages));
      const completionTokens: number =
        data?.usage?.completion_tokens ?? estimateTokens(content);

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
        };
      }

      return {
        success: true,
        content,
        usage: { promptTokens, completionTokens },
        latencyMs: Date.now() - startedAt,
        model: opts.model,
        raw: data,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._usage.lastError = msg;
      try {
        await BudgetManager.getInstance().recordLlmCall(
          `zai/${opts.model}`,
          0,
          false
        );
      } catch (e2) {
        console.error(`[llm:${this.name}] recordLlmCall(fail) errored:`, e2);
      }
      await logEvent(
        "model_router",
        "error",
        "provider_call_failed",
        {
          provider: this.name,
          model: opts.model,
          error: msg.slice(0, 280),
        },
        {}
      ).catch(() => null);
      return {
        success: false,
        content: "",
        usage: { promptTokens: 0, completionTokens: 0 },
        latencyMs: Date.now() - startedAt,
        error: msg,
        status: "unhealthy",
      };
    }
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

  async toolCall(opts: GenerateOpts, tools: ToolDef[]): Promise<GenerateResult> {
    // Z.AI SDK supports the OpenAI `tools` body field when the model allows it.
    const enriched: GenerateOpts = { ...opts, tools };
    return this.generate(enriched);
  }

  usage(): ProviderUsage {
    return { ...this._usage };
  }

  limits(): ProviderLimits {
    return {
      // The SDK doesn't expose a /models endpoint.
      supportsDiscovery: false,
      supportsJsonMode: true,
      supportsToolCalls: true,
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
