// POST /api/agent/emergency-reset
//
// Clears BOTH the emergency-stop AND the soft-pause flags. Use this when the
// operator has resolved whatever triggered the emergency stop and wants to
// resume normal operation. (Spec §26 — emergency-stop cannot be cleared
// without also clearing pause, otherwise the agent would be stuck "paused".)
//
// Returns the updated AgentState + kill switch snapshot.

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { getState } from "@/lib/agent/state";
import { setEmergencyStop, setPaused } from "@/lib/kill-switch";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await bootstrapAgent();

    await setEmergencyStop(false, "operator reset");
    const snapshot = await setPaused(false, "operator reset");
    const state = await getState();

    return NextResponse.json(
      { state, killSwitch: snapshot },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/agent/emergency-reset] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
