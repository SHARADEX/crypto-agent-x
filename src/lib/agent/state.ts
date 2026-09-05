// Persisted agent runtime state (spec §26, §28).
//
// The agent's global state lives in a singleton `AgentState` row keyed by
// `id = "singleton"`. This module wraps reads/writes against that row and
// exposes a small in-memory cache so hot-path callers (orchestrator loop,
// kill switch, dashboard) don't pay a DB round-trip on every check.
//
// The cache is intentionally simple: a single mutable object that is updated
// whenever the DB row is changed through this module. For multi-process
// deployments the kill-switch module also reads `PAUSE` / `STOP` files and
// the `PAUSE_AGENT` env var so a human operator can halt all workers without
// touching the database.

import { db } from "@/lib/db";
import type {
  AgentRuntimeState,
  AutonomyMode,
} from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SINGLETON_ID = "singleton";

const DEFAULT_STATE: AgentRuntimeState = {
  running: false,
  paused: false,
  emergencyStop: false,
  autonomyMode: "observe",
  lastCycleAt: null,
  lastCycleResult: null,
  cycleCount: 0,
};

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let cachedState: AgentRuntimeState | null = null;
let cacheFetchedAt = 0;

/**
 * Reset the in-memory cache. Exposed primarily for tests and for callers that
 * want to force the next read to hit the database.
 */
export function invalidateStateCache(): void {
  cachedState = null;
  cacheFetchedAt = 0;
}

/**
 * Read the singleton `AgentState` row. Creates it with defaults if missing.
 */
export async function getState(): Promise<AgentRuntimeState> {
  // Serve from cache if fresh (< 2s old).
  if (cachedState && Date.now() - cacheFetchedAt < 2000) {
    return cachedState;
  }

  try {
    const row = await db.agentState.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID },
      update: {},
    });
    cachedState = rowToState(row);
    cacheFetchedAt = Date.now();
    return cachedState;
  } catch (err) {
    console.error("[state] failed to read AgentState singleton:", err);
    // Fallback to a safe default so callers can continue (degraded).
    return { ...DEFAULT_STATE };
  }
}

/**
 * Synchronously return the cached state. If the cache is empty, returns the
 * safe default. Use {@link getState} for a fresh authoritative read.
 */
export function getCachedState(): AgentRuntimeState {
  return cachedState ?? { ...DEFAULT_STATE };
}

/**
 * Patch the singleton state with a partial update. Updates the cache and
 * returns the new state.
 */
export async function setState(
  patch: Partial<Omit<AgentRuntimeState, "cycleCount">> & {
    cycleCount?: number;
  }
): Promise<AgentRuntimeState> {
  try {
    const data: Record<string, unknown> = {};
    if (patch.running !== undefined) data.running = patch.running;
    if (patch.paused !== undefined) data.paused = patch.paused;
    if (patch.emergencyStop !== undefined)
      data.emergencyStop = patch.emergencyStop;
    if (patch.autonomyMode !== undefined)
      data.autonomyMode = patch.autonomyMode;
    if (patch.lastCycleAt !== undefined)
      data.lastCycleAt = patch.lastCycleAt ? new Date(patch.lastCycleAt) : null;
    if (patch.lastCycleResult !== undefined)
      data.lastCycleResult = patch.lastCycleResult;
    if (patch.cycleCount !== undefined) data.cycleCount = patch.cycleCount;

    const row = await db.agentState.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...(data as any) },
      update: data as any,
    });
    cachedState = rowToState(row);
    cacheFetchedAt = Date.now();
    return cachedState;
  } catch (err) {
    console.error("[state] failed to patch AgentState:", err);
    // Best-effort local update so the cache stays usable for the rest of
    // this process lifetime.
    cachedState = { ...getCachedState(), ...patch } as AgentRuntimeState;
    cacheFetchedAt = Date.now();
    return cachedState;
  }
}

/**
 * Switch the agent's autonomy mode (spec §11): observe → assist → semi → full.
 */
export async function setAutonomyMode(
  mode: AutonomyMode
): Promise<AgentRuntimeState> {
  return setState({ autonomyMode: mode });
}

/**
 * Record the result of a completed orchestrator cycle. Increments the cycle
 * counter, stores the latest result string, and stamps `lastCycleAt`.
 */
export async function markCycle(
  result: string
): Promise<AgentRuntimeState> {
  try {
    const row = await db.agentState.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        cycleCount: 1,
        lastCycleAt: new Date(),
        lastCycleResult: result,
      },
      update: {
        cycleCount: { increment: 1 },
        lastCycleAt: new Date(),
        lastCycleResult: result,
      },
    });
    cachedState = rowToState(row);
    cacheFetchedAt = Date.now();
    return cachedState;
  } catch (err) {
    console.error("[state] markCycle failed:", err);
    const next = getCachedState();
    next.cycleCount += 1;
    next.lastCycleAt = new Date().toISOString();
    next.lastCycleResult = result;
    cachedState = next;
    cacheFetchedAt = Date.now();
    return next;
  }
}

export interface CanRunResult {
  canRun: boolean;
  reason: string;
}

/**
 * Combine pause + emergencyStop + running into a single decision: can the
 * orchestrator loop fire a new cycle right now?
 *
 * This function only inspects persistent state — for the full kill-switch
 * picture (filesystem + env) use {@link "@/lib/kill-switch" assertRunning}.
 */
export async function canRun(): Promise<CanRunResult> {
  const s = await getState();
  if (s.emergencyStop) {
    return {
      canRun: false,
      reason: "Emergency stop is engaged — all execution halted.",
    };
  }
  if (s.paused) {
    return { canRun: false, reason: "Agent is paused." };
  }
  if (!s.running) {
    return {
      canRun: false,
      reason: "Agent is not running (start it from the dashboard).",
    };
  }
  return { canRun: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToState(row: {
  running: boolean;
  paused: boolean;
  emergencyStop: boolean;
  autonomyMode: string;
  lastCycleAt: Date | null;
  lastCycleResult: string | null;
  cycleCount: number;
}): AgentRuntimeState {
  return {
    running: row.running,
    paused: row.paused,
    emergencyStop: row.emergencyStop,
    autonomyMode: row.autonomyMode as AutonomyMode,
    lastCycleAt: row.lastCycleAt ? row.lastCycleAt.toISOString() : null,
    lastCycleResult: row.lastCycleResult,
    cycleCount: row.cycleCount,
  };
}
