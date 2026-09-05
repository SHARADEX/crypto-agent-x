// GET /api/ledger/totals
//
// Aggregate the entire ledger into a single snapshot. Returns the
// LedgerTotals object: verified vs expected net USD, per-category and
// per-source rollups, success rate, average hourly return, and the
// attempted/completed opportunity counts.

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { getTotals } from "@/lib/economics/ledger";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await bootstrapAgent();

    const totals = await getTotals();
    return NextResponse.json(
      { totals },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/ledger/totals GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
