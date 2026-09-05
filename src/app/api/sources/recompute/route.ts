// POST /api/sources/recompute — recompute SourceReputation.reliability from
// raw counters (Phase-2 P2-3).
//
// Body: { source?: string }  // omit to recompute ALL sources
// Returns: { recomputed: number, results: [{ source, reliability }] }

import { NextResponse } from "next/server";
import {
  recomputeSourceReliability,
  recomputeAllSourceReliability,
} from "@/lib/agent/sources";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    await bootstrapAgent();
    const body = (await req.json().catch(() => ({}))) as { source?: string };

    if (body.source) {
      const reliability = await recomputeSourceReliability(body.source);
      return NextResponse.json(
        { recomputed: 1, results: [{ source: body.source, reliability }] },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const result = await recomputeAllSourceReliability();
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
