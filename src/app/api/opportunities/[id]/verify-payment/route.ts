// POST /api/opportunities/[id]/verify-payment
//
// Run the payment verifier against this opportunity. The verifier looks up
// the opportunity's expected reward (amount + currency) and searches the
// Transaction table for a matching incoming payment on one of our monitored
// wallets. On a match it marks the transaction matched + upgrades any
// expected Earning row to verified.
//
// Returns the PaymentVerificationResult.

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { verifyPaymentForOpportunity } from "@/lib/wallet/payment-verifier";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_req: Request, { params }: RouteParams) {
  try {
    await bootstrapAgent();

    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { error: "Missing opportunity id." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const result = await verifyPaymentForOpportunity(id);
    return NextResponse.json(
      { result },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/opportunities/[id]/verify-payment] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
