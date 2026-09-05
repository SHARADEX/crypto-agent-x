// GitHub-bounties source adapter (Phase-2 spec §18).
//
// Wraps the existing `scanGitHubBounties` from `scanners/github-scanner.ts`
// so the new pluggable OpportunitySource architecture can drive discovery
// through a uniform contract. The adapter is instantiated TWICE:
//
//   1. `GithubBountiesSource` for `label:bounty`      (id: `github_issues`)
//   2. `GithubBountiesSource` for `label:help-wanted` (id: `github_help_wanted`)
//
// GitHub Search API is unauthenticated (60 req/hour/IP). The underlying
// scanner already records budget, uses a 10s AbortController timeout, and
// maps results into `RawOpportunityInput`. This adapter just adapts the
// existing return shape to the new contract.

import { scanGitHubBounties } from "@/lib/agent/scanners/github-scanner";
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

export interface GithubBountiesSourceOptions {
  /** Source-config id (e.g. `github_issues` or `github_help_wanted`). */
  id: string;
  /** Human-readable label. */
  name: string;
  /** GitHub Search API URL (with query, sort, per_page). */
  endpoint: string;
  /** Reliability seed 0..100 — surfaced via healthCheck detail, not used here. */
  reliabilitySeed?: number;
  /** Max opportunities per discover() call. Default 30 (one page). */
  defaultMaxResults?: number;
}

/**
 * Adapter that wraps the existing GitHub scanner. Two instances are
 * registered in the SOURCES array — one for `label:bounty`, one for
 * `label:help-wanted`.
 *
 * Contract notes:
 *   - `discover()` never throws — delegates to `scanGitHubBounties` which
 *     is already defensive (returns `{ opportunities: [], error }` on any
 *     failure).
 *   - `healthCheck()` issues a tiny HEAD against the GitHub root URL.
 *   - `normalize()` is the identity pass — the underlying scanner already
 *     returns `RawOpportunityInput` objects.
 */
export class GithubBountiesSource implements OpportunitySource {
  readonly id: string;
  readonly name: string;
  readonly type = "api" as const;

  private readonly endpoint: string;
  private readonly defaultMaxResults: number;
  private readonly reliabilitySeed?: number;

  constructor(opts: GithubBountiesSourceOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.endpoint = opts.endpoint;
    this.defaultMaxResults = opts.defaultMaxResults ?? 30;
    this.reliabilitySeed = opts.reliabilitySeed;
  }

  async discover(opts?: DiscoverOptions): Promise<RawOpportunityInput[]> {
    const limit = opts?.maxResults ?? this.defaultMaxResults;
    try {
      const result = await scanGitHubBounties({
        limit,
        endpoint: this.endpoint,
      });
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
      // Defensive — scanGitHubBounties already catches, but belt + braces.
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
    // Minimal HEAD against api.github.com root. We don't hit the search
    // endpoint to avoid burning rate-limit quota on the liveness probe.
    const probeUrl = "https://api.github.com";
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch(probeUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "CryptoEarn-Agent/0.3",
        },
      });
      const latencyMs = Date.now() - start;
      clearTimeout(timer);
      // GitHub returns 200 for the root; a 403 indicates rate-limit. Either
      // way the endpoint is reachable. 5xx = degraded.
      if (res.status >= 500) {
        return {
          ok: false,
          detail: `GitHub API unhealthy: HTTP ${res.status}`,
          latencyMs,
        };
      }
      return {
        ok: true,
        detail: `GitHub API reachable (HTTP ${res.status})`,
        latencyMs,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        detail: `GitHub API unreachable: ${msg}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  normalize(raw: unknown): RawOpportunityInput {
    // The underlying scanner already returns RawOpportunityInput objects;
    // if a malformed value slips through we coerce it to a minimal shape.
    if (raw && typeof raw === "object") {
      const r = raw as Partial<RawOpportunityInput>;
      if (r.title && r.sourceUrl) {
        return {
          title: r.title,
          description: r.description ?? "",
          sourceUrl: r.sourceUrl,
          organization: r.organization ?? "unknown",
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
    // Unusable raw — return a sentinel that the normaliser will reject
    // (empty title/url triggers downstream filtering in normalizeOpportunity).
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
