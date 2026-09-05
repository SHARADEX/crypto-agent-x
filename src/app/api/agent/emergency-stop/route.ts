// POST /api/agent/emergency-stop
//
// Engages the hard-stop kill switch. In-flight tasks SHOULD abort as soon as
// possible (spec §26). Body: `{ reason?: string }`.
//
// Returns the updated AgentState + kill switch snapshot.

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { getState } from "@/lib/agent/state";
import { setEmergencyStop } from "@/lib/kill-switch";

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
      // Body was missing or invalid JSON — that's fine.
    }

    const snapshot = await setEmergencyStop(true, reason);
    const state = await getState();

    return NextResponse.json(
      { state, killSwitch: snapshot },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/agent/emergency-stop] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
