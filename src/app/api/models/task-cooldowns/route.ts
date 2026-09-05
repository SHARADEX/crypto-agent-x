// GET  /api/models/task-cooldowns — list active per-(model, taskType) cooldowns.
// POST /api/models/task-cooldowns — clear all cooldowns (operator override).
// Phase-2 P2-8.

import { NextResponse } from "next/server";
import {
  getActiveCooldowns,
  clearAllTaskCooldowns,
} from "@/lib/llm/task-cooldown";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await bootstrapAgent();
    const cooldowns = await getActiveCooldowns();
    return NextResponse.json(
      { cooldowns, count: cooldowns.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function POST() {
  try {
    await bootstrapAgent();
    const result = await clearAllTaskCooldowns();
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
