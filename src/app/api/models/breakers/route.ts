// GET  /api/models/breakers — list persisted circuit-breaker states.
// POST /api/models/breakers — reset all breakers (operator override).
// Phase-2 P2-2.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCircuitBreaker } from "@/lib/llm/circuit-breaker";
import { setModelStatus } from "@/lib/llm/registry";
import { logEvent } from "@/lib/agent/events";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await bootstrapAgent();
    const rows = await db.breakerState.findMany({
      orderBy: { updatedAt: "desc" },
    });
    const live = getCircuitBreaker().snapshot();
    return NextResponse.json(
      {
        persisted: rows.map((r) => ({
          modelId: r.modelId,
          status: r.status,
          failureCount: r.failureCount,
          blacklistUntil: r.blacklistUntil,
          lastFailureAt: r.lastFailureAt,
          lastSuccessAt: r.lastSuccessAt,
          updatedAt: r.updatedAt,
        })),
        live,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function POST(req: Request) {
  try {
    await bootstrapAgent();
    const body = (await req.json().catch(() => ({}))) as {
      modelId?: string;
      action?: "reset" | "clear-all";
    };

    if (body.action === "clear-all" || (!body.modelId && !body.action)) {
      // Clear all persisted breaker state + reset the in-memory map.
      const result = await getCircuitBreaker().clearAllPersisted();
      // Also flip every ModelRecord that was blacklisted/unhealthy back to healthy.
      const flipped = await db.modelRecord.updateMany({
        where: {
          OR: [
            { status: "blacklisted" },
            { status: "unhealthy" },
            { status: "degraded" },
          ],
        },
        data: { status: "healthy" },
      });
      await logEvent(
        "model_router",
        "info",
        "breakers_reset_all",
        { cleared: result.cleared, modelsFlipped: flipped.count },
        {}
      );
      return NextResponse.json(
        { cleared: result.cleared, modelsFlipped: flipped.count },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    if (body.modelId) {
      // Reset a single model.
      getCircuitBreaker().reset(body.modelId);
      await db.breakerState.deleteMany({ where: { modelId: body.modelId } });
      await setModelStatus(body.modelId, "healthy");
      await logEvent(
        "model_router",
        "info",
        "breaker_reset",
        { modelId: body.modelId },
        {}
      );
      return NextResponse.json(
        { modelId: body.modelId, status: "healthy" },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      { error: "expected { modelId } or { action: 'clear-all' }" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
