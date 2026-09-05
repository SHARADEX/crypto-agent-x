// POST /api/agent/resume
//
// Clears the soft-pause flag. The agent will resume running cycles on its
// next scheduled tick. Returns the updated AgentState + kill switch snapshot.

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { getState } from "@/lib/agent/state";
import { setPaused } from "@/lib/kill-switch";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await bootstrapAgent();

    const snapshot = await setPaused(false);
    const state = await getState();

    return NextResponse.json(
      { state, killSwitch: snapshot },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/agent/resume] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
