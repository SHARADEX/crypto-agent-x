"use client";

// WalletsTab — shows the 5 monitored chain wallets (Ronin, EVM, Bitcoin,
// Solana, Tron) as cards, plus the recent transactions table below.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  AlertCircle,
  Bitcoin,
  Coins,
} from "lucide-react";
import {
  api,
  chainColor,
  formatRelativeTime,
  formatUsd,
  truncateAddress,
} from "./lib/api";
import { cn } from "@/lib/utils";

export function WalletsTab() {
  const qc = useQueryClient();

  const { data: balances, isLoading, error } = useQuery({
    queryKey: ["wallet-balances"],
    queryFn: () => api.wallet.balances(),
    refetchInterval: 60_000,
  });

  const { data: txs } = useQuery({
    queryKey: ["wallet-transactions"],
    queryFn: () => api.wallet.transactions({ limit: 50 }),
    refetchInterval: 30_000,
  });

  const refreshMut = useMutation({
    mutationFn: () => api.wallet.balances(),
    onSuccess: () => {
      toast.success("Wallet balances refreshed.");
      qc.invalidateQueries({ queryKey: ["wallet-balances"] });
    },
    onError: (e) => toast.error(`Refresh failed: ${e.message}`),
  });

  if (error) {
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
        Failed to load wallets: {String(error)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Total portfolio card */}
      <Card className="p-4 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="rounded-md bg-emerald-500/15 p-2 text-emerald-700 dark:text-emerald-300">
              <Coins className="size-5" />
            </span>
            <div>
              <div className="text-xs text-muted-foreground">Total Portfolio Value (USD)</div>
              <div className="text-2xl font-semibold tabular-nums">
                {isLoading ? (
                  <Skeleton className="h-7 w-32" />
                ) : (
                  formatUsd(balances?.totalUsd ?? 0)
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              Updated{" "}
              {balances?.fetchedAt
                ? formatRelativeTime(balances.fetchedAt)
                : "—"}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => refreshMut.mutate()}
              disabled={refreshMut.isPending}
            >
              {refreshMut.isPending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              Refresh Wallets
            </Button>
          </div>
        </div>
      </Card>

      {/* Wallet cards grid */}
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="p-4 py-4">
              <Skeleton className="h-36 w-full" />
            </Card>
          ))
        ) : (balances?.wallets ?? []).length === 0 ? (
          <Card className="col-span-full border-dashed p-8">
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Coins className="size-5" />
              </span>
              <p className="text-sm font-medium">No monitored wallets configured</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Add wallet addresses in <code className="font-mono text-[10px]">src/config/wallets.ts</code> —
                read-only monitoring, no private keys required.
              </p>
            </div>
          </Card>
        ) : (
          balances?.wallets.map((w) => (
            <WalletCard key={`${w.chain}-${w.address}`} wallet={w} />
          ))
        )}
      </div>

      {/* Transactions table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recent Transactions</CardTitle>
          <CardDescription>
            Latest 50 transactions across all monitored wallets
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-[500px] overflow-y-auto scrollbar-thin rounded-md border border-border/60">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead className="text-xs">Direction</TableHead>
                  <TableHead className="text-xs">Tx Hash</TableHead>
                  <TableHead className="text-xs">Chain</TableHead>
                  <TableHead className="hidden md:table-cell text-xs">From → To</TableHead>
                  <TableHead className="text-right text-xs">Amount</TableHead>
                  <TableHead className="text-right text-xs">USD</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="hidden lg:table-cell text-xs">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(txs?.transactions ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-14">
                      <div className="flex flex-col items-center gap-2 text-center">
                        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                          <ArrowDownLeft className="size-5" />
                        </span>
                        <p className="text-sm font-medium text-muted-foreground">
                          No transactions recorded yet
                        </p>
                        <p className="max-w-sm text-xs text-muted-foreground/70">
                          Incoming bounty payments will appear here once the
                          agent starts completing work — verified on-chain.
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  (txs?.transactions ?? []).map((tx) => {
                    const ch = chainColor(tx.chain);
                    return (
                      <TableRow key={tx.id} className="hover:bg-muted/40">
                        <TableCell>
                          {tx.direction === "incoming" ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                              <ArrowDownLeft className="size-3" />
                              <span className="text-[10px]">in</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                              <ArrowUpRight className="size-3" />
                              <span className="text-[10px]">out</span>
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-[10px]">
                          {truncateAddress(tx.txHash, 8, 6)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn("uppercase", ch.bg, ch.text, ch.border)}
                          >
                            {tx.chain}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden md:table-cell font-mono text-[10px] text-muted-foreground">
                          {truncateAddress(tx.fromAddress, 6, 4)} → {truncateAddress(tx.toAddress, 6, 4)}
                        </TableCell>
                        <TableCell className="text-right text-xs font-medium tabular-nums">
                          {tx.amount.toFixed(6)} <span className="text-muted-foreground">{tx.currency}</span>
                        </TableCell>
                        <TableCell className="text-right text-xs font-semibold tabular-nums">
                          {formatUsd(tx.usdValue)}
                        </TableCell>
                        <TableCell>
                          {tx.matched || tx.verified ? (
                            <Badge
                              variant="outline"
                              className="border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            >
                              <CheckCircle2 className="size-3" /> matched
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-400"
                            >
                              pending
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                          {formatRelativeTime(tx.createdAt)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function WalletCard({
  wallet,
}: {
  wallet: Awaited<ReturnType<typeof api.wallet.balances>>["wallets"][number];
}) {
  const ch = chainColor(wallet.chain);
  const [copied, setCopied] = React.useState(false);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be blocked in sandboxed iframes.
    }
  };

  const explorerUrl = (() => {
    const chain = wallet.chain;
    switch (chain) {
      case "ethereum": return `https://etherscan.io/address/${wallet.address}`;
      case "bitcoin": return `https://blockchain.info/address/${wallet.address}`;
      case "solana": return `https://solscan.io/account/${wallet.address}`;
      case "tron": return `https://tronscan.org/#/address/${wallet.address}`;
      case "ronin": return `https://app.roninchain.com/address/${wallet.address}`;
      default: return `https://etherscan.io/address/${wallet.address}`;
    }
  })();

  return (
    <Card className="card-hover-lift p-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={cn("rounded-lg p-2", ch.bg, ch.text)}>
            <Bitcoin className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{wallet.label}</div>
            <Badge
              variant="outline"
              className={cn("mt-0.5 uppercase text-[10px]", ch.bg, ch.text, ch.border)}
            >
              {wallet.chain}
            </Badge>
          </div>
        </div>
        {wallet.error ? (
          <Badge
            variant="outline"
            className="border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300"
            title={wallet.error}
          >
            <AlertCircle className="size-3" /> error
          </Badge>
        ) : null}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <code className="font-mono text-xs text-muted-foreground truncate">
          {truncateAddress(wallet.address, 10, 8)}
        </code>
        <div className="flex items-center gap-0.5">
          {/* Muted utility icons — quiet until hovered (v2 polish) */}
          <button
            type="button"
            onClick={copy}
            aria-label="Copy address"
            className="rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            {copied ? (
              <CheckCircle2 className="size-3 text-emerald-500" />
            ) : (
              <Copy className="size-3" />
            )}
          </button>
          <Button asChild size="sm" variant="ghost" className="h-7 w-7 px-0 text-muted-foreground/60 transition-colors hover:text-accent-foreground">
            <a href={explorerUrl} target="_blank" rel="noreferrer noopener" aria-label="View on explorer">
              <ExternalLink className="size-3" />
            </a>
          </Button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Native</div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums">
            {wallet.nativeBalance.toFixed(4)}{" "}
            <span className="text-xs font-normal text-muted-foreground">{wallet.nativeSymbol}</span>
          </div>
        </div>
        <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">USD Value</div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums">
            {formatUsd(wallet.usdValue)}
          </div>
        </div>
      </div>

      {wallet.tokens.length > 0 ? (
        <div className="mt-4 space-y-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Tokens</div>
          <div className="max-h-32 overflow-y-auto scrollbar-thin space-y-1">
            {wallet.tokens.map((t) => (
              <div
                key={`${t.contract}-${t.symbol}`}
                className="flex items-center justify-between text-xs"
              >
                <span className="font-mono text-[10px] text-muted-foreground">
                  {truncateAddress(t.contract, 6, 4)} · {t.symbol}
                </span>
                <span className="tabular-nums">
                  {t.balance.toFixed(4)}{" "}
                  <span className="text-muted-foreground">
                    ({formatUsd(t.usdValue)})
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-4 border-t border-border/40 pt-2.5 text-[10px] text-muted-foreground/60">
        Fetched {formatRelativeTime(wallet.fetchedAt)}
      </div>
    </Card>
  );
}
