// Ronin wallet adapter — via the Ronin Chain public JSON-RPC endpoint
// (spec §12). Ronin is EVM-compatible, so we use `eth_getBalance` just like
// any other EVM chain.
//
//   POST https://api.roninchain.com/rpc
//   JSON-RPC body:
//     { "jsonrpc": "2.0", "id": 1, "method": "eth_getBalance",
//       "params": ["<address>", "latest"] }
//   → { result: "0x0123abcd" } // hex-encoded wei
//
// All HTTP calls have an 8-second AbortController timeout. The adapter NEVER
// throws — on any failure it returns a zero-balance {@link WalletBalance}
// with the `error` field populated. The spec explicitly mandates: "If the
// RPC fails, gracefully return a balance of 0 with the error note (don't
// crash)".
//
// This module is READ-ONLY: it never signs, never broadcasts, and never
// requests or stores private keys, seed phrases, or recovery phrases.

import {
  NATIVE_PRICE_FALLBACK_USD,
  NATIVE_SYMBOL_BY_CHAIN,
} from "@/config/wallets";
import type { Chain, TokenBalance, WalletBalance } from "@/lib/agent/types";
import { BudgetManager } from "@/lib/budget/manager";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RONIN_RPC_URL =
  process.env.RONIN_RPC_URL ?? "https://api.roninchain.com/rpc";

const TIMEOUT_MS = 8_000;
const CHAIN: Chain = "ronin";
const NATIVE_SYMBOL = NATIVE_SYMBOL_BY_CHAIN[CHAIN] ?? "RON";
const WEI_PER_RON = 1e18;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the Ronin balance for `address` via the public JSON-RPC endpoint.
 *
 * Returns a {@link WalletBalance} with the native RON balance (converted from
 * wei). Token balances are not fetched on Ronin — the public RPC does not
 * expose a simple bulk token-balances endpoint without an API key, and the
 * spec §12 minimum is native balance + graceful degradation.
 *
 * Never throws. On RPC failure the returned `nativeBalance` is 0 and the
 * `error` field carries the failure message — the dashboard must never
 * crash because the Ronin RPC is unreachable.
 */
export async function fetchRoninBalance(
  address: string,
  opts?: { label?: string; timeoutMs?: number }
): Promise<WalletBalance> {
  const label = opts?.label ?? "Ronin Wallet";
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
    return { ...zero, error: "Missing Ronin address." };
  }

  const timeoutMs = Math.max(1000, opts?.timeoutMs ?? TIMEOUT_MS);

  try {
    await BudgetManager.getInstance().recordRpcRequest();
  } catch (err) {
    console.warn("[wallet/ronin] budget recordRpcRequest failed:", err);
  }

  const res = await rpcCall<string>(
    "eth_getBalance",
    [trimmed, "latest"],
    timeoutMs
  );

  if (res.error) {
    return {
      ...zero,
      error: res.error,
    };
  }

  const weiHex = res.result ?? "0x0";
  const weiNumber = hexWeiToNumber(weiHex);
  const nativeBalance = weiNumber / WEI_PER_RON;
  const ronPrice = NATIVE_PRICE_FALLBACK_USD.RON ?? 0;
  const nativeUsd = nativeBalance * ronPrice;

  return {
    label,
    chain: CHAIN,
    address: trimmed,
    nativeBalance,
    nativeSymbol: NATIVE_SYMBOL,
    usdValue: round2(nativeUsd),
    tokens: [],
    fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// Transaction scanning (used by the payment verifier, spec §13)
// ---------------------------------------------------------------------------

export interface RoninTxScanResult {
  transactions: RoninTransaction[];
  fetchedAt: string;
  error?: string;
}

export interface RoninTransaction {
  hash: string;
  from?: string;
  to?: string;
  valueWei: number;
  timestamp: string | null;
  direction: "incoming" | "outgoing";
}

/**
 * Fetch the most recent transactions for a Ronin address.
 *
 * The public Ronin RPC does not expose a stable, key-less transactions list
 * endpoint that we can rely on from this sandbox. The {@link
 * fetchRoninBalance} call above still works as the dashboard's primary read
 * path; the payment verifier falls back to EVM/Solana/Tron/BTC matching for
 * opportunities paid in those currencies (see
 * src/lib/wallet/payment-verifier.ts).
 *
 * Phase-2 §40, P2-23: the soft error returned here is EXPLICITLY logged as
 * "endpoint requires API key" rather than silently swallowed. The
 * {@link RoninTxScanResult.error} field carries the operator-actionable
 * message ("Use the Sky Mavis API (with key) or the Ronin Explorer for tx
 * history") and we emit a `warn`-level `wallet_ronin_txlist_unavailable`
 * event so the dashboard Events tab surfaces it.
 *
 * Never throws.
 */
export async function fetchRoninTransactions(
  _address: string,
  _opts?: { limit?: number; timeoutMs?: number }
): Promise<RoninTxScanResult> {
  const message =
    "Ronin public RPC does not expose a key-less transaction list endpoint. " +
    "Use the Sky Mavis API (with key) or the Ronin Explorer for tx history.";
  // Phase-2 §40 / P2-23: surface the soft error as a warn event so the
  // dashboard Events tab + the audit log see it. We never crash on this —
  // the payment verifier is wired to fall back to other chains.
  try {
    const { logEvent } = await import("@/lib/agent/events");
    await logEvent(
      "payment",
      "warn",
      "wallet_ronin_txlist_unavailable",
      {
        address: _address,
        reason: "endpoint requires API key",
        provider: "ronin",
        detail: message,
      },
      {}
    );
  } catch {
    // Ignore — logEvent should never throw, but guard against import failures.
  }
  return {
    transactions: [],
    fetchedAt: new Date().toISOString(),
    error: message,
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC helper
// ---------------------------------------------------------------------------

interface RpcSuccess<T> {
  jsonrpc: "2.0";
  id: number;
  result: T;
}
interface RpcError {
  jsonrpc: "2.0";
  id: number;
  error?: { code?: number; message?: string };
}

let rpcId = 0;

async function rpcCall<T>(
  method: string,
  params: unknown[],
  timeoutMs: number
): Promise<{ result?: T; error?: string }> {
  const id = ++rpcId;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(RONIN_RPC_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "CryptoEarn-Agent/0.1 (+read-only wallet monitor)",
      },
      body,
    });

    if (res.status === 429) {
      return { error: "Ronin RPC rate-limited (HTTP 429)." };
    }
    if (!res.ok) {
      const text = await safeReadText(res);
      return {
        error: `Ronin RPC HTTP ${res.status}: ${text.slice(0, 280)}`,
      };
    }

    const json = (await res.json()) as RpcSuccess<T> | RpcError;
    if ("error" in json && json.error) {
      return {
        error: `Ronin RPC error ${json.error.code ?? "?"}: ${json.error.message ?? ""}`,
      };
    }
    if ("result" in json) {
      return { result: json.result };
    }
    return { error: "Ronin RPC returned no result field." };
  } catch (err) {
    const aborted =
      err instanceof Error && err.name === "AbortError"
        ? `Ronin RPC timed out after ${timeoutMs}ms.`
        : err instanceof Error
          ? err.message
          : String(err);
    return { error: aborted };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a hex-encoded wei string (e.g. "0x0123abcd") into a JS number. */
function hexWeiToNumber(hex: string | null | undefined): number {
  if (hex === null || hex === undefined) return 0;
  const s = String(hex).trim();
  if (!s) return 0;
  try {
    if (s.startsWith("0x") || s.startsWith("0X")) {
      const n = Number(BigInt(s));
      return Number.isFinite(n) ? n : 0;
    }
    // Some endpoints return a decimal string instead of hex.
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

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// Re-exported so the wallet registry can reach TokenBalance without importing
// from a separate module (keeps the registry imports tidy).
export type { TokenBalance };
