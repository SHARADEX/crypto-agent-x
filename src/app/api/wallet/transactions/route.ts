// GET  /api/wallet/transactions
// POST /api/wallet/transactions
//
// GET: return the most recent N transactions from the DB. Query params:
//   - limit : default 50, hard-cap 200
//   - chain : filter by chain (e.g. "ethereum", "bitcoin", "solana", ...)
//
// POST: trigger a payment scan across every monitored wallet. Body:
//   - since?: ISO date string — only persist transactions on or after this
//             UTC date (default: 24 hours ago).
// Returns the ScanPaymentsSummary.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { scanForIncomingPayments } from "@/lib/wallet/payment-verifier";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 200;

export async function GET(req: Request) {
  try {
    await bootstrapAgent();

    const url = new URL(req.url);
    const limitParam = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(Math.trunc(limitParam), MAX_LIMIT))
      : 50;
    const chain = url.searchParams.get("chain") ?? undefined;

    const where: Record<string, unknown> = {};
    if (chain) where.chain = chain;

    const rows = await db.transaction.findMany({
      where: where as never,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return NextResponse.json(
      { transactions: rows, count: rows.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/wallet/transactions GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function POST(req: Request) {
  try {
    await bootstrapAgent();

    let since: Date | undefined;
    try {
      const body = await req.json();
      if (body && typeof body === "object") {
        const s = (body as { since?: unknown }).since;
        if (typeof s === "string" && s) {
          const parsed = new Date(s);
          if (Number.isFinite(parsed.getTime())) {
            since = parsed;
          }
        }
      }
    } catch {
      // Body missing — leave `since` undefined.
    }

    const summary = await scanForIncomingPayments({ since });
    return NextResponse.json(
      { summary },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/wallet/transactions POST] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
