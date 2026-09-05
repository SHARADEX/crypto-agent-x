// GET  /api/memory — list memories (with filters)
// POST /api/memory — record a new memory (or bump an existing one)
// Phase-2 P3-2.

import { NextResponse } from "next/server";
import {
  getAllMemories,
  getMemorySummary,
  recordMemory,
  retrieveMemories,
  type MemoryCategory,
} from "@/lib/memory/agent-memory";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await bootstrapAgent();
    const url = new URL(req.url);
    const category = url.searchParams.get("category") as MemoryCategory | null;
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const summary = url.searchParams.get("summary") === "true";

    if (summary) {
      const s = await getMemorySummary();
      return NextResponse.json(s, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    const result = await getAllMemories({
      category: category ?? undefined,
      limit,
    });
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

export async function POST(req: Request) {
  try {
    await bootstrapAgent();
    const body = (await req.json().catch(() => ({}))) as {
      category?: MemoryCategory;
      title?: string;
      body?: string;
      tags?: string[];
      confidence?: number;
      opportunityId?: string;
      agent?: string;
      // Retrieval mode — if `action: "retrieve"`, return memories instead of recording.
      action?: "retrieve" | "record";
      query?: string;
      limit?: number;
    };

    // Retrieval mode.
    if (body.action === "retrieve") {
      const memories = await retrieveMemories({
        category: body.category,
        query: body.query,
        tags: body.tags,
        limit: body.limit,
      });
      return NextResponse.json(
        { memories, count: memories.length },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Record mode (default).
    if (!body.title || !body.body || !body.agent) {
      return NextResponse.json(
        { error: "title, body, and agent are required" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const memory = await recordMemory({
      category: body.category ?? "general",
      title: body.title,
      body: body.body,
      tags: body.tags,
      confidence: body.confidence,
      opportunityId: body.opportunityId,
      agent: body.agent,
    });

    return NextResponse.json(
      { memory },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
