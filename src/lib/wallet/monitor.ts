// Wallet monitor subsystem (spec §12).
//
// `refreshWallets()` fetches the live balance of every monitored wallet via
// the adapter registry, persists a snapshot to `data/wallet-snapshot.json`
// (so the dashboard can read recent values without re-hitting every RPC),
// logs a `wallet_refresh` event, and returns the snapshot.
//
// `getWalletSnapshots()` returns the most recent cached snapshot (or fetches
// fresh if no cache exists).
//
// `getWalletSummary()` returns the dashboard rollup:
//
//   { wallets: WalletBalance[], totalUsd: number, fetchedAt: string }
//
// All three functions degrade gracefully: filesystem write failures are
// logged to the console but never propagated so a transient FS hiccup can't
// crash the dashboard or the orchestrator cycle.
//
// This module is READ-ONLY. It never requests, stores, or transmits private
// keys, seed phrases, or recovery phrases.

import { promises as fs } from "node:fs";
import path from "node:path";

import { logEvent } from "@/lib/agent/events";
import { canRun } from "@/lib/agent/state";
import type { WalletBalance } from "@/lib/agent/types";
import { BudgetManager } from "@/lib/budget/manager";
import { fetchAllWallets } from "@/lib/wallet/adapters";

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

interface WalletSnapshot {
  fetchedAt: string;
  wallets: WalletBalance[];
  totalUsd: number;
}

const SNAPSHOT_PATH = path.join(
  process.cwd(),
  "data",
  "wallet-snapshot.json"
);

/**
 * Refresh every monitored wallet's balance in parallel and persist a
 * snapshot to disk. The snapshot is the single source of truth for the
 * dashboard — `getWalletSnapshots` and `getWalletSummary` read from it.
 *
 * Behaviour:
 *   - If the kill switch is engaged or the budget is exhausted, the function
 *     returns the last cached snapshot (or an empty one) instead of hitting
 *     any RPC. A `wallet_refresh_skipped` event is logged.
 *   - All adapter failures are surfaced as zero-balance WalletBalance rows
 *     with `error` populated — the snapshot is still persisted.
 *   - Disk write failures are logged but never thrown.
 */
export async function refreshWallets(): Promise<WalletSnapshot> {
  // -- 1. Kill switch / state gate ------------------------------------------
  const gate = await canRun();
  if (!gate.canRun) {
    const cached = await readSnapshot().catch(() => null);
    if (cached) {
      await logEvent(
        "payment",
        "info",
        "wallet_refresh_skipped",
        { reason: gate.reason, totalUsd: cached.totalUsd },
        {}
      );
      return cached;
    }
    const empty = emptySnapshot();
    await logEvent(
      "payment",
      "info",
      "wallet_refresh_skipped",
      { reason: gate.reason, note: "no cached snapshot" },
      {}
    );
    return empty;
  }

  // -- 2. Budget gate -------------------------------------------------------
  try {
    await BudgetManager.getInstance().assertWithinBudget();
  } catch (err) {
    const cached = await readSnapshot().catch(() => null);
    const reason = err instanceof Error ? err.message : "Budget exceeded.";
    await logEvent(
      "payment",
      "warn",
      "wallet_refresh_budget_skipped",
      { reason },
      {}
    );
    return cached ?? emptySnapshot();
  }

  // -- 3. Fetch every wallet in parallel ------------------------------------
  const startedAt = Date.now();
  const wallets = await fetchAllWallets();
  const totalUsd = wallets.reduce(
    (sum, w) => sum + (Number.isFinite(w.usdValue) ? w.usdValue : 0),
    0
  );

  const snapshot: WalletSnapshot = {
    fetchedAt: new Date().toISOString(),
    wallets,
    totalUsd: round2(totalUsd),
  };

  // -- 4. Persist snapshot (best-effort) ------------------------------------
  await writeSnapshot(snapshot);

  // -- 5. Log + record execution time ---------------------------------------
  const elapsedMs = Date.now() - startedAt;
  const errored = wallets.filter((w) => !!w.error).length;
  await logEvent(
    "payment",
    errored === wallets.length ? "error" : errored > 0 ? "warn" : "info",
    "wallet_refresh",
    {
      totalUsd: snapshot.totalUsd,
      walletCount: wallets.length,
      erroredCount: errored,
      elapsedMs,
      perWallet: wallets.map((w) => ({
        chain: w.chain,
        label: w.label,
        native: w.nativeBalance,
        usd: w.usdValue,
        error: w.error ?? null,
      })),
    },
    {}
  );

  try {
    await BudgetManager.getInstance().recordExecutionTime(elapsedMs);
  } catch (err) {
    console.warn("[wallet/monitor] budget recordExecutionTime failed:", err);
  }

  return snapshot;
}

/**
 * Return the most recent cached wallet snapshot. If no snapshot file exists
 * (cold start), fetch fresh via {@link refreshWallets}. Never throws — on
 * any failure returns an empty snapshot.
 */
export async function getWalletSnapshots(): Promise<WalletSnapshot> {
  try {
    const cached = await readSnapshot();
    if (cached) return cached;
  } catch (err) {
    console.warn("[wallet/monitor] readSnapshot failed:", err);
  }
  // Cold start — fetch fresh.
  try {
    return await refreshWallets();
  } catch (err) {
    console.error("[wallet/monitor] refreshWallets failed:", err);
    return emptySnapshot();
  }
}

/**
 * Return the dashboard rollup: `{ wallets, totalUsd, fetchedAt }`. Reads
 * from the cached snapshot when present (no RPC calls), else fetches fresh.
 */
export async function getWalletSummary(): Promise<WalletSnapshot> {
  return getWalletSnapshots();
}

// ---------------------------------------------------------------------------
// Snapshot file I/O
// ---------------------------------------------------------------------------

async function readSnapshot(): Promise<WalletSnapshot | null> {
  try {
    const raw = await fs.readFile(SNAPSHOT_PATH, "utf8");
    if (!raw || !raw.trim()) return null;
    const parsed = JSON.parse(raw) as Partial<WalletSnapshot>;
    if (
      typeof parsed?.fetchedAt !== "string" ||
      !Array.isArray(parsed?.wallets)
    ) {
      return null;
    }
    return {
      fetchedAt: parsed.fetchedAt,
      wallets: parsed.wallets ?? [],
      totalUsd:
        typeof parsed.totalUsd === "number"
          ? parsed.totalUsd
          : round2(
              (parsed.wallets ?? []).reduce(
                (s, w) => s + (Number.isFinite(w?.usdValue) ? w.usdValue : 0),
                0
              )
            ),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENODATA") return null;
    // Re-throw unexpected FS errors so the caller can decide what to do.
    throw err;
  }
}

async function writeSnapshot(snapshot: WalletSnapshot): Promise<void> {
  try {
    await fs.mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
    await fs.writeFile(
      SNAPSHOT_PATH,
      JSON.stringify(snapshot, null, 2),
      "utf8"
    );
  } catch (err) {
    console.error("[wallet/monitor] failed to write snapshot:", err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySnapshot(): WalletSnapshot {
  return {
    fetchedAt: new Date().toISOString(),
    wallets: [],
    totalUsd: 0,
  };
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { fetchAllWallets, getAdapter, WALLET_ADAPTERS } from "@/lib/wallet/adapters";
