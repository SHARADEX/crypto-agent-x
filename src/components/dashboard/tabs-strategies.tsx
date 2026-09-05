"use client";

// StrategiesTab — Phase 3 §16–§26 strategy diversification + adaptive
// allocation dashboard.
//
// Three panels:
//   1. Strategy Families — a family rollup table (Phase 3 §39) with every
//      column the spec lists: Strategy Family, Allocation %, Attempts,
//      Success Rate, Verified Earnings, Hours, $/hour, Trend, Status.
//   2. Allocation Controls — operator overrides (Phase 3 §25, §26): edit
//      target %, set min/max, disable/enable family, "Auto Optimize"
//      button, "Rebalance Now" button.
//   3. Allocation Change Log — scrollable list of past rebalance decisions
//      with timestamps + reasons (Phase 3 §23).
//
// The legacy per-category StrategyStat table (rankStrategies) is preserved
// as a fourth "Per-Category Detail" panel so the operator can still drill
// into the 11 canonical strategies that roll up into the 7 families.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Brain,
  Compass,
  FlaskConical,
  Loader2,
  Sparkles,
  RefreshCw,
  ArrowUp,
  ArrowDown,
  Minus,
  Power,
  History,
  Settings2,
} from "lucide-react";
import {
  api,
  formatPct,
  formatUsd,
  type AllocationRow,
  type AllocationChangeLogEntry,
  type StrategyFamily,
} from "./lib/api";
import { cn } from "@/lib/utils";

// Emerald monochrome scale — visual consistency with the v2 design system
// (replaces the old rainbow palette of blue/orange/red/purple).
const BAR_COLORS = [
  "#059669",
  "#10b981",
  "#14b8a6",
  "#34d399",
  "#2dd4bf",
  "#6ee7b7",
  "#5eead4",
];

export function StrategiesTab() {
  const { data: allocData, isLoading: allocLoading, error: allocError } = useQuery({
    queryKey: ["strategies", "allocations"],
    queryFn: () => api.strategies.allocations(),
    refetchInterval: 30_000,
  });

  const { data: legacyData, isLoading: legacyLoading } = useQuery({
    queryKey: ["strategies", "legacy"],
    queryFn: () => api.strategies.list(),
    refetchInterval: 30_000,
  });

  const { data: changeLogData } = useQuery({
    queryKey: ["strategies", "change-log"],
    queryFn: () => api.strategies.changeLog(100),
    refetchInterval: 30_000,
  });

  if (allocError) {
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
        Failed to load strategy allocations: {String(allocError)}
      </div>
    );
  }

  const allocations = allocData?.allocations ?? [];
  const totalTarget = allocData?.totalTargetAllocation ?? 0;
  const isBalanced = allocData?.isBalanced ?? true;
  const strategies = legacyData?.strategies ?? [];
  const changeLog = changeLogData?.changeLog ?? [];

  return (
    <div className="space-y-6">
      {/* Exploration vs Exploitation explainer */}
      <Card className="p-4 py-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <Brain className="size-4 text-emerald-500" />
              <h3 className="text-sm font-semibold">
                Adaptive Allocation Policy (Phase 3 §18)
              </h3>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              The cycle selector uses a 65 / 20 / 15 exploit / explore /
              experimental split across the 7 strategy families. The
              adaptive rebalancer shifts allocation toward higher-performing
              families every 5 paid opportunities.
            </p>
          </div>
          <div className="grid w-full grid-cols-3 gap-2 sm:w-2/3">
            <PolicyPill
              label="Exploit"
              pct={65}
              icon={<Brain className="size-3" />}
              accent="emerald"
            />
            <PolicyPill
              label="Explore"
              pct={20}
              icon={<Compass className="size-3" />}
              accent="teal"
            />
            <PolicyPill
              label="Experimental"
              pct={15}
              icon={<FlaskConical className="size-3" />}
              accent="amber"
            />
          </div>
        </div>
      </Card>

      {/* Allocation summary banner */}
      <Card className="p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">
                Total target allocation
              </span>
              <Badge
                variant="outline"
                className={
                  isBalanced
                    ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                }
              >
                {totalTarget.toFixed(2)}%
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {isBalanced
                ? "Active families sum to 100% — system is balanced."
                : "Active families do not sum to 100% — run Auto Optimize or adjust manually."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <RebalanceNowButton />
            <AutoOptimizeButton />
          </div>
        </div>
      </Card>

      {/* Allocation by family chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Target Allocation by Strategy Family
          </CardTitle>
          <CardDescription>
            Phase 3 §16, §34 — 7 families, default 65/10/8/7/5/5/0 split.
            Disabled families are excluded from the chart.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {allocLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart
                data={allocations}
                margin={{ left: 8, right: 16, top: 8, bottom: 8 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="currentColor"
                  strokeOpacity={0.1}
                />
                <XAxis
                  dataKey="family"
                  tick={{ fontSize: 10, fill: "currentColor" }}
                  angle={-20}
                  textAnchor="end"
                  height={70}
                  stroke="currentColor"
                  strokeOpacity={0.3}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "currentColor" }}
                  tickFormatter={(v: number) => `${v}%`}
                  stroke="currentColor"
                  strokeOpacity={0.3}
                  width={50}
                />
                <RTooltip
                  contentStyle={{
                    background: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 11,
                  }}
                  formatter={(v: number) => `${v}%`}
                />
                <Bar
                  dataKey="targetAllocation"
                  name="Target %"
                  radius={[4, 4, 0, 0]}
                >
                  {allocations.map((_, i) => (
                    <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Family rollup table */}
      <FamilyAllocationsCard
        allocations={allocations}
        isLoading={allocLoading}
      />

      {/* Per-family allocation controls */}
      <AllocationControlsCard
        allocations={allocations}
        isLoading={allocLoading}
      />

      {/* Change log */}
      <ChangeLogCard changeLog={changeLog} />

      {/* Per-category detail (legacy) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Per-Category Detail</CardTitle>
          <CardDescription>
            The 11 canonical strategies (legacy). Each rolls up into one of
            the 7 families above.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-[400px] overflow-y-auto scrollbar-thin rounded-md border border-border/60">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead className="text-xs">Strategy</TableHead>
                  <TableHead className="text-right text-xs">Att.</TableHead>
                  <TableHead className="text-right text-xs">Done</TableHead>
                  <TableHead className="text-right text-xs">Failed</TableHead>
                  <TableHead className="text-right text-xs">Success</TableHead>
                  <TableHead className="text-right text-xs">Net USD</TableHead>
                  <TableHead className="text-right text-xs">Avg $/hr</TableHead>
                  <TableHead className="text-right text-xs">Eff $/hr</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {legacyLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={8}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : strategies.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="py-12 text-center text-xs text-muted-foreground"
                    >
                      No strategy stats tracked yet — the bootstrap will
                      populate the canonical set on the first request.
                    </TableCell>
                  </TableRow>
                ) : (
                  strategies.map((s) => (
                    <TableRow key={s.strategy} className="hover:bg-muted/40">
                      <TableCell className="py-2 text-xs font-medium">
                        {s.strategy}
                      </TableCell>
                      <TableCell className="text-right text-xs py-2 tabular-nums">
                        {s.attempted}
                      </TableCell>
                      <TableCell className="text-right text-xs py-2 tabular-nums text-emerald-600 dark:text-emerald-400">
                        {s.completed}
                      </TableCell>
                      <TableCell className="text-right text-xs py-2 tabular-nums text-red-600 dark:text-red-400">
                        {s.failed}
                      </TableCell>
                      <TableCell className="text-right text-xs py-2 tabular-nums">
                        {formatPct(s.successRate)}
                      </TableCell>
                      <TableCell className="text-right text-xs py-2 font-semibold tabular-nums">
                        {formatUsd(s.totalNetUsd)}
                      </TableCell>
                      <TableCell className="text-right text-xs py-2 tabular-nums">
                        {formatUsd(s.avgHourly)}
                      </TableCell>
                      <TableCell className="text-right text-xs py-2 tabular-nums text-teal-600 dark:text-teal-400 font-medium">
                        {formatUsd(s.effectiveAvgHourly)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FamilyAllocationsCard — the family rollup table (Phase 3 §39)
// ---------------------------------------------------------------------------

function FamilyAllocationsCard({
  allocations,
  isLoading,
}: {
  allocations: AllocationRow[];
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Strategy Families</CardTitle>
        <CardDescription>
          Phase 3 §39 — per-family rollup: allocation %, attempts, success
          rate, verified earnings, hours, $/hour, trend, status.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="max-h-[500px] overflow-y-auto scrollbar-thin rounded-md border border-border/60">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead className="text-xs">Family</TableHead>
                <TableHead className="text-right text-xs">Allocation</TableHead>
                <TableHead className="text-right text-xs">Attempts</TableHead>
                <TableHead className="text-right text-xs">Success</TableHead>
                <TableHead className="text-right text-xs">Verified USD</TableHead>
                <TableHead className="text-right text-xs">Hours</TableHead>
                <TableHead className="text-right text-xs">$/hour</TableHead>
                <TableHead className="text-center text-xs">Trend</TableHead>
                <TableHead className="text-center text-xs">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 7 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={9}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : allocations.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="py-12 text-center text-xs text-muted-foreground"
                  >
                    No strategy families allocated yet — bootstrap will seed
                    them on the next request.
                  </TableCell>
                </TableRow>
              ) : (
                allocations.map((a) => (
                  <TableRow
                    key={a.family}
                    className={cn("hover:bg-muted/40", a.disabled && "opacity-50")}
                  >
                    <TableCell className="py-2 text-xs font-medium">
                      <div>
                        <div className="font-semibold">{a.displayName}</div>
                        <div className="text-[10px] text-muted-foreground capitalize">
                          {a.family.replace(/_/g, " ")} · {a.scanFrequency} scan
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-xs py-2 tabular-nums">
                      <div className="font-semibold">
                        {a.targetAllocation.toFixed(1)}%
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        default {a.defaultAllocation}%
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-xs py-2 tabular-nums">
                      {a.stats.attempted}
                    </TableCell>
                    <TableCell className="text-right text-xs py-2 tabular-nums">
                      {formatPct(a.stats.successRate)}
                    </TableCell>
                    <TableCell className="text-right text-xs py-2 font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatUsd(a.stats.totalNetUsd)}
                    </TableCell>
                    <TableCell className="text-right text-xs py-2 tabular-nums">
                      {a.stats.totalHours.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right text-xs py-2 tabular-nums text-teal-600 dark:text-teal-400 font-medium">
                      {formatUsd(a.stats.avgHourly)}
                    </TableCell>
                    <TableCell className="text-center text-xs py-2">
                      <TrendBadge trend={a.trend} />
                    </TableCell>
                    <TableCell className="text-center text-xs py-2">
                      <Badge
                        variant="outline"
                        className={cn(
                          a.disabled
                            ? "bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30"
                            : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                        )}
                      >
                        {a.disabled ? "Disabled" : "Active"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// AllocationControlsCard — operator overrides (Phase 3 §25, §26)
// ---------------------------------------------------------------------------

function AllocationControlsCard({
  allocations,
  isLoading,
}: {
  allocations: AllocationRow[];
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Settings2 className="size-4 text-muted-foreground" />
          <CardTitle className="text-sm">Allocation Controls</CardTitle>
        </div>
        <CardDescription>
          Phase 3 §25, §26 — override target %, set hard limits, or
          disable/enable a family. Other families auto-rescale to keep the
          total at 100%.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : allocations.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            No allocations loaded.
          </div>
        ) : (
          <div className="space-y-3">
            {allocations.map((a) => (
              <FamilyControlRow key={a.family} allocation={a} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FamilyControlRow({ allocation }: { allocation: AllocationRow }) {
  const queryClient = useQueryClient();
  const [targetInput, setTargetInput] = React.useState(
    allocation.targetAllocation.toString()
  );
  const [minInput, setMinInput] = React.useState(
    allocation.minAllocation.toString()
  );
  const [maxInput, setMaxInput] = React.useState(
    allocation.maxAllocation.toString()
  );

  // Re-sync local inputs when the server-side value changes (e.g. after a
  // rebalance fires elsewhere).
  React.useEffect(() => {
    setTargetInput(allocation.targetAllocation.toString());
  }, [allocation.targetAllocation]);
  React.useEffect(() => {
    setMinInput(allocation.minAllocation.toString());
  }, [allocation.minAllocation]);
  React.useEffect(() => {
    setMaxInput(allocation.maxAllocation.toString());
  }, [allocation.maxAllocation]);

  const setAllocationMutation = useMutation({
    mutationFn: (target: number) =>
      api.strategies.setAllocation(allocation.family, target),
    onSuccess: (res) => {
      if (res.ok) {
        toast.success(
          `${allocation.displayName} set to ${targetInput}% (+${res.changes?.length ?? 0} cascade updates).`
        );
      } else {
        toast.error(res.error ?? "setAllocation failed.");
      }
      void queryClient.invalidateQueries({ queryKey: ["strategies"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  const setLimitsMutation = useMutation({
    mutationFn: (params: { min: number; max: number }) =>
      api.strategies.setLimits(allocation.family, params.min, params.max),
    onSuccess: (res) => {
      if (res.ok) {
        toast.success(
          `${allocation.displayName} limits set to [${minInput}%, ${maxInput}%].`
        );
      } else {
        toast.error(res.error ?? "setLimits failed.");
      }
      void queryClient.invalidateQueries({ queryKey: ["strategies"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (disabled: boolean) =>
      api.strategies.toggle(allocation.family, disabled),
    onSuccess: (res) => {
      if (res.ok) {
        toast.success(
          `${allocation.displayName} ${allocation.disabled ? "enabled" : "disabled"}.`
        );
      } else {
        toast.error(res.error ?? "toggle failed.");
      }
      void queryClient.invalidateQueries({ queryKey: ["strategies"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  return (
    <div
      className={cn(
        "rounded-md border border-border/60 p-3",
        allocation.disabled && "opacity-60"
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold">
              {allocation.displayName}
            </span>
            <Badge
              variant="outline"
              className="text-[10px] capitalize"
            >
              {allocation.family.replace(/_/g, " ")}
            </Badge>
            {allocation.disabled && (
              <Badge
                variant="outline"
                className="text-[10px] border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
              >
                Disabled
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground line-clamp-2">
            {allocation.description}
          </p>
          {allocation.rebalanceReason && (
            <p className="mt-1 text-[10px] text-muted-foreground italic">
              Last rebalance: {allocation.rebalanceReason}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Target % input */}
          <div className="flex items-center gap-1">
            <Label className="text-[10px] text-muted-foreground">
              Target
            </Label>
            <Input
              type="number"
              min={allocation.minAllocation}
              max={allocation.maxAllocation}
              step="0.5"
              value={targetInput}
              onChange={(e) => setTargetInput(e.target.value)}
              disabled={allocation.disabled}
              className="h-7 w-16 text-xs tabular-nums"
            />
            <span className="text-[10px] text-muted-foreground">%</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={
                allocation.disabled ||
                setAllocationMutation.isPending ||
                !Number.isFinite(Number(targetInput))
              }
              onClick={() => {
                const target = Number(targetInput);
                if (!Number.isFinite(target)) {
                  toast.error("Target must be a number.");
                  return;
                }
                setAllocationMutation.mutate(target);
              }}
            >
              {setAllocationMutation.isPending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                "Set"
              )}
            </Button>
          </div>

          {/* Min/Max inputs */}
          <div className="flex items-center gap-1">
            <Label className="text-[10px] text-muted-foreground">Min</Label>
            <Input
              type="number"
              min={0}
              max={100}
              step="1"
              value={minInput}
              onChange={(e) => setMinInput(e.target.value)}
              className="h-7 w-12 text-xs tabular-nums"
            />
            <Label className="text-[10px] text-muted-foreground">Max</Label>
            <Input
              type="number"
              min={0}
              max={100}
              step="1"
              value={maxInput}
              onChange={(e) => setMaxInput(e.target.value)}
              className="h-7 w-12 text-xs tabular-nums"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={
                setLimitsMutation.isPending ||
                !Number.isFinite(Number(minInput)) ||
                !Number.isFinite(Number(maxInput))
              }
              onClick={() => {
                const min = Number(minInput);
                const max = Number(maxInput);
                if (!Number.isFinite(min) || !Number.isFinite(max)) {
                  toast.error("Min and max must be numbers.");
                  return;
                }
                if (min > max) {
                  toast.error("Min cannot exceed max.");
                  return;
                }
                setLimitsMutation.mutate({ min, max });
              }}
            >
              {setLimitsMutation.isPending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                "Limits"
              )}
            </Button>
          </div>

          {/* Disable / enable toggle */}
          <div className="flex items-center gap-1">
            <Label className="text-[10px] text-muted-foreground">
              {allocation.disabled ? "Enable" : "Disable"}
            </Label>
            <Switch
              checked={!allocation.disabled}
              onCheckedChange={(checked) => {
                toggleMutation.mutate(!checked);
              }}
              disabled={toggleMutation.isPending}
            />
            <Power
              className={cn(
                "size-3",
                allocation.disabled
                  ? "text-red-500"
                  : "text-emerald-500"
              )}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChangeLogCard — Phase 3 §23 allocation change log
// ---------------------------------------------------------------------------

function ChangeLogCard({
  changeLog,
}: {
  changeLog: AllocationChangeLogEntry[];
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" />
          <CardTitle className="text-sm">Allocation Change Log</CardTitle>
        </div>
        <CardDescription>
          Phase 3 §23 — every adaptive rebalance + operator override is
          recorded with a human-readable reason.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-72 w-full rounded-md border border-border/60 p-2">
          {changeLog.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              No allocation changes yet — the adaptive rebalancer will write
              entries here after every 5 paid opportunities.
            </div>
          ) : (
            <ul className="space-y-2">
              {changeLog.map((entry) => (
                <li
                  key={entry.id}
                  className="rounded-md border border-border/40 bg-muted/20 p-2 text-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className="text-[10px] capitalize"
                        >
                          {entry.family.replace(/_/g, " ")}
                        </Badge>
                        <TriggeredByBadge triggeredBy={entry.triggeredBy} />
                        <span className="text-[10px] tabular-nums text-muted-foreground">
                          {entry.previousAllocation.toFixed(1)}% →{" "}
                          {entry.newAllocation.toFixed(1)}%
                          {entry.newAllocation > entry.previousAllocation ? (
                            <ArrowUp className="inline size-3 text-emerald-500" />
                          ) : entry.newAllocation < entry.previousAllocation ? (
                            <ArrowDown className="inline size-3 text-red-500" />
                          ) : (
                            <Minus className="inline size-3 text-muted-foreground" />
                          )}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] leading-snug">
                        {entry.reason}
                      </p>
                    </div>
                    <span className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
                      {formatRelativeTime(entry.createdAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function TriggeredByBadge({
  triggeredBy,
}: {
  triggeredBy: AllocationChangeLogEntry["triggeredBy"];
}) {
  const styles: Record<AllocationChangeLogEntry["triggeredBy"], string> = {
    adaptive_rebalancer:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    operator:
      "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    auto_optimize:
      "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    limit_override:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    toggle:
      "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  };
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] capitalize", styles[triggeredBy])}
    >
      {triggeredBy.replace(/_/g, " ")}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Action buttons
// ---------------------------------------------------------------------------

function AutoOptimizeButton() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.strategies.autoOptimize(),
    onSuccess: (res) => {
      if (res.ok) {
        toast.success(
          `Auto-optimized: ${res.changes?.length ?? 0} families reset to defaults.`
        );
      } else {
        toast.error(res.error ?? "autoOptimize failed.");
      }
      void queryClient.invalidateQueries({ queryKey: ["strategies"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-8"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      {mutation.isPending ? (
        <Loader2 className="mr-1 size-3 animate-spin" />
      ) : (
        <Sparkles className="mr-1 size-3" />
      )}
      Auto Optimize
    </Button>
  );
}

function RebalanceNowButton() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.strategies.rebalance(),
    onSuccess: (res) => {
      if (res.ok && res.rebalanced) {
        toast.success(
          `Rebalance complete: ${res.changes?.length ?? 0} family updates.`
        );
      } else if (res.ok && !res.rebalanced) {
        toast.info(
          `Rebalance skipped: ${res.skippedReason ?? "no changes needed"}.`
        );
      } else {
        toast.error(res.error ?? "rebalance failed.");
      }
      void queryClient.invalidateQueries({ queryKey: ["strategies"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-8"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      {mutation.isPending ? (
        <Loader2 className="mr-1 size-3 animate-spin" />
      ) : (
        <RefreshCw className="mr-1 size-3" />
      )}
      Rebalance Now
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Small components
// ---------------------------------------------------------------------------

function TrendBadge({ trend }: { trend: "up" | "down" | "flat" }) {
  if (trend === "up") {
    return (
      <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
        <ArrowUp className="size-3" />
        <span className="text-[10px]">Up</span>
      </span>
    );
  }
  if (trend === "down") {
    return (
      <span className="inline-flex items-center gap-0.5 text-red-600 dark:text-red-400">
        <ArrowDown className="size-3" />
        <span className="text-[10px]">Down</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-muted-foreground">
      <Minus className="size-3" />
      <span className="text-[10px]">Flat</span>
    </span>
  );
}

function PolicyPill({
  label,
  pct,
  icon,
  accent,
}: {
  label: string;
  pct: number;
  icon: React.ReactNode;
  accent: "emerald" | "teal" | "amber";
}) {
  const cls =
    accent === "emerald"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : accent === "teal"
      ? "border-teal-500/25 bg-teal-500/10 text-teal-700 dark:text-teal-300"
      : "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return (
    <div className={cn("rounded-lg border p-2", cls)}>
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="mt-1 font-mono text-base font-semibold tabular-nums">{pct}%</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Utility — minimal relative time formatter (kept local to avoid pulling
// another import; the dashboard's lib/api.ts exposes a formatRelativeTime
// helper but it's only used here and we want this file self-contained for
// the Phase 3 review).
// ---------------------------------------------------------------------------

function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const diffMs = Date.now() - then;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(then).toLocaleDateString();
}
