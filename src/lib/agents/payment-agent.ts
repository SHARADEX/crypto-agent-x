// Payment Verification Agent (spec §4B, §13).
//
// Verifies that a payment matching the opportunity's reward has landed on one
// of our monitored wallets. Uses the deterministic blockchain verifier
// (`verifyPaymentForOpportunity` from `@/lib/wallet/payment-verifier`) — the
// LLM is NEVER consulted on payment truth (spec §13: "Final payment
// verification must be performed by deterministic blockchain verification
// whenever possible.").
//
// Pipeline:
//   1. Call `verifyPaymentForOpportunity(opportunityId)`.
//   2. If matched → `convertExpectedToVerified(opportunityId, paymentDetails)`
//      from the ledger (upgrades the expected earning row to verified).
//   3. If not matched → `scanForIncomingPayments` to discover new txs, then
//      retry the verification.
//   4. Record the verification result + tx hash on the Opportunity row.
//   5. Update StrategyStat outcome via the ledger (already done inside
//      `convertExpectedToVerified`).
//
// Never throws. Failures return `{ success: false, result: { error } }`.

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import {
  scanForIncomingPayments,
  verifyPaymentForOpportunity,
} from "@/lib/wallet/payment-verifier";
import {
  convertExpectedToVerified,
  recordVerifiedEarning,
} from "@/lib/economics/ledger";
import { recordStrategyOutcome } from "@/lib/economics/strategy-stats";
import type { AgentInput, AgentOutput } from "@/lib/agents/types";
import { fail, ok } from "@/lib/agents/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PaymentAgentResult {
  matched: boolean;
  transactionHash?: string;
  chain?: string;
  amount?: number;
  currency?: string;
  usdValue?: number;
  status: "matched" | "amount_mismatch" | "wrong_recipient" | "unverified" | "suspicious";
  notes: string[];
  scannedForNewPayments: boolean;
  opportunityStatus: "awaiting_payment" | "paid" | "failed";
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

export async function execute(input: AgentInput): Promise<AgentOutput> {
  const taskId = (input.task?.id as string | undefined) ?? undefined;
  const opportunityId =
    (input.opportunity?.id as string | undefined) ?? undefined;

  if (!opportunityId) {
    return fail("payment agent requires an opportunity id");
  }

  try {
    const op = await db.opportunity.findUnique({
      where: { id: opportunityId },
      select: {
        id: true,
        status: true,
        rewardAmount: true,
        rewardCurrency: true,
        rewardUsd: true,
        estimatedHours: true,
        category: true,
        source: true,
      },
    });
    if (!op) {
      return fail(`opportunity ${opportunityId} not found`);
    }

    // --- 1. First verification attempt (uses already-cached txs) ---------
    let verification = await verifyPaymentForOpportunity(opportunityId);

    // --- 2. If no match, scan for new incoming payments then retry -------
    let scannedForNew = false;
    if (!verification.matched) {
      try {
        const scan = await scanForIncomingPayments();
        scannedForNew = scan.newTransactions > 0;
        if (scannedForNew) {
          verification = await verifyPaymentForOpportunity(opportunityId);
        }
      } catch (err) {
        console.error("[payment-agent] scanForIncomingPayments failed:", err);
      }
    }

    // --- 3. Handle the verdict -------------------------------------------
    if (verification.matched) {
      // Upgrade the expected earning row to verified.
      try {
        await convertExpectedToVerified(opportunityId, {
          transactionHash: verification.transactionHash ?? "",
          chain: verification.chain,
          grossUsd: verification.usdValue ?? op.rewardUsd,
        });
      } catch (err) {
        console.error(
          "[payment-agent] convertExpectedToVerified failed:",
          err
        );
        // The Transaction row is still marked matched, so the next cycle
        // can retry the ledger upgrade.
      }

      // If no expected row existed, record a fresh verified earning so the
      // ledger has the entry. The ledger function handles strategy-stat
      // increments inside.
      try {
        const existing = await db.earning.findFirst({
          where: { opportunityId },
          select: { id: true },
        });
        if (!existing) {
          await recordVerifiedEarning({
            opportunityId,
            source: op.source,
            category: op.category,
            grossUsd: verification.usdValue ?? op.rewardUsd,
            currency: verification.currency ?? op.rewardCurrency,
            hoursSpent: Math.max(0.5, op.estimatedHours),
            transactionHash: verification.transactionHash,
            chain: verification.chain,
            strategy: op.category,
          });
        }
      } catch (err) {
        console.error("[payment-agent] recordVerifiedEarning fallback failed:", err);
      }

      // Mark the opportunity as paid.
      try {
        await db.opportunity.update({
          where: { id: opportunityId },
          data: {
            status: "paid",
            paymentVerified: true,
          },
        });
      } catch (err) {
        console.error("[payment-agent] opportunity update failed:", err);
      }

      await logEvent(
        "payment",
        "info",
        "payment_verified_by_agent",
        {
          opportunityId,
          chain: verification.chain,
          txHash: verification.transactionHash,
          amount: verification.amount,
          currency: verification.currency,
          usdValue: verification.usdValue,
          scannedForNew,
        },
        { taskId, opportunityId }
      );

      return ok(
        {
          matched: true,
          transactionHash: verification.transactionHash,
          chain: verification.chain,
          amount: verification.amount,
          currency: verification.currency,
          usdValue: verification.usdValue,
          status: "matched",
          notes: verification.notes,
          scannedForNewPayments: scannedForNew,
          opportunityStatus: "paid" as const,
        } as unknown as Record<string, unknown>,
        {
          qualityScore: 10,
          nextAgent: "orchestrator",
        }
      );
    }

    // --- 4. Not matched: leave as awaiting_payment, log the attempt ------
    await logEvent(
      "payment",
      "info",
      "payment_not_yet_received",
      {
        opportunityId,
        scannedForNew,
        status: verification.status,
        notes: verification.notes,
      },
      { taskId, opportunityId }
    );

    return ok(
      {
        matched: false,
        status: verification.status,
        notes: verification.notes,
        scannedForNewPayments: scannedForNew,
        opportunityStatus: "awaiting_payment" as const,
      } as unknown as Record<string, unknown>,
      {
        notes: [
          "No matching payment found yet. The opportunity stays in 'awaiting_payment' — the next cycle will retry.",
        ],
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[payment-agent] execute threw:", err);
    await logEvent(
      "payment",
      "error",
      "payment_agent_failed",
      { opportunityId, error: message },
      { taskId, opportunityId }
    );

    // Record a failed outcome so the strategy learning subsystem picks
    // up the signal.
    try {
      const op = await db.opportunity.findUnique({
        where: { id: opportunityId },
        select: { category: true, estimatedHours: true },
      });
      if (op) {
        await recordStrategyOutcome(op.category, {
          attempted: true,
          failed: true,
          netUsd: 0,
          hoursSpent: Math.max(0.5, op.estimatedHours),
        });
      }
    } catch {
      // ignore — best-effort
    }

    return fail(`payment agent crashed: ${message}`);
  }
}
