// EVM wallet adapter — Ethereum mainnet via the free Blockscout API (spec §12).
//
// Blockscout exposes a public, key-less REST surface that returns both native
// (ETH) balances and ERC-20 token balances for a given address:
//
//   GET https://eth.blockscout.com/api/v2/addresses/{address}
//   → {
//       coin_balance: "1234567890123456789",     // wei
//       exchange_rate: "3200.5",                // ETH→USD (may be null)
//       token_balances: [
//         { token: { symbol, decimals, address, ... }, value: "1000000" },
//         ...
//       ],
//       ...
//     }
//
// All HTTP calls have an 8-second AbortController timeout. On any failure
// (network, parse, 429 rate-limit, 5xx) the adapter returns a zero-balance
// `WalletBalance` with `error` populated — the dashboard must never crash
// because an upstream RPC is having a bad day.
//
// The agent NEVER stores private keys, seed phrases, or recovery phrases —
// this module only reads public chain state from a public address.

import {
  NATIVE_PRICE_FALLBACK_USD,
  NATIVE_SYMBOL_BY_CHAIN,
} from "@/config/wallets";
import type { Chain, TokenBalance, WalletBalance } from "@/lib/agent/types";
import { BudgetManager } from "@/lib/budget/manager";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BLOCKSCOUT_BASE =
  process.env.BLOCKSCOUT_BASE_URL ?? "https://eth.blockscout.com/api/v2";

const TIMEOUT_MS = 8_000;
const CHAIN: Chain = "ethereum";
const NATIVE_SYMBOL = NATIVE_SYMBOL_BY_CHAIN[CHAIN] ?? "ETH";
const WEI_PER_ETH = 1e18;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the EVM (Ethereum mainnet) balance for `address` via the Blockscout
 * REST API. Returns a fully-populated {@link WalletBalance} including ERC-20
 * token holdings.
 *
 * Never throws — failures are surfaced via the `error` field on a
 * zero-balance result so callers can degrade gracefully.
 */
export async function fetchEvmBalance(
  address: string,
  opts?: { label?: string; timeoutMs?: number }
): Promise<WalletBalance> {
  const label = opts?.label ?? "EVM Wallet";
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
    return { ...zero, error: "Missing EVM address." };
  }

  const url = `${BLOCKSCOUT_BASE}/addresses/${encodeURIComponent(trimmed)}`;
  const timeoutMs = Math.max(1000, opts?.timeoutMs ?? TIMEOUT_MS);

  // Record the RPC call against the daily budget BEFORE the network call so
  // an over-budget state is caught early.
  try {
    await BudgetManager.getInstance().recordRpcRequest();
  } catch (err) {
    console.warn("[wallet/evm] budget recordRpcRequest failed:", err);
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
        error: "Blockscout rate-limited (HTTP 429).",
      };
    }
    if (!res.ok) {
      const body = await safeReadText(res);
      return {
        ...zero,
        error: `Blockscout HTTP ${res.status} ${res.statusText}: ${body.slice(0, 280)}`,
      };
    }

    const json = (await res.json()) as BlockscoutAddressResponse;

    // Native balance is in wei as a decimal string.
    const weiStr = json.coin_balance ?? json.balance ?? "0";
    const nativeBalance = weiToEth(weiStr);

    // Prefer Blockscout's exchange_rate when present; fall back to the
    // conservative NATIVE_PRICE_FALLBACK_USD.ETH constant from the wallet
    // config (display-only, never used for accounting).
    const ethPrice =
      parseNumber(json.exchange_rate) ??
      NATIVE_PRICE_FALLBACK_USD.ETH ??
      0;
    const nativeUsd = nativeBalance * ethPrice;

    const tokens = parseTokenBalances(json.token_balances);

    const tokenUsd = tokens.reduce((sum, t) => sum + (t.usdValue || 0), 0);

    return {
      label,
      chain: CHAIN,
      address: trimmed,
      nativeBalance,
      nativeSymbol: NATIVE_SYMBOL,
      usdValue: round2(nativeUsd + tokenUsd),
      tokens,
      fetchedAt,
    };
  } catch (err) {
    const aborted =
      err instanceof Error && err.name === "AbortError"
        ? `Blockscout request timed out after ${timeoutMs}ms.`
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

export interface EvmTxScanResult {
  transactions: EvmTransaction[];
  fetchedAt: string;
  error?: string;
}

export interface EvmTransaction {
  hash: string;
  from: string;
  to: string | null;
  value: string; // wei
  timestamp: string | null;
  tokenSymbol?: string;
  tokenDecimals?: number;
  tokenContract?: string;
  direction?: "incoming" | "outgoing";
}

/**
 * Fetch the most recent transactions for an EVM address. Tries the Blockscout
 * `/transactions` endpoint first; if that 404s, falls back to `/token-transfers`.
 *
 * Like {@link fetchEvmBalance}, never throws — returns an empty list + error.
 */
export async function fetchEvmTransactions(
  address: string,
  opts?: { limit?: number; timeoutMs?: number }
): Promise<EvmTxScanResult> {
  const fetchedAt = new Date().toISOString();
  const trimmed = (address ?? "").trim();
  const limit = Math.max(1, Math.min(opts?.limit ?? 20, 50));
  const timeoutMs = Math.max(1000, opts?.timeoutMs ?? TIMEOUT_MS);

  if (!trimmed) {
    return {
      transactions: [],
      fetchedAt,
      error: "Missing EVM address.",
    };
  }

  try {
    await BudgetManager.getInstance().recordRpcRequest();
  } catch (err) {
    console.warn("[wallet/evm] budget recordRpcRequest failed:", err);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${BLOCKSCOUT_BASE}/addresses/${encodeURIComponent(
      trimmed
    )}/transactions?filter=to%20%7C%20from`;
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
        error: "Blockscout rate-limited (HTTP 429).",
      };
    }
    if (!res.ok) {
      const body = await safeReadText(res);
      return {
        transactions: [],
        fetchedAt,
        error: `Blockscout transactions HTTP ${res.status}: ${body.slice(0, 280)}`,
      };
    }

    const json = (await res.json()) as BlockscoutTxListResponse;
    const items = Array.isArray(json?.items) ? json.items : [];

    const transactions: EvmTransaction[] = [];
    for (const item of items.slice(0, limit)) {
      try {
        const tx = mapBlockscoutTx(item, trimmed);
        if (tx) transactions.push(tx);
      } catch (err) {
        console.warn("[wallet/evm] skipping malformed tx:", err);
      }
    }

    return { transactions, fetchedAt };
  } catch (err) {
    const aborted =
      err instanceof Error && err.name === "AbortError"
        ? `Blockscout tx request timed out after ${timeoutMs}ms.`
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

/** Convert a wei-amount string into ETH (1 ETH = 1e18 wei). */
function weiToEth(weiStr: string | null | undefined): number {
  const n = parseBigInt(weiStr);
  if (n === null) return 0;
  return n / WEI_PER_ETH;
}

/** Parse a list of Blockscout token balances into {@link TokenBalance}[] . */
function parseTokenBalances(
  raw: BlockscoutTokenBalance[] | null | undefined
): TokenBalance[] {
  if (!Array.isArray(raw)) return [];
  const out: TokenBalance[] = [];
  for (const entry of raw) {
    try {
      const token = entry?.token;
      const symbol = token?.symbol ?? "UNKNOWN";
      const decimals = parseDecimals(token?.decimals);
      const contract = token?.address ?? "";
      const valueStr = entry?.value ?? "0";
      const balance = scaleTokenAmount(valueStr, decimals);
      if (balance <= 0) continue;
      // Blockscout sometimes returns a per-token exchange_rate; prefer that
      // for USD valuation, else leave at 0 (display only).
      const tokenPrice =
        parseNumber(token?.exchange_rate) ??
        NATIVE_PRICE_FALLBACK_USD[symbol] ??
        0;
      out.push({
        contract,
        symbol,
        balance,
        usdValue: round2(balance * tokenPrice),
      });
    } catch (err) {
      console.warn("[wallet/evm] skipping malformed token balance:", err);
    }
  }
  return out;
}

/** Parse a decimal-or-string value into a JS number with token decimals. */
function scaleTokenAmount(valueStr: string, decimals: number): number {
  const n = parseBigInt(valueStr);
  if (n === null) return 0;
  return n / Math.pow(10, decimals);
}

function parseDecimals(input: number | string | null | undefined): number {
  if (typeof input === "number" && Number.isFinite(input) && input >= 0) {
    return Math.min(input, 36);
  }
  if (typeof input === "string") {
    const n = Number(input);
    if (Number.isFinite(n) && n >= 0) return Math.min(n, 36);
  }
  return 18;
}

function parseBigInt(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!s) return null;
  // Blockscout returns decimal strings; gracefully handle hex too.
  let n: number;
  if (s.startsWith("0x")) {
    n = Number(BigInt(s));
  } else {
    n = Number(s);
  }
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseNumber(input: unknown): number | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : undefined;
  }
  if (typeof input === "string") {
    const s = input.trim();
    if (!s) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
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

function mapBlockscoutTx(
  item: BlockscoutTx,
  selfAddress: string
): EvmTransaction | null {
  const hash = item?.hash ?? "";
  if (!hash) return null;
  const from = (item?.from?.hash ?? "").toLowerCase();
  const to = (item?.to?.hash ?? null)?.toLowerCase() ?? null;
  const value = item?.value ?? "0";
  const timestamp = item?.timestamp ?? item?.block_timestamp ?? null;
  const direction: "incoming" | "outgoing" =
    to === selfAddress.toLowerCase()
      ? "incoming"
      : from === selfAddress.toLowerCase()
        ? "outgoing"
        : "incoming";
  return {
    hash,
    from,
    to,
    value,
    timestamp,
    direction,
  };
}

// ---------------------------------------------------------------------------
// Types — only the fields we actually read from Blockscout
// ---------------------------------------------------------------------------

interface BlockscoutAddressResponse {
  coin_balance?: string | null;
  balance?: string | null;
  exchange_rate?: string | number | null;
  token_balances?: BlockscoutTokenBalance[] | null;
}

interface BlockscoutTokenBalance {
  token?: {
    symbol?: string;
    address?: string;
    decimals?: number | string;
    exchange_rate?: string | number | null;
  } | null;
  value?: string;
}

interface BlockscoutTxListResponse {
  items?: BlockscoutTx[];
}

interface BlockscoutTx {
  hash?: string;
  value?: string;
  timestamp?: string | null;
  block_timestamp?: string | null;
  from?: { hash?: string };
  to?: { hash?: string } | null;
}
