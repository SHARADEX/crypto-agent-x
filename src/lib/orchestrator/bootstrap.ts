// Bootstrap (spec §28, §0).
//
// `bootstrapAgent()` runs once on the first API call (or first autonomous
// loop kick-off) if the agent hasn't been bootstrapped yet. It:
//
//   1. Calls `bootstrapModels()` from `@/lib/llm/registry` so the
//      `ModelRecord` table is seeded with the configured free-tier models
//      (zai/glm-4.6, openrouter/auto, gemini/*, groq/*, cerebras/*).
//   2. Calls `bootstrapStrategies()` from `@/lib/economics/strategy-stats`
//      so the `StrategyStat` table has the 11 canonical strategy rows.
//   3. Ensures the `AgentState` singleton row exists (so the dashboard
//      can read paused/autonomyMode without crashing on a cold DB).
//   4. Runs an initial discovery cycle IF the opportunity DB is empty.
//   5. Returns a summary: { bootstrapped, models, strategies, opportunities }.
//
// A module-level flag prevents re-running the full bootstrap on every
// invocation. The flag is per-process; a hot-reload in dev resets it (which
// is fine — all underlying operations are idempotent upserts).

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import { getState, setState } from "@/lib/agent/state";
import { bootstrapModels } from "@/lib/llm/registry";
import { bootstrapStrategies } from "@/lib/economics/strategy-stats";
import { bootstrapAllocations } from "@/lib/economics/strategy-allocator";
import { runDiscoveryCycle } from "@/lib/agent/scanners";
import { bootstrapProviders } from "@/lib/llm/providers";
import { getCircuitBreaker } from "@/lib/llm/circuit-breaker";

// ---------------------------------------------------------------------------
// Module-level flag
// ---------------------------------------------------------------------------

let bootstrapPromise: Promise<BootstrapResult> | null = null;
let bootstrapDone = false;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  bootstrapped: boolean;
  models: number;
  strategies: number;
  opportunities: number;
  discoveryRan: boolean;
  discoveryNew: number;
  providersConfigured: number;
  providersHealthy: number;
  modelsDiscovered: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// bootstrapAgent
// ---------------------------------------------------------------------------

/**
 * Run the bootstrap sequence ONCE per process. Subsequent calls return the
 * cached result without re-running the work. Safe to call from any API
 * route / server action — concurrent callers all await the same promise.
 */
export async function bootstrapAgent(): Promise<BootstrapResult> {
  if (bootstrapDone) {
    return {
      bootstrapped: false,
      models: 0,
      strategies: 0,
      opportunities: 0,
      discoveryRan: false,
      discoveryNew: 0,
      providersConfigured: 0,
      providersHealthy: 0,
      modelsDiscovered: 0,
      errors: [],
    };
  }
  if (bootstrapPromise) {
    return bootstrapPromise;
  }
  bootstrapPromise = doBootstrap();
  try {
    const result = await bootstrapPromise;
    bootstrapDone = true;
    return result;
  } finally {
    bootstrapPromise = null;
  }
}

/**
 * Force a re-bootstrap on the next call (used by tests / dev hot-reload).
 */
export function resetBootstrapFlag(): void {
  bootstrapDone = false;
  bootstrapPromise = null;
}

// ---------------------------------------------------------------------------
// Internal: the real bootstrap sequence
// ---------------------------------------------------------------------------

async function doBootstrap(): Promise<BootstrapResult> {
  const errors: string[] = [];
  let modelsSeeded = 0;
  let strategiesSeeded = 0;
  let opportunitiesCount = 0;
  let discoveryRan = false;
  let discoveryNew = 0;
  let providersConfigured = 0;
  let providersHealthy = 0;
  let modelsDiscovered = 0;

  // 1. Bootstrap the LLM model registry (idempotent upserts) — the SEED priors.
  try {
    const result = await bootstrapModels();
    modelsSeeded = result.seeded + result.skipped;
  } catch (err) {
    errors.push(
      `bootstrapModels: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 1b. Bootstrap real providers — health-check + discover models from
  // every configured provider API. Discovered models are upserted as PRIORs
  // (confidence="low", real_world_samples=0) so the router can use them
  // but treats the seed capabilities as estimates, not measured truth.
  try {
    const providerResult = await bootstrapProviders();
    providersConfigured = providerResult.configured.length;
    providersHealthy = providerResult.healthy.length;
    modelsDiscovered = providerResult.modelsDiscovered;
    // Re-seed so the discovered models are reflected in modelsSeeded count.
    if (modelsDiscovered > 0) {
      const result = await bootstrapModels();
      modelsSeeded = result.seeded + result.skipped;
    }
  } catch (err) {
    errors.push(
      `bootstrapProviders: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 1c. Hydrate the circuit breaker from the persisted BreakerState table
  // (Phase-2 P2-2). Restores blacklisted/unhealthy models so a process
  // restart doesn't immediately re-route to a known-bad model.
  try {
    const breaker = getCircuitBreaker();
    const hydration = await breaker.hydrateFromDb();
    if (hydration.restored > 0) {
      await logEvent(
        "model_router",
        "info",
        "circuit_breaker_hydrated",
        { restored: hydration.restored, details: hydration.details },
        {}
      );
    }
  } catch (err) {
    errors.push(
      `circuitBreaker hydrate: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 2. Bootstrap the strategy-stat rows.
  try {
    await bootstrapStrategies();
    strategiesSeeded = 11; // CANONICAL_STRATEGIES length
  } catch (err) {
    errors.push(
      `bootstrapStrategies: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 2b. Bootstrap the strategy-allocation rows (Phase 3 §16, §17). Seeds the
  // 7 family rows (bounty / freelance / hackathon / grant / contribution /
  // build_once / reward_program) with their default allocations.
  try {
    await bootstrapAllocations();
  } catch (err) {
    errors.push(
      `bootstrapAllocations: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 3. Ensure the AgentState singleton exists.
  try {
    const state = await getState();
    if (!state.running) {
      await setState({ running: false });
    }
  } catch (err) {
    errors.push(
      `AgentState ensure: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 4. Run an initial discovery cycle IF the DB is empty.
  try {
    opportunitiesCount = await db.opportunity.count();
    if (opportunitiesCount === 0) {
      const discovery = await runDiscoveryCycle();
      discoveryRan = true;
      discoveryNew = discovery.new;
      opportunitiesCount = await db.opportunity.count();
    }
  } catch (err) {
    errors.push(
      `initial discovery: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 5. Log the bootstrap result.
  await logEvent(
    "orchestrator",
    "info",
    "agent_bootstrapped",
    {
      modelsSeeded,
      strategiesSeeded,
      opportunitiesCount,
      discoveryRan,
      discoveryNew,
      providersConfigured,
      providersHealthy,
      modelsDiscovered,
      errorCount: errors.length,
      errors,
    },
    {}
  );

  return {
    bootstrapped: true,
    models: modelsSeeded,
    strategies: strategiesSeeded,
    opportunities: opportunitiesCount,
    discoveryRan,
    discoveryNew,
    providersConfigured,
    providersHealthy,
    modelsDiscovered,
    errors,
  };
}
