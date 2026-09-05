// OpportunitySource interface (Phase-2 spec §18, §19).
//
// Every external source of opportunities (GitHub Search API, RSS feed,
// hackathon platform REST API, GraphQL indexer, mock board) is wrapped by
// a single `OpportunitySource` adapter. The adapter is responsible for:
//
//   - `discover()`         — fetch + map raw results into RawOpportunityInput[]
//   - `fetchDetails()`     — (optional) deep-fetch a single opportunity
//   - `healthCheck()`      — minimal liveness probe (HEAD or small GET)
//   - `normalize()`        — ensure every raw item has the canonical fields
//
// The adapter contract is ironclad:
//   - NEVER throws out of `discover()` / `healthCheck()`. On any failure the
//     adapter returns `[]` / `{ ok: false }` and logs the error.
//   - Every HTTP call must record budget via `BudgetManager.recordWebRequest()`.
//   - Every HTTP call must use an AbortController timeout (10s default).
//   - External content must be sanitised via `sanitizeExternalContent` (§21)
//     before being inspected.
//
// `RawOpportunityInput` is the canonical raw shape emitted by every adapter
// — it is defined ONCE in `@/lib/agent/normalize` and re-exported here so
// adapters can import it from a single source of truth.

import type { RawOpportunityInput } from "@/lib/agent/normalize";

// Re-export so adapter authors can import the canonical raw shape directly
// from `@/lib/agent/sources/types` without reaching across module
// boundaries. The canonical definition lives in normalize.ts.
export type { RawOpportunityInput } from "@/lib/agent/normalize";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Source-type discriminator. Used by `getConfiguredSources()` to decide
 * whether to run `healthCheck()` before listing a source as available.
 * `mock` sources are always considered available (no network call).
 */
export type SourceType = "api" | "rss" | "web" | "mock";

/**
 * Result returned by `OpportunitySource.healthCheck()`. Never throws —
 * adapters surface every failure via `{ ok: false, detail }`.
 */
export interface HealthCheckResult {
  ok: boolean;
  detail: string;
  /** Round-trip latency of the probe, when measurable. */
  latencyMs?: number;
}

/**
 * Options accepted by `OpportunitySource.discover()`. Adapters may ignore
 * any option they don't understand — `maxResults` is the only one every
 * adapter is expected to honour.
 */
export interface DiscoverOptions {
  /** Max number of opportunities to emit. Default adapter-specific. */
  maxResults?: number;
  /** Only return opportunities updated after this timestamp. */
  since?: Date;
}

/**
 * The canonical source-adapter contract (Phase-2 spec §18).
 *
 * Every adapter (GitHub, Gitcoin, Devpost, OnlyDust, Hashnode, RSS, mock)
 * implements this interface. The discovery pipeline (`runDiscoveryCycleV2`)
 * calls `discover()` on every configured source in parallel, normalises the
 * results, deduplicates, runs scam/verify/score, persists, and bumps
 * `SourceReputation` counters — all using the existing pipeline.
 */
export interface OpportunitySource {
  /** Stable identifier persisted on `Opportunity.source` + `SourceReputation.source`. */
  readonly id: string;
  /** Human-readable label shown on the dashboard. */
  readonly name: string;
  /** Discriminator used by `getConfiguredSources()` to skip healthCheck for mocks. */
  readonly type: SourceType;

  /**
   * Discover opportunities from this source. NEVER throws — on any failure
   * returns `[]` and logs the error via `logEvent("scout", ...)`.
   *
   * Implementations:
   *   - Record `BudgetManager.recordWebRequest()` BEFORE every outbound HTTP call.
   *   - Use an AbortController timeout (10s default).
   *   - Sanitise external content via `sanitizeExternalContent` (spec §21).
   *   - Map the result into `RawOpportunityInput[]` — `canonicalId` is
   *     computed downstream by `normalizeOpportunity`, so adapters only
   *     need to provide raw fields.
   */
  discover(opts?: DiscoverOptions): Promise<RawOpportunityInput[]>;

  /**
   * Optional: deep-fetch a single opportunity when the source supports it
   * (e.g. a GraphQL `round(id: …)` query). Adapters that don't support
   * deep-fetch leave this undefined and the discovery pipeline uses the
   * shallow data from `discover()`.
   */
  fetchDetails?(opportunityId: string): Promise<RawOpportunityInput | null>;

  /**
   * Verify the source is reachable and credentials (if any) work. Used by
   * `getConfiguredSources()` to filter dead sources out of the cycle.
   *
   * NEVER throws — returns `{ ok: false, detail }` on any failure.
   */
  healthCheck(): Promise<HealthCheckResult>;

  /**
   * Normalise a raw opportunity emitted by `discover()` into the canonical
   * `RawOpportunityInput` shape. Most adapters don't need to do anything
   * (they already return RawOpportunityInput); this hook exists for
   * adapters that emit source-specific intermediate shapes (e.g. a GraphQL
   * response) and want a single normalisation pass.
   *
   * The returned object must have all required `RawOpportunityInput` fields
   * populated (the global `normalizeOpportunity` will fill in defaults for
   * missing optional fields + compute `canonicalId`).
   */
  normalize(raw: unknown): RawOpportunityInput;
}
