// GET /api/wallet/balances
//
// Force a refresh of every monitored wallet's balance via the wallet monitor
// subsystem, then return the WalletBalance[] array. The monitor persists a
// snapshot to disk and degrades gracefully on RPC failures (each wallet row
// carries an `error` field if its adapter failed).
//
// The refresh respects the kill switch — if the agent is paused or
// emergency-stopped, the monitor returns the last cached snapshot rather
// than hitting any RPC. This makes the endpoint safe to call from the
// dashboard even when the operator has paused the agent.

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { refreshWallets } from "@/lib/wallet/monitor";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await bootstrapAgent();

    const snapshot = await refreshWallets();
    return NextResponse.json(
      {
        wallets: snapshot.wallets,
        totalUsd: snapshot.totalUsd,
        fetchedAt: snapshot.fetchedAt,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/wallet/balances] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
