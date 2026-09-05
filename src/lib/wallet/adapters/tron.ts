// Tron wallet adapter — via the free TronGrid public API (spec §12).
//
//   GET https://api.trongrid.io/v1/accounts/{address}
//   → {
//       data: [
//         {
//           address: "T...",
//           balance: 12345678,        // sun (1 TRX = 1e6 sun)
//           trc20: [
//             [ "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "1000000" ],
//             ...
//           ],
//           ...
//         }
//       ],
//       success: true
//     }
//
// All HTTP calls have an 8-second AbortController timeout. The adapter NEVER
// throws — on any failure it returns a zero-balance {@link WalletBalance}
// with the `error` field populated.
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

const TRONGRID_BASE =
  process.env.TRONGRID_BASE_URL ?? "https://api.trongrid.io";

const TIMEOUT_MS = 8_000;
const CHAIN: Chain = "tron";
const NATIVE_SYMBOL = NATIVE_SYMBOL_BY_CHAIN[CHAIN] ?? "TRX";
const SUN_PER_TRX = 1e6;

/** Well-known TRC-20 contract addresses → symbols (for display only). */
const KNOWN_TRC20: Record<string, string> = {
  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: "USDT",
  TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7: "BTT",
  TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3Q9: "JST",
  TLBaRhANQoJFTqre9Nf1mjuwNWjCJeYqUL: "USDD",
  1002008: "N/A", // placeholder
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the Tron balance for `address` via the free TronGrid API. Returns the
 * native TRX balance (converted from sun) plus any TRC-20 token balances.
 *
 * Never throws — failures are surfaced via the `error` field on a
 * zero-balance result so callers can degrade gracefully.
 */
export async function fetchTronBalance(
  address: string,
  opts?: { label?: string; timeoutMs?: number }
): Promise<WalletBalance> {
  const label = opts?.label ?? "Tron Wallet";
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
    return { ...zero, error: "Missing Tron address." };
  }

  const url = `${TRONGRID_BASE}/v1/accounts/${encodeURIComponent(trimmed)}`;
  const timeoutMs = Math.max(1000, opts?.timeoutMs ?? TIMEOUT_MS);

  try {
    await BudgetManager.getInstance().recordRpcRequest();
  } catch (err) {
    console.warn("[wallet/tron] budget recordRpcRequest failed:", err);
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
        error: "TronGrid rate-limited (HTTP 429).",
      };
    }
    if (!res.ok) {
      const body = await safeReadText(res);
      return {
        ...zero,
        error: `TronGrid HTTP ${res.status} ${res.statusText}: ${body.slice(0, 280)}`,
      };
    }

    const json = (await res.json()) as TronGridAccountResponse;
    const data = json?.data?.[0];
    if (!data) {
      // An address that has never appeared on-chain returns `data: []`. Treat
      // as a zero balance (this is normal for fresh wallets).
      return {
        ...zero,
        error: undefined,
      };
    }

    const sunBalance = data.balance ?? 0;
    const nativeBalance = sunBalance / SUN_PER_TRX;
    const trxPrice = NATIVE_PRICE_FALLBACK_USD.TRX ?? 0;
    const nativeUsd = nativeBalance * trxPrice;

    const tokens = parseTrc20Balances(data.trc20 ?? []);

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
        ? `TronGrid request timed out after ${timeoutMs}ms.`
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

export interface TronTxScanResult {
  transactions: TronTransaction[];
  fetchedAt: string;
  error?: string;
}

export interface TronTransaction {
  hash: string;
  from?: string;
  to?: string;
  valueSun: number; // sun (1 TRX = 1e6 sun)
  timestamp: string | null;
  direction: "incoming" | "outgoing";
}

/**
 * Fetch the most recent incoming TRX transactions for a Tron address via the
 * TronGrid `/v1/accounts/{address}/transactions` endpoint. Only native TRX
 * transfers are returned (TRC-20 needs a separate endpoint and is not part
 * of the spec §13 minimum verification path).
 *
 * Never throws — returns an empty list + `error` on failure.
 */
export async function fetchTronTransactions(
  address: string,
  opts?: { limit?: number; timeoutMs?: number }
): Promise<TronTxScanResult> {
  const fetchedAt = new Date().toISOString();
  const trimmed = (address ?? "").trim();
  const limit = Math.max(1, Math.min(opts?.limit ?? 20, 50));
  const timeoutMs = Math.max(1000, opts?.timeoutMs ?? TIMEOUT_MS);

  if (!trimmed) {
    return {
      transactions: [],
      fetchedAt,
      error: "Missing Tron address.",
    };
  }

  const url = `${TRONGRID_BASE}/v1/accounts/${encodeURIComponent(
    trimmed
  )}/transactions?limit=${limit}&order_by=block_timestamp,desc`;

  try {
    await BudgetManager.getInstance().recordRpcRequest();
  } catch (err) {
    console.warn("[wallet/tron] budget recordRpcRequest failed:", err);
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
        error: "TronGrid rate-limited (HTTP 429).",
      };
    }
    if (!res.ok) {
      const body = await safeReadText(res);
      return {
        transactions: [],
        fetchedAt,
        error: `TronGrid transactions HTTP ${res.status}: ${body.slice(0, 280)}`,
      };
    }

    const json = (await res.json()) as TronGridTxResponse;
    const items = Array.isArray(json?.data) ? json.data : [];

    const transactions: TronTransaction[] = [];
    for (const item of items.slice(0, limit)) {
      try {
        const mapped = mapTronTx(item, trimmed);
        if (mapped) transactions.push(mapped);
      } catch (err) {
        console.warn("[wallet/tron] skipping malformed tx:", err);
      }
    }

    return { transactions, fetchedAt };
  } catch (err) {
    const aborted =
      err instanceof Error && err.name === "AbortError"
        ? `TronGrid tx request timed out after ${timeoutMs}ms.`
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

/** Parse a TronGrid `trc20` array (each entry is `[contract, amountStr]`). */
function parseTrc20Balances(
  trc20: Array<[string, string] | Record<string, string>>
): TokenBalance[] {
  const out: TokenBalance[] = [];
  for (const entry of trc20 ?? []) {
    try {
      let contract = "";
      let amountStr = "0";
      if (Array.isArray(entry)) {
        contract = entry[0] ?? "";
        amountStr = entry[1] ?? "0";
      } else if (entry && typeof entry === "object") {
        // Some TronGrid responses return a single-key object {contract: amount}.
        const keys = Object.keys(entry);
        if (keys.length > 0) {
          contract = keys[0];
          amountStr = entry[contract] ?? "0";
        }
      }
      if (!contract) continue;
      const amount = parseBigIntStr(amountStr);
      if (amount === null || amount <= 0) continue;
      // Most TRC-20 tokens use 6 decimals (USDT, USDC, etc.). TronGrid does not
      // return decimals inline, so default to 6 — the dashboard will display
      // the raw amount otherwise.
      const decimals = 6;
      const balance = amount / Math.pow(10, decimals);
      const symbol = KNOWN_TRC20[contract] ?? "TRC20";
      const usdValue = symbol === "USDT" || symbol === "USDC" ? balance : 0;
      out.push({
        contract,
        symbol,
        balance,
        usdValue: round2(usdValue),
      });
    } catch (err) {
      console.warn("[wallet/tron] skipping malformed trc20 entry:", err);
    }
  }
  return out;
}

function mapTronTx(item: TronGridTx, selfAddress: string): TronTransaction | null {
  const hash = item?.transaction_id ?? item?.hash ?? "";
  if (!hash) return null;

  const selfLower = selfAddress.toLowerCase();
  const fromAddr = (item?.from ?? "").toLowerCase();
  const toAddr = (item?.to ?? "").toLowerCase();

  // Only consider native TRX transfers (contract type == 1 → Transfer).
  const amount = item?.value ?? 0;
  if (amount <= 0) return null;

  const direction: "incoming" | "outgoing" =
    toAddr === selfLower && fromAddr !== selfLower
      ? "incoming"
      : fromAddr === selfLower
        ? "outgoing"
        : "incoming";

  const ts = item?.block_timestamp ?? null;
  const timestamp = ts ? new Date(ts).toISOString() : null;

  return {
    hash,
    from: fromAddr || undefined,
    to: toAddr || undefined,
    valueSun: amount,
    timestamp,
    direction,
  };
}

function parseBigIntStr(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
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

interface TronGridAccountResponse {
  data?: Array<{
    address?: string;
    balance?: number; // sun
    trc20?: Array<[string, string] | Record<string, string>>;
  }>;
  success?: boolean;
}

interface TronGridTxResponse {
  data?: TronGridTx[];
  success?: boolean;
}

interface TronGridTx {
  transaction_id?: string;
  hash?: string;
  block_timestamp?: number | null;
  from?: string;
  to?: string;
  value?: number; // sun for native TRX transfers
  contract_type?: number;
}
