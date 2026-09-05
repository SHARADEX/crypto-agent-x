// POST /api/agent/autonomy
//
// Switch the agent's autonomy mode (spec §11):
//   - observe   : discover + verify only; no execution
//   - assist    : low-risk execution (level 1) auto-allowed
//   - semi      : moderate-risk (level 2) auto-allowed; level 3 still gated
//   - full      : everything except level-3 financial actions
//
// Body: `{ mode: "observe"|"assist"|"semi"|"full" }`.
// Returns the updated AgentState.

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { setAutonomyMode } from "@/lib/agent/state";
import type { AutonomyMode } from "@/lib/agent/types";

export const dynamic = "force-dynamic";

const VALID_MODES: ReadonlySet<AutonomyMode> = new Set([
  "observe",
  "assist",
  "semi",
  "full",
]);

export async function POST(req: Request) {
  try {
    await bootstrapAgent();

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const mode = (body as { mode?: unknown } | null)?.mode;
    if (typeof mode !== "string" || !VALID_MODES.has(mode as AutonomyMode)) {
      return NextResponse.json(
        {
          error:
            "Invalid mode. Must be one of: observe | assist | semi | full.",
        },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const state = await setAutonomyMode(mode as AutonomyMode);
    return NextResponse.json(
      { state },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/agent/autonomy] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
