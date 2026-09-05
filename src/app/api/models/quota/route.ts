// GET /api/models/quota
//
// Phase-2 P2-20 §36 / P2-7: dashboard "Live Quota" panel endpoint.
//
// Returns the in-memory `quotaTracker.getQuotaReport()` shape — one entry
// per provider that has been called at least once (or pushed into cooldown
// by a 429). Each entry carries:
//   - provider              — canonical id
//   - requests               — total requests this process has recorded
//   - tokens                 — total tokens this process has recorded
//   - rateLimitRemaining     — last-seen x-ratelimit-remaining value (if any)
//   - rateLimitReset         — epoch-ms when the rate-limit window resets
//   - cooldownUntil          — epoch-ms when the manual cooldown expires
//   - inCooldown             — true if cooldownUntil > now
//   - lastError              — the last error string recorded for this provider
//
// We ALSO cross-reference with `providerRegistry.snapshot()` so the dashboard
// can show "no data yet" providers (a provider that has never been called
// won't appear in the quota report — we add zero-usage entries for every
// configured provider so the panel renders uniformly).

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { quotaTracker } from "@/lib/llm/quota-tracker";
import { PROVIDERS } from "@/lib/llm/providers";
import { providerRegistry } from "@/lib/llm/provider-registry";
import type { QuotaReportEntry } from "@/lib/llm/quota-tracker";

export const dynamic = "force-dynamic";

export interface QuotaReportResponse {
  quota: QuotaReportEntry[];
  count: number;
  fetchedAt: string;
}

export async function GET() {
  try {
    await bootstrapAgent();

    const reported = quotaTracker.getQuotaReport();
    const seen = new Set(reported.map((r) => r.provider));

    // For every configured provider NOT already in the report, add a zero
    // row so the dashboard panel renders uniformly.
    const fill: QuotaReportEntry[] = [];
    for (const p of PROVIDERS) {
      if (seen.has(p.name)) continue;
      if (!p.isConfigured()) continue;
      fill.push({
        provider: p.name,
        requests: 0,
        tokens: 0,
        rateLimitRemaining: undefined,
        rateLimitReset: undefined,
        cooldownUntil: 0,
        inCooldown: false,
        lastError: undefined,
      });
    }

    // Surface the provider-registry status alongside so the dashboard can
    // colour-code the row (e.g. red when `status === "rate_limited"`).
    const merged = [...reported, ...fill].map((entry) => {
      const registryStatus = providerRegistry.getStatus(entry.provider);
      return {
        ...entry,
        providerStatus: registryStatus ?? null,
      };
    });
    merged.sort((a, b) => a.provider.localeCompare(b.provider));

    return NextResponse.json(
      {
        quota: merged,
        count: merged.length,
        fetchedAt: new Date().toISOString(),
      } as QuotaReportResponse & {
        quota: (QuotaReportEntry & {
          providerStatus: import("@/lib/llm/providers/types").ProviderStatus | null;
        })[];
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/models/quota GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
