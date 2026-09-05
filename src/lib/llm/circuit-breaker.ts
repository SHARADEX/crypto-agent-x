// In-memory circuit breaker for LLM models (spec §4N, §4P).
//
// The breaker trips when a model fails repeatedly within a short window:
//
//   - 3 failures in 60s  → "degraded"   (still routable, but other models
//                                         get routing preference)
//   - 5 failures in 60s  → "unhealthy"  (router avoids; only used if no
//                                         alternative is available)
//   - 10 failures in 60s → "blacklisted" for 10 minutes (hard block — even
//                                         a healthy upstream can't recover
//                                         fast enough to be useful right now)
//
// All state lives in an in-memory Map (per-process). State transitions are
// mirrored to the DB via `setModelStatus` so the dashboard sees them too.
// A successful call resets the failure window for that model — this is the
// classic "half-open" recovery: once the upstream is responsive again, the
// breaker clears on its own.
//
// The breaker is deliberately conservative: free-tier providers routinely
// return 429 / 500 / timeouts under load, and we want the router to keep
// working in those cases without burning a hard blacklist on every blip.

import { setModelStatus } from "@/lib/llm/registry";
import { db } from "@/lib/db";
import type { ModelStatus } from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// Thresholds (spec §4N, §4P)
// ---------------------------------------------------------------------------

/** Failures within this window trigger a state change. */
const WINDOW_MS = 60_000;

/** After this many failures in the window → degraded. */
const THRESHOLD_DEGRADED = 3;

/** After this many failures in the window → unhealthy. */
const THRESHOLD_UNHEALTHY = 5;

/** After this many failures in the window → blacklisted. */
const THRESHOLD_BLACKLIST = 10;

/** How long a blacklisted model stays blocked before the breaker half-opens. */
const BLACKLIST_DURATION_MS = 10 * 60_000; // 10 minutes

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface BreakerEntry {
  /** Epoch-ms timestamps of recent failures, oldest first. */
  failures: number[];
  /** Current breaker state. Cached so callers don't have to re-derive it. */
  status: ModelStatus;
  /** When the current blacklist period ends (epoch-ms). 0 = not blacklisted. */
  blacklistUntil: number;
  /** Set on the first success after a degraded/unhealthy period so we can
   *  flip back to healthy and clear the failure window. */
  lastTransitionAt: number;
}

class CircuitBreaker {
  private entries = new Map<string, BreakerEntry>();

  // ----------------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------------

  /**
   * Record a successful call. Clears the failure window and flips the model
   * back to "healthy" if it was degraded or unhealthy. Has no effect on a
   * blacklisted model until the blacklist window has expired (the next
   * `isAvailable` call will half-open it).
   */
  recordSuccess(modelId: string): void {
    const entry = this.entries.get(modelId);
    if (!entry) return;

    entry.failures = [];
    if (entry.status !== "healthy") {
      // Only flip out of degraded/unhealthy on success — blacklisted models
      // stay blacklisted until the window expires (handled in isAvailable).
      if (entry.status !== "blacklisted") {
        this.transition(modelId, entry, "healthy");
      }
    }
  }

  /**
   * Record a failed call. Bumps the failure counter (within the rolling
   * window) and triggers state transitions when thresholds are crossed.
   */
  recordFailure(modelId: string): void {
    const now = Date.now();
    let entry = this.entries.get(modelId);
    if (!entry) {
      entry = {
        failures: [],
        status: "healthy",
        blacklistUntil: 0,
        lastTransitionAt: now,
      };
      this.entries.set(modelId, entry);
    }

    // Drop failures outside the rolling window.
    entry.failures = entry.failures.filter((t) => now - t < WINDOW_MS);
    entry.failures.push(now);

    const count = entry.failures.length;

    // Threshold escalation — only escalate, never downgrade here. Downgrades
    // happen on `recordSuccess` or when a blacklist window expires.
    if (count >= THRESHOLD_BLACKLIST) {
      if (entry.status !== "blacklisted") {
        entry.blacklistUntil = now + BLACKLIST_DURATION_MS;
        this.transition(modelId, entry, "blacklisted");
      } else {
        // Already blacklisted — extend the window so a continued flood of
        // failures keeps the model blocked.
        entry.blacklistUntil = now + BLACKLIST_DURATION_MS;
      }
    } else if (count >= THRESHOLD_UNHEALTHY) {
      if (entry.status !== "unhealthy" && entry.status !== "blacklisted") {
        this.transition(modelId, entry, "unhealthy");
      }
    } else if (count >= THRESHOLD_DEGRADED) {
      if (entry.status === "healthy") {
        this.transition(modelId, entry, "degraded");
      }
    }
  }

  /**
   * Get the current breaker status for a model. If a blacklist window has
   * expired, the model is half-opened (returned as "degraded" so the router
   * still prefers alternatives but will use it if necessary).
   */
  getStatus(modelId: string): ModelStatus {
    const entry = this.entries.get(modelId);
    if (!entry) return "healthy";

    // Expire blacklist?
    if (entry.status === "blacklisted" && Date.now() >= entry.blacklistUntil) {
      // Half-open: drop the failure window and return degraded so the router
      // tries the model again. If the next call succeeds, `recordSuccess`
      // flips it fully back to healthy; if it fails, the breaker re-trips.
      entry.status = "degraded";
      entry.failures = [];
      entry.blacklistUntil = 0;
      entry.lastTransitionAt = Date.now();
      // Mirror to DB (fire-and-forget).
      void setModelStatus(modelId, "degraded");
    }

    return entry.status;
  }

  /**
   * Is the model currently routable? `blacklisted` models are not routable
   * until their blacklist window expires (then they're half-open as
   * "degraded"). All other statuses are routable.
   */
  isAvailable(modelId: string): boolean {
    const status = this.getStatus(modelId);
    return status !== "blacklisted";
  }

  /**
   * Force-clear the breaker for a model (e.g. operator override from the
   * dashboard). Mirrors the new "healthy" status to the DB.
   */
  reset(modelId: string): void {
    const entry = this.entries.get(modelId);
    if (!entry) return;
    entry.failures = [];
    entry.blacklistUntil = 0;
    if (entry.status !== "healthy") {
      this.transition(modelId, entry, "healthy");
    }
  }

  /**
   * Snapshot for the dashboard / debugging. Returns the raw breaker entries.
   */
  snapshot(): Array<{
    modelId: string;
    status: ModelStatus;
    failures: number;
    blacklistUntil: number;
  }> {
    const out: Array<{
      modelId: string;
      status: ModelStatus;
      failures: number;
      blacklistUntil: number;
    }> = [];
    for (const [modelId, entry] of this.entries) {
      out.push({
        modelId,
        status: this.getStatus(modelId),
        failures: entry.failures.length,
        blacklistUntil: entry.blacklistUntil,
      });
    }
    return out;
  }

  // ----------------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------------

  private transition(
    modelId: string,
    entry: BreakerEntry,
    newStatus: ModelStatus
  ): void {
    if (entry.status === newStatus) return;
    const old = entry.status;
    entry.status = newStatus;
    entry.lastTransitionAt = Date.now();
    console.warn(
      `[circuit-breaker] ${modelId}: ${old} → ${newStatus} (${entry.failures.length} recent failures)`
    );
    // Mirror to ModelRecord (existing — used by the router + dashboard).
    void setModelStatus(modelId, newStatus).catch((err) => {
      console.error(
        `[circuit-breaker] failed to mirror ${modelId} → ${newStatus} to ModelRecord:`,
        err
      );
    });
    // Phase-2 P2-2 — also persist to the BreakerState table so a process
    // restart preserves the blacklisted state. Fire-and-forget; the in-memory
    // state is still authoritative for routing decisions within a process.
    void this.persistBreakerState(modelId, entry, newStatus).catch((err) => {
      console.error(
        `[circuit-breaker] failed to persist ${modelId} → ${newStatus} to BreakerState:`,
        err
      );
    });
  }

  /**
   * Persist the current breaker state to the `BreakerState` table (Phase-2 P2-2).
   * Called on every state transition so a process restart can hydrate.
   */
  private async persistBreakerState(
    modelId: string,
    entry: BreakerEntry,
    status: ModelStatus
  ): Promise<void> {
    const blacklistUntil =
      entry.blacklistUntil > 0 ? new Date(entry.blacklistUntil) : null;
    const lastFailureAt =
      entry.failures.length > 0
        ? new Date(entry.failures[entry.failures.length - 1])
        : null;
    const lastSuccessAt =
      status === "healthy" ? new Date() : null;

    await db.breakerState.upsert({
      where: { modelId },
      create: {
        modelId,
        status,
        failureCount: entry.failures.length,
        blacklistUntil,
        lastFailureAt,
        lastSuccessAt,
      },
      update: {
        status,
        failureCount: entry.failures.length,
        blacklistUntil,
        lastFailureAt,
        lastSuccessAt,
      },
    });
  }

  /**
   * Hydrate the in-memory breaker state from the `BreakerState` table.
   * Called once at process startup (from `bootstrapAgent()`). Only restores
   * `blacklisted` + `unhealthy` states — `degraded` is considered too
   * transient to survive a restart (the rolling 60s window is likely stale
   * by the time the new process boots).
   *
   * Phase-2 P2-2 — closed.
   */
  async hydrateFromDb(): Promise<{ restored: number; details: string[] }> {
    try {
      const rows = await db.breakerState.findMany({
        where: {
          OR: [{ status: "blacklisted" }, { status: "unhealthy" }],
        },
      });
      const details: string[] = [];
      const now = Date.now();
      for (const row of rows) {
        // Skip blacklisted entries whose window has already expired.
        if (
          row.status === "blacklisted" &&
          row.blacklistUntil &&
          row.blacklistUntil.getTime() <= now
        ) {
          continue;
        }
        const entry: BreakerEntry = {
          failures: [],
          status: row.status as ModelStatus,
          blacklistUntil: row.blacklistUntil
            ? row.blacklistUntil.getTime()
            : 0,
          lastTransitionAt: row.updatedAt?.getTime() ?? now,
        };
        this.entries.set(row.modelId, entry);
        details.push(`${row.modelId}=${row.status}`);
      }
      if (details.length > 0) {
        console.warn(
          `[circuit-breaker] hydrated ${details.length} persisted states: ${details.join(", ")}`
        );
      }
      return { restored: details.length, details };
    } catch (err) {
      console.error("[circuit-breaker] hydrateFromDb failed:", err);
      return { restored: 0, details: [] };
    }
  }

  /**
   * Clear all persisted breaker state (used by the dashboard's "reset all
   * breakers" button). Wipes the BreakerState table + the in-memory map.
   */
  async clearAllPersisted(): Promise<{ cleared: number }> {
    try {
      const result = await db.breakerState.deleteMany({});
      this.entries.clear();
      return { cleared: result.count };
    } catch (err) {
      console.error("[circuit-breaker] clearAllPersisted failed:", err);
      return { cleared: 0 };
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

let _instance: CircuitBreaker | null = null;

/** Get the process-wide singleton circuit breaker. */
export function getCircuitBreaker(): CircuitBreaker {
  if (!_instance) _instance = new CircuitBreaker();
  return _instance;
}

/** Test-only helper — wipes the singleton so a fresh breaker is created. */
export function _resetCircuitBreakerForTests(): void {
  _instance = null;
}

// Re-export thresholds for callers / tests.
export const BREAKER_THRESHOLDS = {
  WINDOW_MS,
  THRESHOLD_DEGRADED,
  THRESHOLD_UNHEALTHY,
  THRESHOLD_BLACKLIST,
  BLACKLIST_DURATION_MS,
} as const;
