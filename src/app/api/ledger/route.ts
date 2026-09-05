// GET /api/ledger
//
// Return LedgerEntry rows from the Earning table.
// Query params:
//   - verified : "true" → only verified rows
//                "false" → only expected (not-yet-verified) rows
//                (default: no filter, return everything)
//   - limit    : default 50, hard-cap 200
//   - source   : filter by source
//   - category : filter by category

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { getLedger } from "@/lib/economics/ledger";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 200;

export async function GET(req: Request) {
  try {
    await bootstrapAgent();

    const url = new URL(req.url);
    const verifiedParam = url.searchParams.get("verified");
    const source = url.searchParams.get("source") ?? undefined;
    const category = url.searchParams.get("category") ?? undefined;
    const limitParam = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(Math.trunc(limitParam), MAX_LIMIT))
      : 50;

    const verifiedOnly = verifiedParam === "true";
    const expectedOnly = verifiedParam === "false";

    // Pull a slightly larger candidate set when a source/category filter is
    // applied (the getLedger helper doesn't yet accept those natively) and
    // post-filter in JS so the API surface stays simple.
    const fetchLimit = source || category ? Math.min(limit * 5, 1000) : limit;
    let rows = await getLedger({
      verifiedOnly,
      expectedOnly,
      limit: fetchLimit,
    });

    if (source) {
      rows = rows.filter((r) => r.source === source);
    }
    if (category) {
      rows = rows.filter((r) => r.category === category);
    }
    rows = rows.slice(0, limit);

    return NextResponse.json(
      { ledger: rows, count: rows.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/ledger GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
