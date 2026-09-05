// Provider-level health + status registry (Phase-2 P2-1, P2-7).
//
// Distinct from the per-model `CircuitBreaker` — this tracks the
// provider-level health (whether credentials work, whether the rate limit is
// exhausted, etc.). The router consults this when selecting a model so it can
// prefer providers that aren't rate-limited or in cooldown.
//
// In-memory only — a process restart re-runs `bootstrapProviders()` and
// re-populates this from fresh health checks. (The per-model circuit breaker
// remains authoritative for "is this specific model on this specific provider
// healthy right now?")

import type { ProviderStatus } from "@/lib/llm/providers/types";

// ---------------------------------------------------------------------------
// Status map
// ---------------------------------------------------------------------------

const statuses = new Map<string, ProviderStatus>();

class ProviderRegistry {
  /**
   * Get the last-known status for a provider. Returns `undefined` when no
   * health check has been run yet (the router treats this as "unknown /
   * assume healthy" — a real call will quickly discover if it's not).
   */
  getStatus(name: string): ProviderStatus | undefined {
    return statuses.get(name);
  }

  /** Update the status for a provider. */
  setStatus(name: string, status: ProviderStatus): void {
    statuses.set(name, status);
  }

  /** Returns true if the provider is currently usable (healthy or degraded). */
  isUsable(name: string): boolean {
    const s = statuses.get(name);
    return s === undefined || s === "healthy" || s === "degraded";
  }

  /** Returns true if the provider should be excluded from routing. */
  isExcluded(name: string): boolean {
    const s = statuses.get(name);
    if (s === undefined) return false;
    return (
      s === "unhealthy" ||
      s === "blacklisted" ||
      s === "not_configured" ||
      s === "invalid_credentials" ||
      s === "quota_exhausted"
    );
  }

  /** Snapshot for the dashboard. */
  snapshot(): Record<string, ProviderStatus> {
    return Object.fromEntries(statuses.entries());
  }

  /** Test-only: clear all statuses. */
  resetForTests(): void {
    statuses.clear();
  }
}

export const providerRegistry = new ProviderRegistry();

// ---------------------------------------------------------------------------
// Lookups that proxy to the providers index — kept here to avoid a circular
// import between providers/index.ts (which calls setStatus) and any caller
// that needs the lookup helpers.
// ---------------------------------------------------------------------------

export function getProviderStatus(name: string): ProviderStatus | undefined {
  return providerRegistry.getStatus(name);
}

export function updateProviderStatus(
  name: string,
  status: ProviderStatus
): void {
  providerRegistry.setStatus(name, status);
}

export function getHealthyProviderNames(): string[] {
  const out: string[] = [];
  const snapshot = providerRegistry.snapshot();
  for (const name of Object.keys(snapshot)) {
    if (snapshot[name] === "healthy") out.push(name);
  }
  return out;
}
