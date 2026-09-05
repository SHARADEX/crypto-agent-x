// Discovery cycle — backward-compat wrapper (Phase-2 spec §18, §19).
//
// The OLD `runDiscoveryCycle` lived here. It now delegates to the new
// pluggable OpportunitySource architecture in
// `src/lib/agent/sources/index.ts` (`runDiscoveryCycleV2`).
//
// All existing callers (orchestrator loop, bootstrap, /api/opportunities/seed
// route, scout-agent) continue to import `runDiscoveryCycle` from this module
// — the wrapper preserves the original signature so no other file needs to
// change.
//
// The wrapper also re-exports the scanner entry points (`scanGitHubBounties`,
// `scanMockOpportunities`) and their result types so any code that depended
// on them keeps working.

import {
  runDiscoveryCycleV2,
  type DiscoverySummary,
} from "@/lib/agent/sources";

export type { DiscoverySummary };

/**
 * Run a full discovery cycle. Delegates to `runDiscoveryCycleV2` in
 * `src/lib/agent/sources/index.ts` — the new pluggable OpportunitySource
 * architecture. Returns the same {@link DiscoverySummary} shape so the
 * orchestrator loop + dashboard + API routes are unchanged.
 *
 * @returns a {@link DiscoverySummary} describing what was discovered, what
 *          was new vs duplicate, what was rejected, and any source errors.
 */
export async function runDiscoveryCycle(): Promise<DiscoverySummary> {
  return runDiscoveryCycleV2();
}

// ---------------------------------------------------------------------------
// Re-exports for downstream callers
// ---------------------------------------------------------------------------

export { scanGitHubBounties } from "@/lib/agent/scanners/github-scanner";
export { scanMockOpportunities } from "@/lib/agent/scanners/mock-scanner";

export type { GitHubScanResult } from "@/lib/agent/scanners/github-scanner";
export type { MockScanResult } from "@/lib/agent/scanners/mock-scanner";

// Re-export the new V2 architecture so callers can opt in.
export {
  SOURCES,
  getConfiguredSources,
  runDiscoveryCycleV2,
  activateRuntimeSource,
  deactivateRuntimeSource,
  invalidateConfiguredSourcesCache,
} from "@/lib/agent/sources";
export type { OpportunitySource } from "@/lib/agent/sources/types";
