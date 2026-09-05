// Wallet adapter registry (spec §12).
//
// Each adapter is a single async function:
//
//   (address: string) => Promise<WalletBalance>
//
// that NEVER throws — failures are surfaced as zero-balance WalletBalance
// rows with the `error` field populated. The registry exposes:
//
//   - `WALLET_ADAPTERS`     — chain → adapter function map
//   - `getAdapter(chain)`   — pick the right adapter (returns undefined if
//                             the chain has no adapter)
//   - `fetchAllWallets()`   — run every adapter in parallel via
//                             Promise.allSettled over the WALLETS config
//
// Promise.allSettled means a single adapter crash never blocks the others —
// the dashboard always gets a full row of balances (some may be zero with
// `error` populated).

import { WALLETS } from "@/config/wallets";
import type { Chain, WalletBalance } from "@/lib/agent/types";
import { fetchEvmBalance } from "@/lib/wallet/adapters/evm";
import { fetchBitcoinBalance } from "@/lib/wallet/adapters/bitcoin";
import { fetchSolanaBalance } from "@/lib/wallet/adapters/solana";
import { fetchTronBalance } from "@/lib/wallet/adapters/tron";
import { fetchRoninBalance } from "@/lib/wallet/adapters/ronin";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type WalletAdapterFn = (
  address: string,
  opts?: { label?: string; timeoutMs?: number }
) => Promise<WalletBalance>;

export const WALLET_ADAPTERS: Partial<Record<Chain, WalletAdapterFn>> = {
  ethereum: fetchEvmBalance,
  bitcoin: fetchBitcoinBalance,
  solana: fetchSolanaBalance,
  tron: fetchTronBalance,
  ronin: fetchRoninBalance,
  // polygon / bsc / arbitrum / optimism fall through to fetchEvmBalance in a
  // future expansion (Blockscout serves multiple chains at different hosts).
};

/**
 * Return the adapter for the given chain, or `undefined` if no adapter is
 * registered.
 */
export function getAdapter(chain: Chain): WalletAdapterFn | undefined {
  return WALLET_ADAPTERS[chain];
}

// ---------------------------------------------------------------------------
// Parallel fetch
// ---------------------------------------------------------------------------

/**
 * Fetch balances for every wallet configured in `WALLETS` (src/config/wallets.ts),
 * running each adapter in parallel via `Promise.allSettled`. A failed adapter
 * (or one whose chain has no adapter) yields a zero-balance WalletBalance with
 * the `error` field populated — the dashboard always gets one row per wallet.
 *
 * @returns an array of {@link WalletBalance}, positionally aligned with
 *          `WALLETS`. The returned array length always equals `WALLETS.length`.
 */
export async function fetchAllWallets(): Promise<WalletBalance[]> {
  const tasks = WALLETS.map(async (w) => {
    const adapter = getAdapter(w.chain);
    if (!adapter) {
      return {
        label: w.label,
        chain: w.chain,
        address: w.address,
        nativeBalance: 0,
        nativeSymbol: w.chain.toUpperCase(),
        usdValue: 0,
        tokens: [],
        fetchedAt: new Date().toISOString(),
        error: `No adapter registered for chain '${w.chain}'.`,
      } satisfies WalletBalance;
    }
    try {
      return await adapter(w.address, { label: w.label });
    } catch (err) {
      // Adapters are supposed to never throw, but we harden the boundary
      // anyway — a future buggy adapter must not crash the whole fetch.
      const message =
        err instanceof Error ? err.message : String(err);
      return {
        label: w.label,
        chain: w.chain,
        address: w.address,
        nativeBalance: 0,
        nativeSymbol: w.chain.toUpperCase(),
        usdValue: 0,
        tokens: [],
        fetchedAt: new Date().toISOString(),
        error: `Adapter crashed: ${message}`,
      };
    }
  });

  const settled = await Promise.allSettled(tasks);
  return settled.map((s, idx) => {
    if (s.status === "fulfilled") return s.value;
    const w = WALLETS[idx];
    const message =
      s.reason instanceof Error ? s.reason.message : String(s.reason);
    return {
      label: w.label,
      chain: w.chain,
      address: w.address,
      nativeBalance: 0,
      nativeSymbol: w.chain.toUpperCase(),
      usdValue: 0,
      tokens: [],
      fetchedAt: new Date().toISOString(),
      error: `Adapter rejected: ${message}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { fetchEvmBalance } from "@/lib/wallet/adapters/evm";
export { fetchBitcoinBalance } from "@/lib/wallet/adapters/bitcoin";
export { fetchSolanaBalance } from "@/lib/wallet/adapters/solana";
export { fetchTronBalance } from "@/lib/wallet/adapters/tron";
export { fetchRoninBalance } from "@/lib/wallet/adapters/ronin";
