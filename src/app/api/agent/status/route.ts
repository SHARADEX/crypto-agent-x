// GET /api/agent/status
//
// Returns the agent's runtime state plus everything the dashboard needs to
// render the top-level control panel in a single round-trip:
//   - agentState (running, paused, emergencyStop, autonomyMode, lastCycleAt, ...)
//   - canRun verdict (so the dashboard can disable the Start button cleanly)
//   - budget report (daily / hourly usage vs limits)
//   - kill switch snapshot (paused / emergencyStop + reason)
//   - wallet summary (total USD + fetchedAt) — best-effort
//
// The route always calls `bootstrapAgent()` first so the very first request
// against a cold DB populates the model registry, strategy stats, and an
// initial discovery pass before the dashboard reads anything. The bootstrap
// is guarded by a module-level flag so it's a no-op on subsequent calls.

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { canRun, getState } from "@/lib/agent/state";
import {
  getKillSwitchSnapshot,
  refreshKillSwitchState,
} from "@/lib/kill-switch";
import { BudgetManager } from "@/lib/budget/manager";
import { getWalletSummary } from "@/lib/wallet/monitor";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await bootstrapAgent();

    const [state, canRunResult, budget, walletSummary] = await Promise.all([
      getState(),
      canRun(),
      BudgetManager.getInstance().getReport(),
      getWalletSummary().catch(() => null),
    ]);

    // refreshKillSwitchState hits the filesystem + DB; call it AFTER reading
    // the cached snapshot so the returned snapshot reflects the latest state.
    await refreshKillSwitchState();
    const killSwitch = getKillSwitchSnapshot();

    return NextResponse.json(
      {
        ...state,
        canRun: canRunResult,
        budget,
        killSwitch: {
          paused: killSwitch.paused,
          emergencyStop: killSwitch.emergencyStop,
          reason: killSwitch.reason,
          fetchedAt: killSwitch.fetchedAt,
        },
        walletSummary: walletSummary
          ? {
              totalUsd: walletSummary.totalUsd,
              fetchedAt: walletSummary.fetchedAt,
            }
          : undefined,
      },
      {
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (err) {
    console.error("[api/agent/status] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
