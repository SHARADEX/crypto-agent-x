// GET /api/models/providers
//
// Phase-2 P2-20 §36: dashboard "Provider Health" grid endpoint.
//
// Returns one entry per registered provider adapter (9 total: zai, openrouter,
// gemini, groq, cerebras, huggingface, mistral, cloudflare, nvidia). Each
// entry carries:
//   - name              — canonical id (e.g. "zai")
//   - displayName       — human-friendly label (e.g. "Z.AI")
//   - status            — current ProviderStatus ("healthy" | "degraded" |
//                         "unhealthy" | "blacklisted" | "not_configured" |
//                         "rate_limited" | "quota_exhausted" |
//                         "invalid_credentials")
//   - isConfigured      — true if the env var(s) are set
//   - modelCount        — number of ModelRecord rows in the registry for this
//                         provider (so the dashboard can show "5 models")
//   - lastHealthCheckLatencyMs — the latency observed during the last
//                         `bootstrapProviders()` health check (null when no
//                         health check has been run yet)
//
// The endpoint reads from `PROVIDERS` (the static list of 9 adapter
// instances), `providerRegistry.snapshot()` (the last-known statuses), and
// `getModels()` (so we can count models per provider). It also pulls the
// most recent `provider_bootstrap` event for each provider to surface the
// last health-check latency — that data is recorded by `bootstrapProviders()`
// in `src/lib/llm/providers/index.ts` but not kept in memory, so we re-read
// it from the AgentEvent table.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { PROVIDERS } from "@/lib/llm/providers";
import { providerRegistry } from "@/lib/llm/provider-registry";
import { getModels } from "@/lib/llm/registry";
import type { ProviderStatus } from "@/lib/llm/providers/types";

export const dynamic = "force-dynamic";

export interface ProviderHealthEntry {
  name: string;
  displayName: string;
  status: ProviderStatus;
  isConfigured: boolean;
  modelCount: number;
  lastHealthCheckLatencyMs: number | null;
}

export async function GET() {
  try {
    await bootstrapAgent();

    const allModels = await getModels();
    const modelCountByProvider = new Map<string, number>();
    for (const m of allModels) {
      modelCountByProvider.set(
        m.provider,
        (modelCountByProvider.get(m.provider) ?? 0) + 1
      );
    }

    // Read the most recent `provider_bootstrap` event per provider so we
    // can surface the last health-check latency. The bootstrapProviders()
    // function records these at startup (and on subsequent health checks).
    const recentBootstrapEvents = await db.agentEvent
      .findMany({
        where: { event: "provider_bootstrap" },
        orderBy: { createdAt: "desc" },
        take: PROVIDERS.length * 4, // ~4 per provider cap
      })
      .catch(() => []);

    const lastLatencyByProvider = new Map<string, number>();
    for (const row of recentBootstrapEvents) {
      try {
        const payload = JSON.parse(row.payload ?? "{}") as {
          provider?: string;
          latencyMs?: number;
        };
        if (
          payload.provider &&
          typeof payload.latencyMs === "number" &&
          !lastLatencyByProvider.has(payload.provider)
        ) {
          lastLatencyByProvider.set(payload.provider, payload.latencyMs);
        }
      } catch {
        // ignore — bad JSON
      }
    }

    const out: ProviderHealthEntry[] = PROVIDERS.map((p) => {
      const configured = p.isConfigured();
      const prior = providerRegistry.getStatus(p.name);
      // P0-2 fix: previously defaulted to "healthy" when no healthCheck had
      // run yet — this falsely reported EVERY configured provider as healthy
      // even with invalid credentials (before bootstrapProviders ran). Default
      // to "degraded" instead so the dashboard surfaces "unverified" until the
      // first real healthCheck runs.
      const status: ProviderStatus = !configured
        ? "not_configured"
        : prior ?? "degraded";
      return {
        name: p.name,
        displayName: p.displayName,
        status,
        isConfigured: configured,
        modelCount: modelCountByProvider.get(p.name) ?? 0,
        lastHealthCheckLatencyMs: lastLatencyByProvider.get(p.name) ?? null,
      };
    });

    return NextResponse.json(
      { providers: out, count: out.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/models/providers GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
