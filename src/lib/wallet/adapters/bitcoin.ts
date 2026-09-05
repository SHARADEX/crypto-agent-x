// Bitcoin wallet adapter — via the free blockchain.info REST API (spec §12).
//
//   GET https://blockchain.info/rawaddr/{address}?limit=5
//   → {
//       address,
//       final_balance,    // satoshis
//       total_received,   // satoshis
//       total_sent,       // satoshis
//       n_tx,
//       txs: [            // most recent transactions (limit=N)
//         {
//           hash,
//           time,         // unix seconds
//           result,       // net satoshis received (positive=incoming)
//           out: [{ addr, value }],
//           inputs: [{ prev_out: { addr, value } }],
//         },
//         ...
//       ]
//     }
//
// All HTTP calls have an 8-second AbortController timeout. The adapter NEVER
// throws — on any failure it returns a zero-balance {@link WalletBalance}
// with the `error` field populated.
//
// This module is READ-ONLY: it never signs or broadcasts transactions, and it
// never requests or stores private keys, seed phrases, or recovery phrases.

import {
  NATIVE_PRICE_FALLBACK_USD,
  NATIVE_SYMBOL_BY_CHAIN,
} from "@/config/wallets";
import type { Chain, TokenBalance, WalletBalance } from "@/lib/agent/types";
import { BudgetManager } from "@/lib/budget/manager";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BLOCKCHAIN_INFO_BASE =
  process.env.BLOCKCHAIN_INFO_BASE_URL ?? "https://blockchain.info";

const TIMEOUT_MS = 8_000;
const CHAIN: Chain = "bitcoin";
const NATIVE_SYMBOL = NATIVE_SYMBOL_BY_CHAIN[CHAIN] ?? "BTC";
const SATOSHI_PER_BTC = 1e8;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the Bitcoin balance for `address` via the blockchain.info API.
 * Returns the final on-chain balance in BTC plus a conservative USD estimate.
 *
 * Never throws — failures are surfaced via the `error` field on a
 * zero-balance result so callers can degrade gracefully.
 */
export async function fetchBitcoinBalance(
  address: string,
  opts?: { label?: string; timeoutMs?: number }
): Promise<WalletBalance> {
  const label = opts?.label ?? "Bitcoin Wallet";
  const fetchedAt = new Date().toISOString();
  const zero: WalletBalance = {
    label,
    chain: CHAIN,
    address,
    nativeBalance: 0,
    nativeSymbol: NATIVE_SYMBOL,
    usdValue: 0,
    tokens: [],
    fetchedAt,
  };

  const trimmed = (address ?? "").trim();
  if (!trimmed) {
    return { ...zero, error: "Missing Bitcoin address." };
  }

  const url = `${BLOCKCHAIN_INFO_BASE}/rawaddr/${encodeURIComponent(trimmed)}?limit=5`;
  const timeoutMs = Math.max(1000, opts?.timeoutMs ?? TIMEOUT_MS);

  try {
    await BudgetManager.getInstance().recordRpcRequest();
  } catch (err) {
    console.warn("[wallet/bitcoin] budget recordRpcRequest failed:", err);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "CryptoEarn-Agent/0.1 (+read-only wallet monitor)",
      },
    });

    if (res.status === 429) {
      return {
        ...zero,
        error: "blockchain.info rate-limited (HTTP 429).",
      };
    }
    if (!res.ok) {
      const body = await safeReadText(res);
      return {
        ...zero,
        error: `blockchain.info HTTP ${res.status} ${res.statusText}: ${body.slice(0, 280)}`,
      };
    }

    const json = (await res.json()) as BlockchainInfoAddressResponse;
    const satStr = json.final_balance ?? json.balance ?? "0";
    const nativeBalance = satToBtc(satStr);

    const btcPrice = NATIVE_PRICE_FALLBACK_USD.BTC ?? 0;
    const nativeUsd = nativeBalance * btcPrice;

    // Bitcoin has no concept of in-protocol ERC-20-style tokens — the `tokens`
    // array is intentionally empty. (Ordinals / BRC-20 are out of scope.)
    const tokens: TokenBalance[] = [];

    return {
      label,
      chain: CHAIN,
      address: trimmed,
      nativeBalance,
      nativeSymbol: NATIVE_SYMBOL,
      usdValue: round2(nativeUsd),
      tokens,
      fetchedAt,
    };
  } catch (err) {
    const aborted =
      err instanceof Error && err.name === "AbortError"
        ? `blockchain.info request timed out after ${timeoutMs}ms.`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ...zero, error: aborted };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Transaction scanning (used by the payment verifier, spec §13)
// ---------------------------------------------------------------------------

export interface BitcoinTxScanResult {
  transactions: BitcoinTransaction[];
  fetchedAt: string;
  error?: string;
}

export interface BitcoinTransaction {
  hash: string;
  from?: string;
  to?: string;
  valueSats: number; // net satoshis received (positive=incoming)
  timestamp: string | null;
  direction: "incoming" | "outgoing";
}

/**
 * Fetch the most recent transactions for a Bitcoin address. Used by the
 * payment verifier to detect incoming payments that match an opportunity's
 * expected reward.
 *
 * Never throws — returns an empty list + `error` on failure.
 */
export async function fetchBitcoinTransactions(
  address: string,
  opts?: { limit?: number; timeoutMs?: number }
): Promise<BitcoinTxScanResult> {
  const fetchedAt = new Date().toISOString();
  const trimmed = (address ?? "").trim();
  const limit = Math.max(1, Math.min(opts?.limit ?? 20, 50));
  const timeoutMs = Math.max(1000, opts?.timeoutMs ?? TIMEOUT_MS);

  if (!trimmed) {
    return {
      transactions: [],
      fetchedAt,
      error: "Missing Bitcoin address.",
    };
  }

  const url = `${BLOCKCHAIN_INFO_BASE}/rawaddr/${encodeURIComponent(
    trimmed
  )}?limit=${limit}`;

  try {
    await BudgetManager.getInstance().recordRpcRequest();
  } catch (err) {
    console.warn("[wallet/bitcoin] budget recordRpcRequest failed:", err);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "CryptoEarn-Agent/0.1 (+read-only wallet monitor)",
      },
    });

    if (res.status === 429) {
      return {
        transactions: [],
        fetchedAt,
        error: "blockchain.info rate-limited (HTTP 429).",
      };
    }
    if (!res.ok) {
      const body = await safeReadText(res);
      return {
        transactions: [],
        fetchedAt,
        error: `blockchain.info HTTP ${res.status}: ${body.slice(0, 280)}`,
      };
    }

    const json = (await res.json()) as BlockchainInfoAddressResponse;
    const items = Array.isArray(json?.txs) ? json.txs : [];

    const transactions: BitcoinTransaction[] = [];
    for (const tx of items.slice(0, limit)) {
      try {
        const mapped = mapBitcoinTx(tx, trimmed);
        if (mapped) transactions.push(mapped);
      } catch (err) {
        console.warn("[wallet/bitcoin] skipping malformed tx:", err);
      }
    }

    return { transactions, fetchedAt };
  } catch (err) {
    const aborted =
      err instanceof Error && err.name === "AbortError"
        ? `blockchain.info tx request timed out after ${timeoutMs}ms.`
        : err instanceof Error
          ? err.message
          : String(err);
    return { transactions: [], fetchedAt, error: aborted };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a satoshi-amount string into BTC (1 BTC = 1e8 sats). */
function satToBtc(satStr: string | number | null | undefined): number {
  let n: number;
  if (typeof satStr === "number") {
    n = satStr;
  } else if (typeof satStr === "string" && satStr.trim()) {
    n = Number(satStr);
  } else {
    return 0;
  }
  if (!Number.isFinite(n)) return 0;
  return n / SATOSHI_PER_BTC;
}

function mapBitcoinTx(
  tx: BlockchainInfoTx,
  selfAddress: string
): BitcoinTransaction | null {
  const hash = tx?.hash ?? "";
  if (!hash) return null;
  const self = selfAddress.toLowerCase();

  // `result` is the net satoshi delta (positive = incoming to self).
  const result = typeof tx?.result === "number" ? tx.result : 0;
  const direction: "incoming" | "outgoing" = result >= 0 ? "incoming" : "outgoing";

  // Pick the most likely counterparty address from outputs/inputs. For
  // incoming txs the counterparty is the largest `out` address that isn't
  // self; for outgoing txs the counterparty is the largest input address
  // that isn't self.
  let counterparty: string | undefined;
  if (direction === "incoming") {
    counterparty = pickLargestNonSelfOutput(tx, self);
  } else {
    counterparty = pickLargestNonSelfInput(tx, self);
  }

  const ts = tx?.time ?? tx?.t ?? null;
  const timestamp = ts ? new Date(ts * 1000).toISOString() : null;

  return {
    hash,
    from: direction === "incoming" ? counterparty : self,
    to: direction === "incoming" ? self : counterparty,
    valueSats: Math.abs(result),
    timestamp,
    direction,
  };
}

function pickLargestNonSelfOutput(
  tx: BlockchainInfoTx,
  self: string
): string | undefined {
  const outs = Array.isArray(tx?.out) ? tx.out : [];
  let best: { addr: string; value: number } | null = null;
  for (const o of outs) {
    const addr = (o?.addr ?? "").trim();
    if (!addr) continue;
    if (addr.toLowerCase() === self) continue;
    const value = typeof o?.value === "number" ? o.value : Number(o?.value ?? 0);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (!best || value > best.value) {
      best = { addr, value };
    }
  }
  return best?.addr;
}

function pickLargestNonSelfInput(
  tx: BlockchainInfoTx,
  self: string
): string | undefined {
  const inputs = Array.isArray(tx?.inputs) ? tx.inputs : [];
  let best: { addr: string; value: number } | null = null;
  for (const i of inputs) {
    const prev = i?.prev_out;
    const addr = (prev?.addr ?? "").trim();
    if (!addr) continue;
    if (addr.toLowerCase() === self) continue;
    const value =
      typeof prev?.value === "number" ? prev.value : Number(prev?.value ?? 0);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (!best || value > best.value) {
      best = { addr, value };
    }
  }
  return best?.addr;
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BlockchainInfoAddressResponse {
  address?: string;
  final_balance?: number | string;
  balance?: number | string;
  total_received?: number | string;
  total_sent?: number | string;
  n_tx?: number;
  txs?: BlockchainInfoTx[];
}

interface BlockchainInfoTx {
  hash?: string;
  time?: number | null;
  t?: number | null;
  result?: number;
  out?: { addr?: string; value?: number | string }[];
  inputs?: { prev_out?: { addr?: string; value?: number | string } }[];
}
