// Mock source adapter (Phase-2 spec §18, §43).
//
// Wraps the existing `scanMockOpportunities` from `scanners/mock-scanner.ts`
// so the new pluggable OpportunitySource architecture can drive discovery
// through a uniform contract. The mock source is ALWAYS considered healthy
// (no network call) and is used to exercise the full lifecycle without
// spending real money or hitting external APIs.

import { scanMockOpportunities } from "@/lib/agent/scanners/mock-scanner";
import type { RawOpportunityInput } from "@/lib/agent/normalize";
import { logEvent } from "@/lib/agent/events";
import type {
  DiscoverOptions,
  HealthCheckResult,
  OpportunitySource,
} from "@/lib/agent/sources/types";

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface MockSourceOptions {
  /** Source-config id (e.g. `mock_bounties`, `mock_hackathons`). */
  id: string;
  /** Human-readable label. */
  name: string;
}

/**
 * Adapter that wraps the existing mock scanner. The mock source is always
 * considered healthy — `healthCheck()` returns `{ ok: true }` without any
 * network call.
 *
 * This source exists to demonstrate the full lifecycle (discover →
 * normalize → verify → score → persist → reputation) deterministically
 * without spending real money or hitting external APIs.
 */
export class MockSource implements OpportunitySource {
  readonly id: string;
  readonly name: string;
  readonly type = "mock" as const;

  constructor(opts: MockSourceOptions) {
    this.id = opts.id;
    this.name = opts.name;
  }

  async discover(_opts?: DiscoverOptions): Promise<RawOpportunityInput[]> {
    try {
      const result = scanMockOpportunities();
      if (result.error) {
        await logEvent(
          "scout",
          "warn",
          "source_discover_error",
          { source: this.id, error: result.error },
          {}
        ).catch(() => null);
      }
      const count = result.opportunities.length;
      if (count > 0) {
        await logEvent(
          "scout",
          "info",
          "source_discovered",
          { source: this.id, count },
          {}
        ).catch(() => null);
      }
      return result.opportunities;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logEvent(
        "scout",
        "error",
        "source_discover_threw",
        { source: this.id, error: msg },
        {}
      ).catch(() => null);
      return [];
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    // Mock sources are always healthy — no network call.
    return { ok: true, detail: "mock source — always available" };
  }

  normalize(raw: unknown): RawOpportunityInput {
    if (raw && typeof raw === "object") {
      const r = raw as Partial<RawOpportunityInput>;
      if (r.title && r.sourceUrl) {
        return {
          title: r.title,
          description: r.description ?? "",
          sourceUrl: r.sourceUrl,
          organization: r.organization ?? "",
          category: r.category ?? "coding_task",
          reward: r.reward ?? { amount: 0, currency: "USDC", estimated_usd: 0 },
          deadline: r.deadline ?? null,
          requirements: r.requirements ?? [],
          skillsRequired: r.skillsRequired ?? [],
          estimatedHours: r.estimatedHours ?? 0,
          difficulty: r.difficulty ?? 5,
          competition: r.competition ?? 5,
          eligibility: r.eligibility ?? [],
          paymentMethod: r.paymentMethod ?? "",
          capitalRequired: r.capitalRequired ?? false,
          source: this.id,
        };
      }
    }
    return {
      title: "",
      description: "",
      sourceUrl: "",
      organization: "",
      category: "coding_task",
      source: this.id,
    };
  }
}
