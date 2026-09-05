// Kill switch for the autonomous agent (spec §26, §28).
//
// Three independent signals can halt the agent:
//
//   1. Persistent DB flags on the `AgentState` singleton (`paused`,
//      `emergencyStop`) — set from the dashboard UI or via API.
//   2. Filesystem markers `./PAUSE` and `./STOP` at the project root —
//      lets an operator halt all workers instantly without DB access.
//   3. Environment variable `PAUSE_AGENT=true` — useful for CI / startup
//      gating.
//
// All three signals are OR-ed together: if ANY of them is truthy, the
// corresponding flag is considered true. The filesystem and env signals are
// checked on every refresh (cheap `fs.existsSync` + `process.env` read).
//
// The module exposes:
//   - SYNC wrappers (`isPaused`, `isEmergencyStop`, `assertRunning`) that
//     read the in-memory cache. These are safe to call from hot loops.
//   - ASYNC refresh / mutation helpers that write through to the DB and log
//     every state change via `logEvent`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db";
import {
  SINGLETON_ID,
  getCachedState,
  invalidateStateCache,
} from "@/lib/agent/state";
import { logEvent } from "@/lib/agent/events";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROJECT_ROOT =
  process.env.PROJECT_ROOT ?? process.cwd();

/** Filesystem marker paths (spec §26). */
export const PAUSE_FILE = join(PROJECT_ROOT, "PAUSE");
export const STOP_FILE = join(PROJECT_ROOT, "STOP");

const PAUSE_ENV_FLAG = "PAUSE_AGENT";

// ---------------------------------------------------------------------------
// Cached flags (refreshed by `refreshKillSwitchState`)
// ---------------------------------------------------------------------------

interface KillSwitchSnapshot {
  paused: boolean;
  emergencyStop: boolean;
  reason: string | null;
  fetchedAt: number;
}

let snapshot: KillSwitchSnapshot = {
  paused: false,
  emergencyStop: false,
  reason: null,
  fetchedAt: 0,
};

// ---------------------------------------------------------------------------
// Sync wrappers (read cache)
// ---------------------------------------------------------------------------

/**
 * True when the agent is in soft-pause mode: in-flight cycles finish but no
 * new cycles start. Triggered by DB flag, `./PAUSE` file, or `PAUSE_AGENT`
 * env var.
 */
export function isPaused(): boolean {
  return snapshot.paused;
}

/**
 * True when the agent is hard-stopped: in-flight tasks MUST abort as soon as
 * possible. Triggered by DB flag or `./STOP` file.
 */
export function isEmergencyStop(): boolean {
  return snapshot.emergencyStop;
}

/**
 * Returns the human-readable reason for the current snapshot (if any).
 */
export function getKillSwitchReason(): string | null {
  return snapshot.reason;
}

/**
 * Throws a `KillSwitchError` if the agent is paused or emergency-stopped.
 * Call this at the top of any orchestrator cycle / external action.
 */
export function assertRunning(): void {
  if (snapshot.emergencyStop) {
    throw new KillSwitchError(
      "emergency_stop",
      snapshot.reason ?? "Emergency stop is engaged."
    );
  }
  if (snapshot.paused) {
    throw new KillSwitchError(
      "paused",
      snapshot.reason ?? "Agent is paused."
    );
  }
}

export class KillSwitchError extends Error {
  readonly kind: "paused" | "emergency_stop";
  constructor(kind: "paused" | "emergency_stop", message: string) {
    super(message);
    this.name = "KillSwitchError";
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Async refresh + mutation
// ---------------------------------------------------------------------------

/**
 * Re-read the persistent DB state, the filesystem markers, and the env var.
 * Updates the in-memory cache. Returns the fresh snapshot.
 *
 * Should be called at the start of every orchestrator cycle (or on a short
 * interval) so external signals take effect quickly.
 */
export async function refreshKillSwitchState(): Promise<KillSwitchSnapshot> {
  let dbPaused = false;
  let dbEmergencyStop = false;
  let dbAutonomyMode = "observe";

  try {
    const row = await db.agentState.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID },
      update: {},
    });
    dbPaused = row.paused;
    dbEmergencyStop = row.emergencyStop;
    dbAutonomyMode = row.autonomyMode;
  } catch (err) {
    console.error("[kill-switch] failed to read AgentState singleton:", err);
    // Fall back to the previous snapshot's DB flags so a transient DB outage
    // doesn't accidentally grant the agent permission to run.
    dbPaused = snapshot.paused && !snapshot.reason?.startsWith("file:");
    dbEmergencyStop = snapshot.emergencyStop && !snapshot.reason?.startsWith("file:");
  }

  // Filesystem signals (cheap, synchronous).
  const filePause = safeExists(PAUSE_FILE);
  const fileStop = safeExists(STOP_FILE);

  // Env signal (also cheap).
  const envPause =
    (process.env[PAUSE_ENV_FLAG] ?? "").toLowerCase() === "true";

  const reasons: string[] = [];
  if (dbPaused) reasons.push("db:paused");
  if (dbEmergencyStop) reasons.push("db:emergencyStop");
  if (filePause) reasons.push(`file:${PAUSE_FILE}`);
  if (fileStop) reasons.push(`file:${STOP_FILE}`);
  if (envPause) reasons.push(`env:${PAUSE_ENV_FLAG}=true`);

  snapshot = {
    paused: dbPaused || filePause || envPause,
    emergencyStop: dbEmergencyStop || fileStop,
    reason: reasons.length > 0 ? reasons.join(" | ") : null,
    fetchedAt: Date.now(),
  };

  // Keep the state module's cache in sync so other consumers see the same
  // paused / emergencyStop flags.
  invalidateStateCache();

  return snapshot;
}

/**
 * Set the soft-pause flag in the database and refresh the cache.
 * Logs the transition via `logEvent`.
 */
export async function setPaused(
  paused: boolean,
  reason?: string
): Promise<KillSwitchSnapshot> {
  try {
    await db.agentState.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, paused },
      update: { paused },
    });
  } catch (err) {
    console.error("[kill-switch] setPaused DB write failed:", err);
  }

  await logEvent(
    "orchestrator",
    paused ? "warn" : "info",
    paused ? "kill_switch.paused" : "kill_switch.resumed",
    {
      reason: reason ?? null,
      source: "setPaused",
    }
  );

  return refreshKillSwitchState();
}

/**
 * Set the hard-stop (emergency) flag in the database and refresh the cache.
 * Logs the transition as a `critical` event.
 */
export async function setEmergencyStop(
  emergencyStop: boolean,
  reason?: string
): Promise<KillSwitchSnapshot> {
  try {
    await db.agentState.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, emergencyStop },
      update: { emergencyStop },
    });
  } catch (err) {
    console.error("[kill-switch] setEmergencyStop DB write failed:", err);
  }

  await logEvent(
    "orchestrator",
    emergencyStop ? "critical" : "warn",
    emergencyStop ? "kill_switch.emergency_stop" : "kill_switch.emergency_cleared",
    {
      reason: reason ?? null,
      source: "setEmergencyStop",
    }
  );

  return refreshKillSwitchState();
}

/**
 * Convenience helper for the dashboard / API: returns the full snapshot
 * WITHOUT touching the DB. Useful for SSE / polling endpoints that already
 * refresh on a timer elsewhere.
 */
export function getKillSwitchSnapshot(): KillSwitchSnapshot {
  return snapshot;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

// Re-export the cached-state helper so callers can grab the unified
// AgentRuntimeState without reaching into the state module directly.
export { getCachedState };
