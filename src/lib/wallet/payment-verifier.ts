// Payment verifier (spec §13).
//
// The spec is explicit: "Do not consider an opportunity successful simply
// because 'the PR was merged' or 'the client said payment was sent.' Verify
// payment independently whenever technically possible."
//
// This module:
//
//   1. `scanForIncomingPayments({ since })` — for every monitored wallet,
//      fetch the most recent incoming transactions via the chain's adapter
//      and upsert them into the `Transaction` table (unique on
//      `[chain, txHash]`). Existing rows are left untouched so any prior
//      `matched=true` / `verificationStatus` decisions are preserved.
//
//   2. `verifyPaymentForOpportunity(opportunityId)` — looks up the
//      opportunity, scans the `Transaction` table for rows where
//      `toAddress` is one of our monitored wallets AND the amount is within
//      ±5% of `opportunity.rewardAmount` AND the currency matches
//      `opportunity.rewardCurrency`. Returns a {@link PaymentVerificationResult}.
//      On a match, marks the matching `Transaction.matched = true` and
//      `verificationStatus = "matched"`, then upgrades any expected Earning
//      row to verified via the ledger's `convertExpectedToVerified`.
//
//   3. `getRecentTransactions(limit)` — dashboard helper that returns the
//      N most recent transactions from the DB.
//
// Matching is intentionally tolerant: if NO matching transaction is found,
// the result is `{ matched: false, status: "unverified", notes: [...] }` —
// never thrown, never crashes the orchestrator cycle.

import { db } from "@/lib/db";
import { WALLETS, NATIVE_PRICE_FALLBACK_USD } from "@/config/wallets";
import { logEvent } from "@/lib/agent/events";
import { BudgetManager } from "@/lib/budget/manager";
import type {
  Chain,
  PaymentVerificationResult,
} from "@/lib/agent/types";

import {
  fetchEvmTransactions,
  type EvmTransaction,
} from "@/lib/wallet/adapters/evm";
import {
  fetchBitcoinTransactions,
  type BitcoinTransaction,
} from "@/lib/wallet/adapters/bitcoin";
import {
  fetchSolanaTransactions,
  type SolanaTransaction,
} from "@/lib/wallet/adapters/solana";
import {
  fetchTronTransactions,
  type TronTransaction,
} from "@/lib/wallet/adapters/tron";
import {
  fetchRoninTransactions,
  type RoninTransaction,
} from "@/lib/wallet/adapters/ronin";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScanPaymentsOptions {
  /** Only persist transactions on or after this UTC date. */
  since?: Date;
  /** Override the per-adapter tx limit (default 20). */
  limit?: number;
}

export interface ScanPaymentsSummary {
  scannedWallets: number;
  fetchedTransactions: number;
  newTransactions: number;
  duplicates: number;
  errors: Record<string, string>;
  startedAt: string;
  finishedAt: string;
}

// ---------------------------------------------------------------------------
// 1. scanForIncomingPayments
// ---------------------------------------------------------------------------

/**
 * Scan every monitored wallet for recent incoming transactions and persist
 * any new ones to the `Transaction` table. Spec §13.
 *
 * Each wallet's adapter returns a list of normalized transactions (native
 * currency only — token transfers are a follow-up). The transactions are
 * upserted by the unique `[chain, txHash]` key; existing rows are left
 * untouched (no overwrite of `matched` / `verificationStatus`).
 *
 * @returns a {@link ScanPaymentsSummary}. Never throws.
 */
export async function scanForIncomingPayments(
  opts?: ScanPaymentsOptions
): Promise<ScanPaymentsSummary> {
  const startedAt = new Date().toISOString();
  const summary: ScanPaymentsSummary = {
    scannedWallets: 0,
    fetchedTransactions: 0,
    newTransactions: 0,
    duplicates: 0,
    errors: {},
    startedAt,
    finishedAt: startedAt,
  };

  const sinceMs = opts?.since ? opts.since.getTime() : 0;
  const limit = Math.max(1, Math.min(opts?.limit ?? 20, 50));

  // Budget pre-check. If we're over-budget, skip the scan and return early.
  try {
    await BudgetManager.getInstance().assertWithinBudget();
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Budget exceeded.";
    summary.finishedAt = new Date().toISOString();
    await logEvent(
      "payment",
      "warn",
      "payment_scan_budget_skipped",
      { reason },
      {}
    );
    return summary;
  }

  // Run every adapter's tx-list fetch in parallel. Promise.allSettled so
  // a single adapter crash never blocks the others.
  const tasks = WALLETS.map(async (w) => {
    const txs = await fetchTransactionsForChain(w.chain, w.address, limit);
    return { wallet: w, txs };
  });
  const settled = await Promise.allSettled(tasks);

  for (const result of settled) {
    if (result.status !== "fulfilled") {
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      // Use a synthetic key since we don't know which wallet failed.
      summary.errors["__unknown__"] = reason;
      continue;
    }
    const { wallet, txs } = result.value;
    summary.scannedWallets += 1;

    if (txs.error) {
      summary.errors[wallet.label] = txs.error;
    }

    for (const tx of txs.transactions) {
      summary.fetchedTransactions += 1;
      // Filter out transactions older than `since` if provided.
      if (sinceMs > 0 && tx.timestamp) {
        const ts = Date.parse(tx.timestamp);
        if (Number.isFinite(ts) && ts < sinceMs) continue;
      }
      // Only persist incoming transactions (spec §13 — payment verification
      // only cares about money flowing INTO one of our wallets).
      if (tx.direction !== "incoming") continue;

      try {
        const normalized = normalizeTxForDb(wallet.chain, wallet.address, tx);
        if (!normalized) {
          continue;
        }
        // Check `since` again, on the DB blockTimestamp if the adapter
        // didn't return a timestamp.
        if (sinceMs > 0 && normalized.blockTimestamp) {
          const ts = normalized.blockTimestamp.getTime();
          if (Number.isFinite(ts) && ts < sinceMs) continue;
        }
        // Idempotent upsert — existing rows are left untouched (we explicitly
        // preserve `matched` and `verificationStatus` on update).
        const before = await db.transaction.findUnique({
          where: {
            chain_txHash: {
              chain: normalized.chain,
              txHash: normalized.txHash,
            },
          },
          select: { id: true, matched: true, verificationStatus: true },
        });
        if (before) {
          summary.duplicates += 1;
          continue;
        }
        await db.transaction.create({
          data: {
            chain: normalized.chain,
            txHash: normalized.txHash,
            fromAddress: normalized.fromAddress,
            toAddress: normalized.toAddress,
            amount: normalized.amount,
            currency: normalized.currency,
            usdValue: normalized.usdValue,
            tokenContract: normalized.tokenContract,
            blockTimestamp: normalized.blockTimestamp,
            direction: "incoming",
          },
        });
        summary.newTransactions += 1;
      } catch (err) {
        console.error("[payment-verifier] failed to persist tx:", err);
      }
    }
  }

  summary.finishedAt = new Date().toISOString();
  await logEvent(
    "payment",
    "info",
    "payment_scan_complete",
    {
      scannedWallets: summary.scannedWallets,
      fetchedTransactions: summary.fetchedTransactions,
      newTransactions: summary.newTransactions,
      duplicates: summary.duplicates,
      errorCount: Object.keys(summary.errors).length,
    },
    {}
  );
  return summary;
}

// ---------------------------------------------------------------------------
// 2. verifyPaymentForOpportunity
// ---------------------------------------------------------------------------

/** ±5% amount tolerance for matching opportunity rewards to transactions. */
const AMOUNT_TOLERANCE = 0.05;

/**
 * Look up the opportunity and search the `Transaction` table for any
 * incoming payment that matches its expected reward.
 *
 * Matching criteria (spec §13):
 *   - `toAddress` is one of our monitored wallets
 *   - `amount` is within ±5% of `opportunity.rewardAmount`
 *   - `currency` matches `opportunity.rewardCurrency`
 *   - `blockTimestamp` (if known) is within the last 30 days
 *
 * On a successful match:
 *   - The matching `Transaction.matched` is set to `true`
 *   - `Transaction.verificationStatus` is set to `"matched"`
 *   - `Transaction.opportunityId` is set to the opportunity id
 *   - Any expected `Earning` row is upgraded to verified via the ledger's
 *     `convertExpectedToVerified` (best-effort — failure is logged only).
 *
 * @returns a {@link PaymentVerificationResult}. Never throws.
 */
export async function verifyPaymentForOpportunity(
  opportunityId: string
): Promise<PaymentVerificationResult> {
  const failure: PaymentVerificationResult = {
    matched: false,
    status: "unverified",
    notes: ["No matching transaction found in last 30 days"],
  };
  if (!opportunityId) {
    return { ...failure, notes: ["Missing opportunityId."] };
  }

  try {
    const op = await db.opportunity.findUnique({
      where: { id: opportunityId },
      select: {
        id: true,
        rewardAmount: true,
        rewardCurrency: true,
        rewardUsd: true,
        source: true,
        category: true,
      },
    });
    if (!op) {
      return {
        matched: false,
        status: "unverified",
        notes: [`Opportunity ${opportunityId} not found.`],
      };
    }

    const expectedAmount = Number(op.rewardAmount);
    if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
      return {
        matched: false,
        status: "unverified",
        notes: [
          `Opportunity has no rewardAmount (got '${op.rewardAmount}'); cannot verify.`,
        ],
      };
    }

    // Our monitored wallet addresses (lower-cased for EVM/Tron; BTC and Solana
    // are case-sensitive but the addresses are deterministic).
    const ourAddresses = new Set(
      WALLETS.map((w) => w.address.toLowerCase())
    );
    const chainByAddressLower = new Map<string, Chain>(
      WALLETS.map((w) => [w.address.toLowerCase(), w.chain])
    );

    // Lookup window: 30 days back.
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Find candidate transactions: incoming, paid to one of our addresses,
    // matching the reward currency. SQLite doesn't support `mode:
    // "insensitive"` on StringFilter, so we fetch a slightly larger candidate
    // set and filter case-insensitively in JS below.
    const targetCurrency = (op.rewardCurrency ?? "").toLowerCase();
    const candidates = await db.transaction.findMany({
      where: {
        direction: "incoming",
      },
      orderBy: { blockTimestamp: "desc" },
      take: 500,
    });

    // Filter the candidate set by currency (case-insensitive) and recipient.
    const filteredCandidates = candidates.filter((tx) => {
      const c = (tx.currency ?? "").toLowerCase();
      return c === targetCurrency;
    });

    let bestMatch:
      | {
          tx: (typeof filteredCandidates)[number];
          deltaPct: number;
        }
      | null = null;

    for (const tx of filteredCandidates) {
      // Filter by recipient (case-insensitive on EVM/Tron).
      const toLower = (tx.toAddress ?? "").toLowerCase();
      if (!ourAddresses.has(toLower)) continue;

      // Filter by timestamp window.
      if (tx.blockTimestamp && tx.blockTimestamp < since) continue;

      const txAmount = Number(tx.amount);
      if (!Number.isFinite(txAmount) || txAmount <= 0) continue;

      const deltaPct = Math.abs(txAmount - expectedAmount) / expectedAmount;
      if (deltaPct > AMOUNT_TOLERANCE) continue;

      if (
        !bestMatch ||
        deltaPct < bestMatch.deltaPct ||
        // Prefer un-matched transactions over already-matched ones.
        (bestMatch.tx.matched && !tx.matched)
      ) {
        bestMatch = { tx, deltaPct };
      }
    }

    if (!bestMatch) {
      // No match found — record a debug event for auditability.
      await logEvent(
        "payment",
        "debug",
        "payment_verification_no_match",
        {
          opportunityId,
          rewardAmount: expectedAmount,
          rewardCurrency: op.rewardCurrency,
          candidatesConsidered: filteredCandidates.length,
        },
        { opportunityId }
      );
      return failure;
    }

    const match = bestMatch.tx;
    const chain = (chainByAddressLower.get(
      (match.toAddress ?? "").toLowerCase()
    ) ?? match.chain) as Chain;

    // Mark the transaction as matched.
    try {
      await db.transaction.update({
        where: { id: match.id },
        data: {
          matched: true,
          verificationStatus: "matched",
          opportunityId,
        },
      });
    } catch (err) {
      console.error("[payment-verifier] failed to mark tx matched:", err);
    }

    // Best-effort upgrade of any expected Earning row.
    try {
      const { convertExpectedToVerified } = await import(
        "@/lib/economics/ledger"
      );
      await convertExpectedToVerified(opportunityId, {
        transactionHash: match.txHash,
        chain,
        grossUsd: match.usdValue > 0 ? match.usdValue : op.rewardUsd,
      });
    } catch (err) {
      console.warn(
        "[payment-verifier] convertExpectedToVerified failed (non-fatal):",
        err
      );
    }

    await logEvent(
      "payment",
      "info",
      "payment_verified",
      {
        opportunityId,
        chain,
        txHash: match.txHash,
        amount: match.amount,
        currency: match.currency,
        usdValue: match.usdValue,
        expectedAmount,
        deltaPct: round4(bestMatch.deltaPct),
        toAddress: match.toAddress,
      },
      { opportunityId }
    );

    return {
      matched: true,
      transactionHash: match.txHash,
      chain,
      amount: match.amount,
      currency: match.currency,
      usdValue: match.usdValue,
      status: "matched",
      notes: [
        `Matched on ${chain} tx ${match.txHash}`,
        `Amount ${match.amount} ${match.currency} vs expected ${expectedAmount} ${op.rewardCurrency} (Δ ${round4(bestMatch.deltaPct) * 100}%).`,
      ],
    };
  } catch (err) {
    console.error("[payment-verifier] verifyPaymentForOpportunity failed:", err);
    return {
      matched: false,
      status: "unverified",
      notes: [
        `Verifier crashed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// 3. getRecentTransactions
// ---------------------------------------------------------------------------

/**
 * Return the most recent N transactions from the DB, newest first.
 * Spec §13 / spec §12 (transaction monitoring).
 */
export async function getRecentTransactions(limit = 20): Promise<
  Array<{
    id: string;
    chain: string;
    txHash: string;
    fromAddress: string | null;
    toAddress: string | null;
    amount: number;
    currency: string;
    usdValue: number;
    tokenContract: string | null;
    blockTimestamp: Date | null;
    direction: string;
    matched: boolean;
    verificationStatus: string;
    opportunityId: string | null;
    createdAt: Date;
  }>
> {
  try {
    const take = Math.max(1, Math.min(limit, 200));
    return await db.transaction.findMany({
      orderBy: { createdAt: "desc" },
      take,
    });
  } catch (err) {
    console.error("[payment-verifier] getRecentTransactions failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Adapter dispatch
// ---------------------------------------------------------------------------

interface FetchedTxs {
  transactions: NormalizedTx[];
  error?: string;
}

interface NormalizedTx {
  hash: string;
  from?: string;
  to?: string;
  /** Native-amount in the chain's smallest unit converted to the major unit. */
  amount: number;
  currency: string;
  usdValue: number;
  tokenContract?: string;
  timestamp: string | null;
  direction: "incoming" | "outgoing";
}

/**
 * Dispatch to the right adapter's transaction-list fetch and normalize the
 * chain-specific transaction shape into the common {@link NormalizedTx}.
 */
async function fetchTransactionsForChain(
  chain: Chain,
  address: string,
  limit: number
): Promise<FetchedTxs> {
  try {
    switch (chain) {
      case "ethereum":
      case "polygon":
      case "bsc":
      case "arbitrum":
      case "optimism": {
        const res = await fetchEvmTransactions(address, { limit });
        return {
          transactions: res.transactions.map((t) => evmToNormalized(t)),
          error: res.error,
        };
      }
      case "bitcoin": {
        const res = await fetchBitcoinTransactions(address, { limit });
        return {
          transactions: res.transactions.map((t) => bitcoinToNormalized(t)),
          error: res.error,
        };
      }
      case "solana": {
        const res = await fetchSolanaTransactions(address, { limit });
        return {
          transactions: res.transactions.map((t) => solanaToNormalized(t)),
          error: res.error,
        };
      }
      case "tron": {
        const res = await fetchTronTransactions(address, { limit });
        return {
          transactions: res.transactions.map((t) => tronToNormalized(t)),
          error: res.error,
        };
      }
      case "ronin": {
        const res = await fetchRoninTransactions(address, { limit });
        return {
          transactions: res.transactions.map((t) => roninToNormalized(t)),
          error: res.error,
        };
      }
      default: {
        return {
          transactions: [],
          error: `No tx-list adapter for chain '${chain}'.`,
        };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { transactions: [], error: msg };
  }
}

// ---------------------------------------------------------------------------
// Chain-specific → NormalizedTx
// ---------------------------------------------------------------------------

function evmToNormalized(t: EvmTransaction): NormalizedTx {
  const wei = parseWeiStr(t.value);
  const amount = wei / 1e18;
  const currency = "ETH";
  const usd = amount * (NATIVE_PRICE_FALLBACK_USD.ETH ?? 0);
  return {
    hash: t.hash,
    from: t.from,
    to: t.to ?? undefined,
    amount,
    currency,
    usdValue: round2(usd),
    tokenContract: t.tokenContract,
    timestamp: t.timestamp,
    direction: t.direction ?? "incoming",
  };
}

function bitcoinToNormalized(t: BitcoinTransaction): NormalizedTx {
  const amount = t.valueSats / 1e8;
  const usd = amount * (NATIVE_PRICE_FALLBACK_USD.BTC ?? 0);
  return {
    hash: t.hash,
    from: t.from,
    to: t.to,
    amount,
    currency: "BTC",
    usdValue: round2(usd),
    timestamp: t.timestamp,
    direction: t.direction,
  };
}

function solanaToNormalized(t: SolanaTransaction): NormalizedTx {
  const amount = t.valueLamports / 1e9;
  const usd = amount * (NATIVE_PRICE_FALLBACK_USD.SOL ?? 0);
  return {
    hash: t.hash,
    from: t.from,
    to: t.to,
    amount,
    currency: "SOL",
    usdValue: round2(usd),
    timestamp: t.timestamp,
    direction: t.direction,
  };
}

function tronToNormalized(t: TronTransaction): NormalizedTx {
  const amount = t.valueSun / 1e6;
  const usd = amount * (NATIVE_PRICE_FALLBACK_USD.TRX ?? 0);
  return {
    hash: t.hash,
    from: t.from,
    to: t.to,
    amount,
    currency: "TRX",
    usdValue: round2(usd),
    timestamp: t.timestamp,
    direction: t.direction,
  };
}

function roninToNormalized(t: RoninTransaction): NormalizedTx {
  const amount = t.valueWei / 1e18;
  const usd = amount * (NATIVE_PRICE_FALLBACK_USD.RON ?? 0);
  return {
    hash: t.hash,
    from: t.from,
    to: t.to,
    amount,
    currency: "RON",
    usdValue: round2(usd),
    timestamp: t.timestamp,
    direction: t.direction,
  };
}

// ---------------------------------------------------------------------------
// DB row builder
// ---------------------------------------------------------------------------

interface NormalizedForDb {
  chain: string;
  txHash: string;
  fromAddress: string | null;
  toAddress: string | null;
  amount: number;
  currency: string;
  usdValue: number;
  tokenContract: string | null;
  blockTimestamp: Date | null;
}

function normalizeTxForDb(
  chain: Chain,
  selfAddress: string,
  tx: NormalizedTx
): NormalizedForDb | null {
  const hash = (tx.hash ?? "").trim();
  if (!hash) return null;
  const from = tx.from?.trim() || null;
  const to = (tx.to?.trim() || selfAddress.trim()) || null;
  return {
    chain,
    txHash: hash,
    fromAddress: from,
    toAddress: to,
    amount: tx.amount,
    currency: tx.currency,
    usdValue: tx.usdValue,
    tokenContract: tx.tokenContract ?? null,
    blockTimestamp: tx.timestamp ? new Date(tx.timestamp) : null,
  };
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function parseWeiStr(input: string | null | undefined): number {
  if (input === null || input === undefined) return 0;
  const s = String(input).trim();
  if (!s) return 0;
  try {
    if (s.startsWith("0x") || s.startsWith("0X")) {
      const n = Number(BigInt(s));
      return Number.isFinite(n) ? n : 0;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}
