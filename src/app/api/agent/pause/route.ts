// POST /api/agent/pause
//
// Engages the soft-pause kill switch. In-flight cycles finish but no new
// cycles start. Body: `{ reason?: string }`.
//
// Returns the updated AgentState + kill switch snapshot.

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { getState } from "@/lib/agent/state";
import { setPaused } from "@/lib/kill-switch";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    await bootstrapAgent();

    let reason: string | undefined;
    try {
      const body = await req.json();
      if (body && typeof body.reason === "string") {
        reason = body.reason.trim() || undefined;
      }
    } catch {
      // Body was missing or invalid JSON — that's fine, pause with no reason.
    }

    const snapshot = await setPaused(true, reason);
    const state = await getState();

    return NextResponse.json(
      { state, killSwitch: snapshot },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/agent/pause] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
