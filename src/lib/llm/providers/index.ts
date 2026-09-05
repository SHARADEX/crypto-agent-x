// Provider registry — wires all 9 provider adapters + bootstrap helpers
// (Phase-2 P2-1, P2-3, P2-7).
//
// Exports:
//   - `PROVIDERS`               — array of one instance of each adapter.
//   - `getProvider(name)`       — lookup by canonical id.
//   - `getConfiguredProviders()` — only the ones with env vars set.
//   - `getProviderStatuses()`   — { name → { status, isConfigured } }.
//   - `bootstrapProviders()`    — runs health checks + discovery on every
//                                  configured provider; upserts discovered
//                                  models into the DB registry as PRIORs.
//
// The registry is the single place the router / provider dispatch layer
// asks "give me the AIProvider instance for this model's provider".

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import type { ModelCapabilities } from "@/lib/agent/types";
import type {
  AIProvider,
  DiscoveredModel,
  ProviderStatus,
} from "@/lib/llm/providers/types";
import { OpenRouterProvider } from "@/lib/llm/providers/openrouter";
import { GeminiProvider } from "@/lib/llm/providers/gemini";
import { GroqProvider } from "@/lib/llm/providers/groq";
import { CerebrasProvider } from "@/lib/llm/providers/cerebras";
import { HuggingFaceProvider } from "@/lib/llm/providers/huggingface";
import { MistralProvider } from "@/lib/llm/providers/mistral";
import { CloudflareProvider } from "@/lib/llm/providers/cloudflare";
import { NvidiaProvider } from "@/lib/llm/providers/nvidia";
import { ZaiProvider } from "@/lib/llm/providers/zai";
import { providerRegistry } from "@/lib/llm/provider-registry";
import { quotaTracker } from "@/lib/llm/quota-tracker";

// ---------------------------------------------------------------------------
// PROVIDERS array — the canonical list
// ---------------------------------------------------------------------------

export const PROVIDERS: AIProvider[] = [
  new ZaiProvider(),
  OpenRouterProvider,
  GeminiProvider,
  GroqProvider,
  CerebrasProvider,
  HuggingFaceProvider,
  MistralProvider,
  new CloudflareProvider(),
  NvidiaProvider,
];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function getProvider(name: string): AIProvider | undefined {
  return PROVIDERS.find((p) => p.name === name);
}

export function getConfiguredProviders(): AIProvider[] {
  return PROVIDERS.filter((p) => p.isConfigured());
}

export function getProviderStatuses(): Record<
  string,
  { status: ProviderStatus; isConfigured: boolean }
> {
  const out: Record<string, { status: ProviderStatus; isConfigured: boolean }> = {};
  for (const p of PROVIDERS) {
    const configured = p.isConfigured();
    const prior = providerRegistry.getStatus(p.name);
    out[p.name] = {
      isConfigured: configured,
      // P0-2 fix: previously defaulted to "healthy" when no healthCheck had
      // run yet — this falsely reported EVERY configured provider as healthy
      // even with invalid credentials (before bootstrapProviders ran). Default
      // to "degraded" instead so the dashboard surfaces "unverified" until the
      // first real healthCheck runs. This does NOT affect routing — the router
      // uses per-model `ModelStatus` + `CircuitBreaker`, not this provider-
      // level status. The dashboard just displays it.
      status:
        !configured
          ? "not_configured"
          : prior ?? "degraded",
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapProvidersResult {
  configured: string[];
  notConfigured: string[];
  healthy: string[];
  unhealthy: string[];
  modelsDiscovered: number;
  errors: string[];
}

const BOOTSTRAP_HEALTH_TIMEOUT_MS = 10_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fallback);
      }
    }, ms);
    promise.then((v) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(v);
      }
    }).catch(() => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(fallback);
      }
    });
  });
}

/**
 * Run at startup. For every provider:
 *   1. Check `isConfigured()`.
 *   2. If configured, run `healthCheck()` (10s timeout — don't block startup
 *      if a provider is slow).
 *   3. If healthy, call `listModels()` to discover models.
 *   4. For each discovered model, upsert into the `ModelRecord` table via
 *      the registry. Mark `real_world_samples = 0`, `confidence = "low"`,
 *      capabilities tagged as a PRIOR (not a verified benchmark).
 *   5. If not configured, mark the provider `not_configured` in the status
 *      map (don't crash).
 *
 * Always returns a summary. NEVER throws.
 */
export async function bootstrapProviders(): Promise<BootstrapProvidersResult> {
  const configured: string[] = [];
  const notConfigured: string[] = [];
  const healthy: string[] = [];
  const unhealthy: string[] = [];
  const errors: string[] = [];
  let modelsDiscovered = 0;

  for (const provider of PROVIDERS) {
    try {
      if (!provider.isConfigured()) {
        notConfigured.push(provider.name);
        providerRegistry.setStatus(provider.name, "not_configured");
        continue;
      }
      configured.push(provider.name);

      const hc = await withTimeout(
        provider.healthCheck(),
        BOOTSTRAP_HEALTH_TIMEOUT_MS,
        {
          status: "unhealthy" as ProviderStatus,
          detail: "health check timed out",
        }
      );

      providerRegistry.setStatus(provider.name, hc.status);
      if (hc.status === "healthy") {
        healthy.push(provider.name);
      } else {
        unhealthy.push(provider.name);
        errors.push(`${provider.name}: ${hc.detail}`);
        // Even if not fully healthy, we still attempt discovery — the
        // /models endpoint may succeed even when a 1-token ping fails.
      }

      if (hc.status === "healthy" || hc.status === "degraded") {
        try {
          const models = await withTimeout(
            provider.listModels(),
            BOOTSTRAP_HEALTH_TIMEOUT_MS,
            [] as DiscoveredModel[]
          );
          for (const model of models) {
            try {
              await upsertDiscoveredModel(provider.name, model);
              modelsDiscovered += 1;
            } catch (err) {
              errors.push(
                `${provider.name}/${model.modelId}: ${
                  err instanceof Error ? err.message : String(err)
                }`
              );
            }
          }
          // Sync the provider's usage snapshot to the quota tracker so the
          // router has fresh data on the first request.
          const usage = provider.usage();
          quotaTracker.record(provider.name, usage, undefined);
        } catch (err) {
          errors.push(
            `${provider.name} discovery: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }

      await logEvent(
        "model_router",
        "info",
        "provider_bootstrap",
        {
          provider: provider.name,
          status: hc.status,
          detail: hc.detail,
          latencyMs: hc.latencyMs,
        },
        {}
      ).catch(() => null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${provider.name}: ${msg}`);
      unhealthy.push(provider.name);
      providerRegistry.setStatus(provider.name, "unhealthy");
    }
  }

  return {
    configured,
    notConfigured,
    healthy,
    unhealthy,
    modelsDiscovered,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Upsert helper — discovered models become ModelRecord PRIORs
// ---------------------------------------------------------------------------

const PRIOR_CAPABILITIES: ModelCapabilities = {
  reasoning: 5,
  coding: 5,
  research: 5,
  web_research: 5,
  web3: 5,
  security: 5,
  writing: 5,
  tool_use: 5,
  structured_output: 5,
};

const PRIOR_PERFORMANCE = {
  success_rate: 0.5,
  average_quality: 5,
  average_latency: 2000,
  average_tokens: 1000,
  failure_rate: 0.5,
};

const PRIOR_LIMITS = {
  requests_per_minute: 10,
  tokens_per_minute: 10000,
  daily_requests: 100,
  daily_tokens: 50000,
};

/**
 * Upsert a discovered model into `db.modelRecord`. The discovered row is
 * tagged as a PRIOR — `real_world_samples = 0`, `confidence = "low"`, and
 * the capabilities block is the conservative default (NOT a verified
 * benchmark). The router will refine these as real call outcomes are
 * recorded by `recordModelPerformance`.
 *
 * Idempotent: if the row already exists (operator-seeded), we preserve the
 * operator's `role` / `status` / `enabled` / `earningsContribUsd` — only
 * refresh the `provider` / `apiType` / `limitsJson` / `performanceJson`.
 * We DO NOT overwrite a non-default `capabilitiesJson` (the operator may
 * have benchmarked the model themselves).
 */
async function upsertDiscoveredModel(
  providerName: string,
  model: DiscoveredModel
): Promise<void> {
  const modelId = `${providerName}/${model.modelId}`;
  const capabilities: ModelCapabilities = { ...PRIOR_CAPABILITIES };
  // If the provider explicitly told us the model supports JSON / tools / vision,
  // bump those capability dimensions a bit so the router is more likely to
  // pick the model for those tasks.
  if (model.supportsJson) capabilities.structured_output = 7;
  if (model.supportsTools) capabilities.tool_use = 7;
  if (model.supportsVision) capabilities.web_research = 6;

  const existing = await db.modelRecord.findUnique({
    where: { modelId },
    select: {
      role: true,
      status: true,
      enabled: true,
      earningsContribUsd: true,
      capabilitiesJson: true,
    },
  });

  const hasOperatorCaps =
    existing && existing.capabilitiesJson && existing.capabilitiesJson !== JSON.stringify(PRIOR_CAPABILITIES);

  await db.modelRecord.upsert({
    where: { modelId },
    create: {
      modelId,
      provider: providerName,
      apiType: providerName === "zai" ? "zai" : "openai-compatible",
      enabled: true,
      role: "exploration",
      status: "healthy",
      capabilitiesJson: JSON.stringify(capabilities),
      performanceJson: JSON.stringify(PRIOR_PERFORMANCE),
      limitsJson: JSON.stringify({
        ...PRIOR_LIMITS,
        context_window: model.contextWindow ?? null,
        discovered_at: new Date().toISOString(),
        source: "provider_discovery_prior",
        confidence: "low",
        real_world_samples: 0,
      }),
      earningsContribUsd: 0,
    },
    update: {
      provider: providerName,
      apiType: providerName === "zai" ? "zai" : "openai-compatible",
      // Preserve operator-set role / status / enabled / earnings.
      role: existing?.role ?? "exploration",
      status: existing?.status ?? "healthy",
      enabled: existing?.enabled ?? true,
      earningsContribUsd:
        existing && existing.earningsContribUsd > 0
          ? existing.earningsContribUsd
          : 0,
      // Only refresh capabilities if we didn't see an operator override.
      capabilitiesJson: hasOperatorCaps
        ? existing!.capabilitiesJson
        : JSON.stringify(capabilities),
      // Always refresh limits + performance on discovery — these decay over time.
      limitsJson: JSON.stringify({
        ...PRIOR_LIMITS,
        context_window: model.contextWindow ?? null,
        discovered_at: new Date().toISOString(),
        source: "provider_discovery_prior",
        confidence: "low",
        real_world_samples: 0,
      }),
      performanceJson: JSON.stringify(PRIOR_PERFORMANCE),
    },
  });
}

// Re-export the provider adapter classes + interface for callers.
export type { AIProvider, DiscoveredModel, ProviderStatus } from "@/lib/llm/providers/types";
export {
  OpenRouterProvider,
  GeminiProvider,
  GroqProvider,
  CerebrasProvider,
  HuggingFaceProvider,
  MistralProvider,
  CloudflareProvider,
  NvidiaProvider,
  ZaiProvider,
};
