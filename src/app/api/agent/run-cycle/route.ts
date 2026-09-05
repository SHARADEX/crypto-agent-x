// POST /api/agent/run-cycle
//
// Run one or more autonomous cycles synchronously and return the summaries.
// Always calls `bootstrapAgent()` first so a cold DB gets seeded before the
// first cycle starts.
//
// Body: `{ cycles?: number (default 1), delayMs?: number (default 1000) }`.
//
// Returns an array of CycleSummary objects (one per cycle executed).

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { runCycles } from "@/lib/orchestrator/loop";

export const dynamic = "force-dynamic";

const MAX_CYCLES = 20;
const MAX_DELAY_MS = 60_000;

export async function POST(req: Request) {
  try {
    await bootstrapAgent();

    let cycles = 1;
    let delayMs = 1000;

    try {
      const body = await req.json();
      if (body && typeof body === "object") {
        const c = (body as { cycles?: unknown }).cycles;
        if (typeof c === "number" && Number.isFinite(c)) {
          cycles = Math.max(1, Math.min(Math.trunc(c), MAX_CYCLES));
        }
        const d = (body as { delayMs?: unknown }).delayMs;
        if (typeof d === "number" && Number.isFinite(d) && d >= 0) {
          delayMs = Math.min(Math.trunc(d), MAX_DELAY_MS);
        }
      }
    } catch {
      // Invalid body — fall back to defaults.
    }

    const summaries = await runCycles(cycles, { delayMs });

    return NextResponse.json(
      { cycles: summaries, count: summaries.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/agent/run-cycle] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
