// Solana wallet adapter — via the free public RPC endpoint (spec §12).
//
//   POST https://api.mainnet-beta.solana.com
//   JSON-RPC body:
//     { "jsonrpc": "2.0", "id": 1, "method": "getBalance",
//       "params": ["<address>"] }
//   → { result: { value: <lamports> } }
//
//   POST https://api.mainnet-beta.solana.com
//   JSON-RPC body:
//     { "jsonrpc": "2.0", "id": 1, "method": "getTokenAccountsByOwner",
//       "params": ["<address>",
//         { "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
//         { "encoding": "jsonParsed" }] }
//   → { result: { value: [
//        { account: { data: { parsed: { info: {
//            mint, tokenAmount: { amount, decimals } } } } } }
//      ] } }
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

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const TIMEOUT_MS = 8_000;
const CHAIN: Chain = "solana";
const NATIVE_SYMBOL = NATIVE_SYMBOL_BY_CHAIN[CHAIN] ?? "SOL";
const LAMPORTS_PER_SOL = 1e9;

/** The SPL Token program ID (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA). */
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the Solana balance for `address` via the public JSON-RPC endpoint.
 * Returns the native SOL balance (converted from lamports) plus any SPL token
 * balances owned by the address.
 *
 * Never throws — failures are surfaced via the `error` field on a
 * zero-balance result so callers can degrade gracefully.
 */
export async function fetchSolanaBalance(
  address: string,
  opts?: { label?: string; timeoutMs?: number }
): Promise<WalletBalance> {
  const label = opts?.label ?? "Solana Wallet";
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
    return { ...zero, error: "Missing Solana address." };
  }

  const timeoutMs = Math.max(1000, opts?.timeoutMs ?? TIMEOUT_MS);

  // Record one RPC call per logical balance check (the two JSON-RPC requests
  // are both part of the same logical "fetch balance" operation).
  try {
    await BudgetManager.getInstance().recordRpcRequest();
  } catch (err) {
    console.warn("[wallet/solana] budget recordRpcRequest failed:", err);
  }

  // -- 1. Native SOL balance via getBalance --------------------------------
  const balanceRes = await rpcCall<{ value: number }>(
    "getBalance",
    [trimmed],
    timeoutMs
  );
  if (balanceRes.error) {
    return { ...zero, error: balanceRes.error };
  }
  const lamports = balanceRes.result?.value ?? 0;
  const nativeBalance = lamports / LAMPORTS_PER_SOL;
  const solPrice = NATIVE_PRICE_FALLBACK_USD.SOL ?? 0;
  const nativeUsd = nativeBalance * solPrice;

  // -- 2. SPL token balances via getTokenAccountsByOwner -------------------
  // The RPC returns `{ context: { slot }, value: [...] }`. We type the
  // `value` field as the array we care about and unwrap it before parsing.
  const tokenRes = await rpcCall<{
    context?: { slot?: number };
    value?: Array<{
      account?: {
        data?: {
          parsed?: {
            info?: {
              mint?: string;
              tokenAmount?: { amount?: string; decimals?: number };
            };
          };
        };
      };
    }>;
  }>(
    "getTokenAccountsByOwner",
    [
      trimmed,
      { programId: TOKEN_PROGRAM_ID },
      { encoding: "jsonParsed" },
    ],
    timeoutMs
  );

  let tokens: TokenBalance[] = [];
  if (tokenRes.error) {
    // Token fetch failure is non-fatal — we still have the native balance.
    // Record the soft error in the WalletBalance.error field only when the
    // native balance also happened to be zero.
    if (nativeBalance === 0) {
      return {
        ...zero,
        nativeBalance: 0,
        usdValue: 0,
        error: `SPL token fetch failed: ${tokenRes.error}`,
      };
    }
  } else {
    const accounts = tokenRes.result?.value ?? [];
    tokens = parseSplTokenAccounts(accounts);
  }

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
}

// ---------------------------------------------------------------------------
// Transaction scanning (used by the payment verifier, spec §13)
// ---------------------------------------------------------------------------

export interface SolanaTxScanResult {
  transactions: SolanaTransaction[];
  fetchedAt: string;
  error?: string;
}

export interface SolanaTransaction {
  hash: string;
  from?: string;
  to?: string;
  valueLamports: number;
  timestamp: string | null;
  direction: "incoming" | "outgoing";
}

/**
 * Fetch the most recent transaction signatures for a Solana address and
 * attempt to extract incoming native transfer amounts. Solana's public RPC
 * does not return transaction history in a single call — we use
 * `getSignaturesForAddress` + `getTransaction` for each, capped at `limit`.
 *
 * Never throws — returns an empty list + `error` on failure.
 */
export async function fetchSolanaTransactions(
  address: string,
  opts?: { limit?: number; timeoutMs?: number }
): Promise<SolanaTxScanResult> {
  const fetchedAt = new Date().toISOString();
  const trimmed = (address ?? "").trim();
  const limit = Math.max(1, Math.min(opts?.limit ?? 10, 20));
  const timeoutMs = Math.max(1000, opts?.timeoutMs ?? TIMEOUT_MS);

  if (!trimmed) {
    return {
      transactions: [],
      fetchedAt,
      error: "Missing Solana address.",
    };
  }

  try {
    await BudgetManager.getInstance().recordRpcRequest();
  } catch (err) {
    console.warn("[wallet/solana] budget recordRpcRequest failed:", err);
  }

  // 1. Get signatures for the address (most recent first).
  const sigRes = await rpcCall<
    Array<{ signature?: string; blockTime?: number | null; err?: unknown }>
  >("getSignaturesForAddress", [trimmed, { limit }], timeoutMs);

  if (sigRes.error) {
    return { transactions: [], fetchedAt, error: sigRes.error };
  }

  const sigs = sigRes.result ?? [];
  const transactions: SolanaTransaction[] = [];

  // 2. For each signature, fetch the parsed transaction and look for native
  //    SOL transfers to/from our address.
  for (const sig of sigs) {
    const signature = sig?.signature;
    if (!signature) continue;
    try {
      const txRes = await rpcCall<{
        blockTime?: number | null;
        meta?: {
          preTokenBalances?: unknown;
          postTokenBalances?: unknown;
          err?: unknown;
        };
        transaction?: {
          message?: {
            accountKeys?: string[];
            instructions?: Array<{
              programId?: string;
              parsed?: {
                type?: string;
                info?: { source?: string; destination?: string; lamports?: number };
              };
            }>;
          };
        };
      }>(
        "getTransaction",
        [signature, { maxSupportedTransactionVersion: 0 }],
        timeoutMs
      );
      if (txRes.error || !txRes.result) continue;
      const tx = txRes.result;
      const instruction = findNativeTransferInstruction(tx, trimmed);
      if (!instruction) continue;
      const lamports = instruction.lamports ?? 0;
      if (lamports <= 0) continue;
      const direction: "incoming" | "outgoing" =
        instruction.destination?.toLowerCase() === trimmed.toLowerCase()
          ? "incoming"
          : "outgoing";
      transactions.push({
        hash: signature,
        from: instruction.source,
        to: instruction.destination,
        valueLamports: lamports,
        timestamp: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
        direction,
      });
    } catch (err) {
      console.warn("[wallet/solana] failed to fetch tx:", signature, err);
    }
  }

  return { transactions, fetchedAt };
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
    const res = await fetch(SOLANA_RPC_URL, {
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
      return { error: "Solana RPC rate-limited (HTTP 429)." };
    }
    if (!res.ok) {
      const text = await safeReadText(res);
      return {
        error: `Solana RPC HTTP ${res.status}: ${text.slice(0, 280)}`,
      };
    }

    const json = (await res.json()) as RpcSuccess<T> | RpcError;
    if ("error" in json && json.error) {
      return {
        error: `Solana RPC error ${json.error.code ?? "?"}: ${json.error.message ?? ""}`,
      };
    }
    if ("result" in json) {
      return { result: json.result };
    }
    return { error: "Solana RPC returned no result field." };
  } catch (err) {
    const aborted =
      err instanceof Error && err.name === "AbortError"
        ? `Solana RPC timed out after ${timeoutMs}ms.`
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

function parseSplTokenAccounts(
  accounts: Array<{
    account?: {
      data?: {
        parsed?: {
          info?: {
            mint?: string;
            tokenAmount?: { amount?: string; decimals?: number };
          };
        };
      };
    };
  }>
): TokenBalance[] {
  const out: TokenBalance[] = [];
  // Defense-in-depth: even though we unwrap `result.value` at the call site,
  // guard against any non-iterable input from a malformed RPC response.
  if (!Array.isArray(accounts)) return out;
  for (const entry of accounts) {
    try {
      const info = entry?.account?.data?.parsed?.info;
      const mint = info?.mint ?? "";
      const amountStr = info?.tokenAmount?.amount ?? "0";
      const decimals = info?.tokenAmount?.decimals ?? 0;
      const amount = parseBigIntStr(amountStr);
      if (amount === null || amount <= 0) continue;
      const balance = amount / Math.pow(10, decimals);
      out.push({
        contract: mint,
        symbol: "SPL",
        balance,
        usdValue: 0, // SPL token USD prices need a price feed — out of scope.
      });
    } catch (err) {
      console.warn("[wallet/solana] skipping malformed SPL account:", err);
    }
  }
  return out;
}

function findNativeTransferInstruction(
  tx: {
    transaction?: {
      message?: {
        accountKeys?: string[];
        instructions?: Array<{
          programId?: string;
          parsed?: {
            type?: string;
            info?: { source?: string; destination?: string; lamports?: number };
          };
        }>;
      };
    };
  },
  selfAddress: string
):
  | { source?: string; destination?: string; lamports?: number }
  | null {
  const instructions = tx?.transaction?.message?.instructions ?? [];
  const accountKeys = tx?.transaction?.message?.accountKeys ?? [];
  // System program's `transfer` instruction has parsed.type === "transfer".
  for (const ix of instructions) {
    const parsed = ix?.parsed;
    if (!parsed) continue;
    if (parsed.type !== "transfer") continue;
    const info = parsed.info ?? {};
    const source = info.source ?? accountKeys[0];
    const destination = info.destination ?? accountKeys[1];
    const lamports = info.lamports ?? 0;
    if (
      destination?.toLowerCase() === selfAddress.toLowerCase() ||
      source?.toLowerCase() === selfAddress.toLowerCase()
    ) {
      return { source, destination, lamports };
    }
  }
  return null;
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
