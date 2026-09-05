"use client";

// LedgerTab v2 — earnings ledger with totals cards, strategy chart and the
// verified / expected sections.
//
// Redesign (from VLM 7/10):
//   1. Totals cards → v2 primitives (uppercase tracking labels, accent icons,
//      tabular-nums, hover lift)
//   2. Strategy chart → emerald monochrome scale instead of rainbow; rounded
//      bars, compact Y ticks, richer tooltip (net / gross / count)
//   3. Designed empty states — ghost icon + guiding copy + CTA (no more bare
//      flatline text); rows get a status accent border
//

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Coins,
  ExternalLink,
  GitBranch,
  Landmark,
  Receipt,
  ShieldCheck,
  Timer,
  TrendingUp,
  Wallet2,
} from "lucide-react";
import {
  api,
  formatRelativeTime,
  formatUsd,
} from "./lib/api";
import { cn } from "@/lib/utils";

// Emerald monochrome scale (dark → light) — replaces the rainbow palette.
const BAR_SCALE = [
  "#059669",
  "#10b981",
  "#34d399",
  "#6ee7b7",
  "#a7f3d0",
  "#0d9488",
  "#14b8a6",
  "#2dd4bf",
  "#5eead4",
  "#99f6e4",
];

export function LedgerTab() {
  const { data: totalsData, isLoading: totalsLoading } = useQuery({
    queryKey: ["ledger", "totals"],
    queryFn: () => api.ledger.totals(),
    refetchInterval: 30_000,
  });

  const { data: verifiedData, isLoading: verifiedLoading } = useQuery({
    queryKey: ["ledger", "verified"],
    queryFn: () => api.ledger.list({ verified: true, limit: 50 }),
    refetchInterval: 30_000,
  });

  const { data: expectedData, isLoading: expectedLoading } = useQuery({
    queryKey: ["ledger", "expected"],
    queryFn: () => api.ledger.list({ verified: false, limit: 50 }),
    refetchInterval: 30_000,
  });

  const totals = totalsData?.totals;

  const byStrategy = React.useMemo(() => {
    if (!totals) return [];
    const stratMap = (totals.byStrategy ?? {}) as Record<string, { count: number; netUsd: number; grossUsd: number }>;
    return Object.entries(stratMap)
      .map(([strategy, v]) => ({
        strategy,
        netUsd: v.netUsd ?? 0,
        grossUsd: v.grossUsd ?? 0,
        count: v.count ?? 0,
      }))
      .sort((a, b) => b.netUsd - a.netUsd)
      .slice(0, 10);
  }, [totals]);

  return (
    <div className="space-y-4 pb-2">
      {/* Totals cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <TotalsCard
          label="Gross"
          value={totals ? formatUsd(totals.totalGrossUsd, { compact: true }) : undefined}
          accent="emerald"
          icon={<Coins className="size-3.5" />}
        />
        <TotalsCard
          label="Net Verified"
          value={totals ? formatUsd(totals.verifiedNetUsd, { compact: true }) : undefined}
          accent="emerald"
          icon={<ShieldCheck className="size-3.5" />}
        />
        <TotalsCard
          label="Expected"
          value={totals ? formatUsd(totals.expectedNetUsd, { compact: true }) : undefined}
          accent="amber"
          icon={<Timer className="size-3.5" />}
        />
        <TotalsCard
          label="Fees"
          value={totals ? formatUsd(totals.totalFeesUsd ?? 0) : undefined}
          accent="slate"
          icon={<Receipt className="size-3.5" />}
        />
        <TotalsCard
          label="Expenses"
          value={totals ? formatUsd(totals.totalExpensesUsd ?? 0) : undefined}
          accent="red"
          icon={<TrendingUp className="size-3.5 rotate-180" />}
        />
        <TotalsCard
          label="Hours Spent"
          value={totals ? `${(totals.totalHours ?? 0).toFixed(1)}h` : undefined}
          accent="teal"
          icon={<Timer className="size-3.5" />}
        />
        <TotalsCard
          label="Avg $/hr"
          value={totals ? formatUsd(totals.avgHourlyReturn ?? 0) : undefined}
          accent="emerald"
          icon={<TrendingUp className="size-3.5" />}
        />
      </div>

      {/* Net USD by strategy chart */}
      <Card className="border-border/60">
        <CardContent className="p-4 md:p-5">
          <div className="mb-3">
            <h3 className="text-sm font-semibold">Net USD by Strategy</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Top 10 strategies by net earnings — expected entries included
            </p>
          </div>
          {totalsLoading ? (
            <Skeleton className="h-64 w-full rounded-lg" />
          ) : byStrategy.length === 0 ? (
            <div className="empty-state rounded-lg border border-dashed border-border/60">
              <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                <Landmark className="size-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">No earnings recorded yet</p>
              <p className="max-w-md text-xs text-muted-foreground">
                The ledger fills in as the agent queues work and completes paid
                bounties. Approve an opportunity to start the flow.
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart
                data={byStrategy}
                margin={{ left: 8, right: 16, top: 8, bottom: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} vertical={false} />
                <XAxis
                  dataKey="strategy"
                  tick={{ fontSize: 10, fill: "currentColor" }}
                  angle={-20}
                  textAnchor="end"
                  height={70}
                  stroke="currentColor"
                  strokeOpacity={0.3}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "currentColor" }}
                  tickFormatter={(v: number) => `$${v}`}
                  stroke="currentColor"
                  strokeOpacity={0.3}
                  width={50}
                />
                <RTooltip
                  cursor={{ fill: "currentColor", fillOpacity: 0.04 }}
                  contentStyle={{
                    background: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    fontSize: 11,
                    padding: "8px 10px",
                  }}
                  formatter={(v: number, _name, entry) => {
                    const row = entry?.payload as { count?: number; grossUsd?: number } | undefined;
                    return [
                      `${formatUsd(v)} · ${row?.count ?? 0} entries · gross ${formatUsd(row?.grossUsd ?? 0)}`,
                      "Net",
                    ];
                  }}
                />
                <Bar dataKey="netUsd" name="Net USD" radius={[6, 6, 0, 0]} maxBarSize={56}>
                  {byStrategy.map((_, i) => (
                    <Cell key={i} fill={BAR_SCALE[i % BAR_SCALE.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Verified earnings */}
      <Card className="border-border/60">
        <CardContent className="p-4 md:p-5">
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <span className="flex size-7 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                  <Wallet2 className="size-3.5" />
                </span>
                Verified Earnings
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                On-chain verified or operator-confirmed — money in the bank
              </p>
            </div>
          </div>
          <LedgerList
            rows={verifiedData?.ledger ?? []}
            loading={verifiedLoading}
            kind="verified"
          />
        </CardContent>
      </Card>

      {/* Expected earnings */}
      <Card className="border-border/60">
        <CardContent className="p-4 md:p-5">
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <span className="flex size-7 items-center justify-center rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  <Timer className="size-3.5" />
                </span>
                Expected Earnings
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Pending verification — awaiting on-chain payment match
              </p>
            </div>
          </div>
          <LedgerList
            rows={expectedData?.ledger ?? []}
            loading={expectedLoading}
            kind="expected"
          />
        </CardContent>
      </Card>
    </div>
  );
}

function TotalsCard({
  label,
  value,
  accent,
  icon,
}: {
  label: string;
  value: string | undefined;
  accent: "emerald" | "amber" | "teal" | "red" | "slate";
  icon: React.ReactNode;
}) {
  const iconCls =
    accent === "emerald"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : accent === "amber"
      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
      : accent === "teal"
      ? "bg-teal-500/10 text-teal-600 dark:text-teal-400"
      : accent === "red"
      ? "bg-red-500/10 text-red-600 dark:text-red-400"
      : "bg-slate-500/10 text-slate-600 dark:text-slate-400";
  return (
    <Card className="card-hover-lift border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className={cn("flex size-6 items-center justify-center rounded-md", iconCls)}>
          {icon}
        </span>
      </div>
      <div className="number-tick mt-1.5 font-mono text-sm font-semibold tabular-nums">
        {value ?? <Skeleton className="h-4 w-12" />}
      </div>
    </Card>
  );
}

function LedgerList({
  rows,
  loading,
  kind,
}: {
  rows: Awaited<ReturnType<typeof api.ledger.list>>["ledger"];
  loading: boolean;
  kind: "verified" | "expected";
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="empty-state rounded-lg border border-dashed border-border/60">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          {kind === "verified" ? (
            <ShieldCheck className="size-5 text-muted-foreground" />
          ) : (
            <GitBranch className="size-5 text-muted-foreground" />
          )}
        </div>
        <p className="text-sm font-medium">
          {kind === "verified" ? "No verified earnings yet" : "No expected earnings yet"}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          {kind === "verified"
            ? "Earnings become verified when an on-chain payment lands in a monitored wallet — every entry here is money confirmed on the blockchain, never an estimate."
            : "The agent records an expected earning when work is queued for execution. Approve an opportunity on the Approvals tab and it will appear here."}
        </p>
      </div>
    );
  }
  return (
    <div className="scrollbar-thin max-h-[400px] space-y-1.5 overflow-y-auto pr-1">
      {rows.map((r) => (
        <div
          key={r.id}
          className={cn(
            "row-hover flex flex-col gap-2 rounded-lg border border-border/50 border-l-2 bg-card/60 p-3 text-xs sm:flex-row sm:items-center sm:justify-between",
            kind === "verified" ? "border-l-emerald-500/70" : "border-l-amber-500/70"
          )}
        >
          <div className="min-w-0">
            <div className="truncate font-semibold">
              {r.source} · <span className="capitalize font-normal text-muted-foreground">{r.category.replace(/_/g, " ")}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
              <span className="tabular-nums">{r.hoursSpent.toFixed(1)}h</span>
              <span>·</span>
              <span className="tabular-nums">{formatUsd(r.hourlyReturn)}/hr</span>
              <span>·</span>
              <span className="uppercase">{r.currency}</span>
              {r.strategy ? (
                <>
                  <span>·</span>
                  <span className="font-mono">{r.strategy}</span>
                </>
              ) : null}
              <span>·</span>
              <span className="tabular-nums">{formatRelativeTime(r.createdAt)}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="text-right">
              <div className="font-mono font-semibold tabular-nums">
                {formatUsd(r.netUsd)}
              </div>
              <div className="text-[10px] text-muted-foreground tabular-nums">
                gross {formatUsd(r.grossUsd)}
              </div>
            </div>
            {r.verified ? (
              <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                verified
              </Badge>
            ) : (
              <Badge variant="outline" className="border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300">
                pending
              </Badge>
            )}
            {r.transactionHash ? (
              <Button asChild size="sm" variant="ghost" className="h-7 px-2">
                <a
                  href={`https://etherscan.io/tx/${r.transactionHash}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label="View on explorer"
                >
                  <ExternalLink className="size-3" />
                </a>
              </Button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
