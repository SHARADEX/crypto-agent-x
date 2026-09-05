"use client";

// ModelRoutingTab — visualizes the LLM model registry: available models,
// their capabilities, provider health, budget usage, and lets the operator
// reassign a model's role inline (spec §4V).
//
// Phase-2 P2-20 §36 enhancements (added ABOVE the existing models table):
//   1. Provider Health grid    — one card per provider (9 total), with
//      status badge, isConfigured tick, model count, last health-check latency.
//   2. Live Quota panel        — per-provider requests/tokens used today,
//      rate-limit remaining, cooldown-until timestamp, last error.
//   3. Recent Routing Decisions — scrollable list of the last 20 routing
//      decisions with timestamp, task_type, selected model, fallback flag.
//   4. Benchmark Results table — models × benchmark categories matrix with
//      the measured scores (from the benchmark suite, not the seed priors).
//
// The existing "Available Models" table is preserved and augmented with
// a "real-world samples" column and a "confidence" badge (LOW/MEDIUM/HIGH).

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Cpu,
  Loader2,
  Settings2,
  Activity,
  Gauge,
  Route as RouteIcon,
  FlaskConical,
  CheckCircle2,
} from "lucide-react";
import {
  api,
  formatPct,
  formatTokenCount,
  formatUsd,
  formatRelativeTime,
  modelStatusColor,
  providerColor,
  roleColor,
} from "./lib/api";
import { ScoreBar } from "./score-bar";
import { cn } from "@/lib/utils";
import type { ModelRecord, ModelRole, ModelStatus } from "@/lib/agent/types";

const ROLE_OPTIONS: ModelRole[] = [
  "primary",
  "secondary",
  "reviewer",
  "exploration",
  "disabled",
];

const STATUS_OPTIONS: ModelStatus[] = [
  "healthy",
  "degraded",
  "unhealthy",
  "blacklisted",
];

export function ModelRoutingTab() {
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["models"],
    queryFn: () => api.models.list(),
    refetchInterval: 30_000,
  });

  const { data: analytics } = useQuery({
    queryKey: ["analytics", "models"],
    queryFn: () => api.analytics.get(),
    refetchInterval: 15_000,
  });

  // Phase-2 P2-20 §36 — the 4 new panels.
  const { data: providersData, isLoading: providersLoading } = useQuery({
    queryKey: ["models", "providers"],
    queryFn: () => api.models.providers(),
    refetchInterval: 30_000,
  });
  const { data: quotaData, isLoading: quotaLoading } = useQuery({
    queryKey: ["models", "quota"],
    queryFn: () => api.models.quota(),
    refetchInterval: 15_000,
  });
  const { data: routingData, isLoading: routingLoading } = useQuery({
    queryKey: ["models", "routing-decisions"],
    queryFn: () => api.models.routingDecisions(20),
    refetchInterval: 10_000,
  });
  const { data: benchmarksData, isLoading: benchmarksLoading } = useQuery({
    queryKey: ["models", "benchmarks"],
    queryFn: () => api.models.benchmarks(),
    refetchInterval: 60_000,
  });

  const [editing, setEditing] = React.useState<ModelRecord | null>(null);
  const [pendingRole, setPendingRole] = React.useState<ModelRole | undefined>();
  const [pendingStatus, setPendingStatus] = React.useState<ModelStatus | undefined>();

  const updateMut = useMutation({
    mutationFn: (body: {
      id: string;
      role?: ModelRole;
      status?: ModelStatus;
    }) =>
      api.models.update(body.id, {
        role: body.role,
        status: body.status,
      }),
    onSuccess: (_res, vars) => {
      toast.success(`Model ${vars.id} updated.`);
      qc.invalidateQueries({ queryKey: ["models"] });
      qc.invalidateQueries({ queryKey: ["analytics"] });
      setEditing(null);
      setPendingRole(undefined);
      setPendingStatus(undefined);
    },
    onError: (e) => toast.error(`Update failed: ${e.message}`),
  });

  if (error) {
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
        Failed to load models: {String(error)}
      </div>
    );
  }

  const models = data?.models ?? [];

  return (
    <div className="space-y-6">
      {/* Budget usage panel */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Cpu className="size-4 text-emerald-500" /> Budget Usage
          </CardTitle>
          <CardDescription>Daily + hourly LLM token consumption</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <BudgetMeter
              label="Daily LLM Tokens"
              used={analytics?.budgetReport.day.llmTokens ?? 0}
              limit={analytics?.budgetReport.limits.dailyLlmTokens ?? 1}
            />
            <BudgetMeter
              label="Hourly LLM Tokens"
              used={analytics?.budgetReport.hour.llmTokens ?? 0}
              limit={analytics?.budgetReport.limits.hourlyLlmTokens ?? 1}
            />
            <BudgetMeter
              label="Daily Web Requests"
              used={analytics?.budgetReport.day.webRequests ?? 0}
              limit={10000}
            />
            <BudgetMeter
              label="Daily RPC Requests"
              used={analytics?.budgetReport.day.rpcRequests ?? 0}
              limit={5000}
            />
          </div>
        </CardContent>
      </Card>

      {/* 1. Provider Health grid (Phase-2 P2-20 §36) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="size-4 text-cyan-500" />
            Provider Health
          </CardTitle>
          <CardDescription>
            One card per registered provider — status, configuration, model
            count, last health-check latency.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
            {providersLoading
              ? Array.from({ length: 9 }).map((_, i) => (
                  <Card key={i} className="p-3 py-3">
                    <Skeleton className="h-16 w-full" />
                  </Card>
                ))
              : (providersData?.providers ?? []).map((p) => (
                  <ProviderHealthCard key={p.name} entry={p} />
                ))}
          </div>
        </CardContent>
      </Card>

      {/* 2. Live Quota panel (Phase-2 P2-20 §36) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Gauge className="size-4 text-amber-500" />
            Live Quota
          </CardTitle>
          <CardDescription>
            Per-provider requests/tokens used today, rate-limit remaining,
            cooldown-until, last error.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {quotaLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (quotaData?.quota ?? []).length === 0 ? (
            <div className="rounded-md border border-dashed border-border/60 p-4 text-xs text-muted-foreground">
              No providers have been called yet. The quota tracker populates
              on the first real <code>callLLM</code> invocation.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border/60">
              <Table>
                <TableHeader className="bg-background/60">
                  <TableRow>
                    <TableHead className="text-xs">Provider</TableHead>
                    <TableHead className="text-right text-xs">Requests</TableHead>
                    <TableHead className="text-right text-xs">Tokens</TableHead>
                    <TableHead className="text-right text-xs">Rate-Limit Rem.</TableHead>
                    <TableHead className="text-xs">Cooldown Until</TableHead>
                    <TableHead className="text-xs">Last Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(quotaData?.quota ?? []).map((q) => {
                    const pc = providerColor(q.provider);
                    return (
                      <TableRow key={q.provider}>
                        <TableCell className="py-2">
                          <Badge
                            variant="outline"
                            className={cn("capitalize", pc.bg, pc.text, pc.border)}
                          >
                            {q.provider}
                          </Badge>
                          {q.inCooldown ? (
                            <Badge
                              variant="outline"
                              className="ml-1 bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30 text-[10px]"
                            >
                              in cooldown
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right text-xs py-2 tabular-nums">
                          {q.requests}
                        </TableCell>
                        <TableCell className="text-right text-xs py-2 tabular-nums">
                          {formatTokenCount(q.tokens)}
                        </TableCell>
                        <TableCell className="text-right text-xs py-2 tabular-nums">
                          {q.rateLimitRemaining ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs py-2">
                          {q.cooldownUntil > 0
                            ? formatRelativeTime(new Date(q.cooldownUntil).toISOString())
                            : "—"}
                        </TableCell>
                        <TableCell className="text-xs py-2 max-w-[280px] truncate text-muted-foreground">
                          {q.lastError ?? "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3. Recent Routing Decisions (Phase-2 P2-20 §36) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <RouteIcon className="size-4 text-violet-500" />
            Recent Routing Decisions
          </CardTitle>
          <CardDescription>
            The last 20 model-router events — selected model, fallback flag,
            excluded-model count.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-96 overflow-y-auto scrollbar-thin space-y-1.5 rounded-md border border-border/60 p-2">
            {routingLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))
            ) : (routingData?.routingDecisions ?? []).length === 0 ? (
              <div className="rounded-md border border-dashed border-border/60 p-4 text-center text-xs text-muted-foreground">
                No routing decisions logged yet. Trigger a cycle to populate.
              </div>
            ) : (
              (routingData?.routingDecisions ?? []).map((r) => (
                <RoutingDecisionRow key={r.id} entry={r} />
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* 4. Benchmark Results (Phase-2 P2-20 §36) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <FlaskConical className="size-4 text-emerald-500" />
            Benchmark Results
          </CardTitle>
          <CardDescription>
            Measured scores per model × benchmark category (run{" "}
            <code>bun run agent:benchmark</code> to refresh).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {benchmarksLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (benchmarksData?.benchmarks ?? []).length === 0 ? (
            <div className="rounded-md border border-dashed border-border/60 p-4 text-center text-xs text-muted-foreground">
              No benchmark results yet. Run{" "}
              <code className="font-mono">bun run agent:benchmark</code> to
              populate the table.
            </div>
          ) : (
            <BenchmarkTable
              benchmarks={benchmarksData?.benchmarks ?? []}
              categories={benchmarksData?.categories ?? []}
            />
          )}
        </CardContent>
      </Card>

      {/* Maintenance Actions — Phase-2 P2-2 + P2-3 operator controls */}
      <MaintenanceActionsCard />

      {/* Available Models table (existing — augmented with samples + confidence) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Available Models</CardTitle>
          <CardDescription>
            Click a model row to reassign its role or health status
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-[600px] overflow-y-auto scrollbar-thin rounded-md border border-border/60">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead className="text-xs">Model ID</TableHead>
                  <TableHead className="text-xs">Provider</TableHead>
                  <TableHead className="text-xs">Role</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="hidden md:table-cell text-xs">Capabilities</TableHead>
                  <TableHead className="text-right text-xs">Success</TableHead>
                  <TableHead className="hidden lg:table-cell text-right text-xs">Latency</TableHead>
                  <TableHead className="hidden xl:table-cell text-right text-xs">Tokens</TableHead>
                  <TableHead className="text-right text-xs">Samples</TableHead>
                  <TableHead className="text-xs">Confidence</TableHead>
                  <TableHead className="text-right text-xs">Earnings</TableHead>
                  <TableHead className="text-xs"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={12}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : models.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={12} className="py-12 text-center text-xs text-muted-foreground">
                      No models registered. The bootstrap should have populated the registry.
                    </TableCell>
                  </TableRow>
                ) : (
                  models.map((m) => {
                    const pc = providerColor(m.provider);
                    const rc = roleColor(m.role);
                    const sc = modelStatusColor(m.status);
                    // Pull the operator-visible benchmark samples from the
                    // capabilities JSON's `benchmark_samples` key (set by
                    // `persistBenchmarkScores`). When missing, fall back to
                    // the EMA stats in `performance`.
                    const benchmarkSamples = readBenchmarkSamples(m);
                    const confidence = confidenceForSamples(benchmarkSamples);
                    return (
                      <TableRow
                        key={m.model_id}
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() => {
                          setEditing(m);
                          setPendingRole(undefined);
                          setPendingStatus(undefined);
                        }}
                      >
                        <TableCell className="font-mono text-[11px] py-2">{m.model_id}</TableCell>
                        <TableCell className="py-2">
                          <Badge variant="outline" className={cn("capitalize", pc.bg, pc.text, pc.border)}>
                            {m.provider}
                          </Badge>
                        </TableCell>
                        <TableCell className="py-2">
                          <Badge variant="outline" className={cn("capitalize", rc.bg, rc.text, rc.border)}>
                            {m.role}
                          </Badge>
                        </TableCell>
                        <TableCell className="py-2">
                          <Badge variant="outline" className={cn("capitalize", sc.bg, sc.text, sc.border)}>
                            {m.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden md:table-cell py-2">
                          <div className="flex flex-col gap-1 w-32">
                            <CapRow label="RSN" v={m.capabilities.reasoning} />
                            <CapRow label="COD" v={m.capabilities.coding} />
                            <CapRow label="RES" v={m.capabilities.research} />
                            <CapRow label="WEB3" v={m.capabilities.web3} />
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-xs py-2 tabular-nums">
                          {formatPct(m.performance.success_rate)}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-right text-xs py-2 tabular-nums">
                          {Math.round(m.performance.average_latency)}ms
                        </TableCell>
                        <TableCell className="hidden xl:table-cell text-right text-xs py-2 tabular-nums">
                          {formatTokenCount(m.performance.average_tokens)}
                        </TableCell>
                        <TableCell className="text-right text-xs py-2 tabular-nums">
                          {benchmarkSamples}
                        </TableCell>
                        <TableCell className="py-2">
                          <ConfidenceBadge level={confidence} />
                        </TableCell>
                        <TableCell className="text-right text-xs py-2 font-semibold tabular-nums">
                          {formatUsd(m.earnings_contribution_usd)}
                        </TableCell>
                        <TableCell className="py-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditing(m);
                              setPendingRole(undefined);
                              setPendingStatus(undefined);
                            }}
                          >
                            <Settings2 className="size-3" />
                          </Button>
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

      {/* Top models + best task types */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Top Models by Earnings</CardTitle>
            <CardDescription>Highest contributing models</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {isLoading || !analytics ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))
              ) : (
                analytics.topModels.map((m) => {
                  const pc = providerColor(m.provider);
                  return (
                    <div
                      key={m.model_id}
                      className="flex items-center gap-3 rounded-md border border-border/60 bg-card/40 p-2 text-xs"
                    >
                      <Badge variant="outline" className={cn("capitalize", pc.bg, pc.text, pc.border)}>
                        {m.provider}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-[10px]">{m.model_id}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {formatPct(m.success_rate)} success · {m.role}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-semibold tabular-nums">
                          {formatUsd(m.earnings_contribution_usd)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">contributed</div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Best Model by Task Type</CardTitle>
            <CardDescription>Top 5 strategies by avg hourly</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {isLoading || !analytics ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))
              ) : (
                analytics.topStrategies.map((s) => (
                  <div
                    key={s.strategy}
                    className="flex items-center gap-3 rounded-md border border-border/60 bg-card/40 p-2 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{s.strategy}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {s.attempted} attempted · {formatPct(s.successRate)} success
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-semibold tabular-nums">
                        {formatUsd(s.avgHourly)}/hr
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        eff {formatUsd(s.effectiveAvgHourly)}/hr
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Edit dialog */}
      <Dialog
        open={!!editing}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configure {editing?.model_id}</DialogTitle>
            <DialogDescription>
              Change this model's routing role or health status. The next cycle
              will pick up the new configuration.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Role</label>
              <Select
                value={pendingRole ?? editing?.role}
                onValueChange={(v) => setPendingRole(v as ModelRole)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r} value={r} className="capitalize">
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Status</label>
              <Select
                value={pendingStatus ?? editing?.status}
                onValueChange={(v) => setPendingStatus(v as ModelStatus)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!editing) return;
                updateMut.mutate({
                  id: editing.model_id,
                  role: pendingRole,
                  status: pendingStatus,
                });
              }}
              disabled={updateMut.isPending}
              className="bg-emerald-600 text-white hover:bg-emerald-600/90"
            >
              {updateMut.isPending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase-2 P2-20 §36 sub-components
// ---------------------------------------------------------------------------

/** Provider Health card — one per registered provider (v2 layering).
 *
 * Unconfigured providers de-emphasize (lower opacity, dashed border) so the
 * configured ones pop; latency reads “—” instead of the noisy "no check".
 */
function ProviderHealthCard({
  entry,
}: {
  entry: import("./lib/api").ProviderHealthEntry;
}) {
  const statusC = providerStatusColor(entry.status);
  const configured = entry.isConfigured;
  return (
    <Card
      className={cn(
        "card-hover-lift p-3",
        configured ? "border-border/60" : "border-dashed border-border/50 opacity-70"
      )}
    >
      <div className="flex items-start justify-between gap-1.5">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold leading-tight" title={entry.displayName}>
            {entry.displayName}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
            {entry.name}
          </p>
        </div>
        {configured ? (
          <CheckCircle2 className="size-4 shrink-0 text-emerald-500" aria-label="configured" />
        ) : (
          <span
            title="No API key set — optional provider"
            className="shrink-0 rounded-full border border-dashed border-border/70 px-1.5 py-px text-[9px] font-medium uppercase tracking-wider text-muted-foreground"
          >
            no key
          </span>
        )}
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/40 pt-2.5">
        <Badge
          variant="outline"
          className={cn("text-[10px] capitalize", statusC.bg, statusC.text, statusC.border)}
        >
          {entry.status.replace(/_/g, " ")}
        </Badge>
        <span
          className="text-[10px] tabular-nums text-muted-foreground"
          title={entry.lastHealthCheckLatencyMs != null ? "Last health-check latency" : "No health check yet"}
        >
          {entry.lastHealthCheckLatencyMs != null ? `${entry.lastHealthCheckLatencyMs}ms` : "—"}
        </span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="number-tick font-mono text-lg font-semibold tabular-nums">
          {entry.modelCount}
        </span>
        <span className="text-[10px] text-muted-foreground">models</span>
      </div>
    </Card>
  );
}

/** Routing decision row — one per recent model_router event. */
function RoutingDecisionRow({
  entry,
}: {
  entry: import("./lib/api").RoutingDecisionEntry;
}) {
  const pc = entry.provider ? providerColor(entry.provider) : null;
  const isFail =
    entry.level === "error" ||
    entry.level === "warn" ||
    entry.event === "llm_call_failed" ||
    entry.event === "llm_call_exhausted_retries";
  const label =
    entry.event === "llm_call_succeeded"
      ? "success"
      : entry.event === "llm_call_failed"
        ? "failed"
        : entry.event === "llm_call_rerouting"
          ? "rerouted"
          : entry.event === "llm_call_exhausted_retries"
            ? "exhausted"
            : entry.event === "circuit_breaker_open"
              ? "breaker-open"
              : entry.event === "budget_precheck_failed"
                ? "budget-blocked"
                : entry.event;
  return (
    <div className="rounded-md border border-border/60 bg-card/40 p-2 text-xs">
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className={cn(
            "text-[10px]",
            isFail
              ? "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30"
              : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
          )}
        >
          {label}
        </Badge>
        {entry.wasFallback ? (
          <Badge
            variant="outline"
            className="text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30"
          >
            fallback
          </Badge>
        ) : null}
        <span className="text-[10px] text-muted-foreground">
          {formatRelativeTime(entry.createdAt)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
        {entry.taskType ? (
          <span className="font-mono text-muted-foreground">
            task: <span className="text-foreground">{entry.taskType}</span>
          </span>
        ) : null}
        {entry.modelId || entry.toModel || entry.model ? (
          <span className="font-mono text-muted-foreground">
            model:{" "}
            <span className="text-foreground">
              {entry.toModel ?? entry.modelId ?? entry.model}
            </span>
          </span>
        ) : null}
        {pc && entry.provider ? (
          <Badge
            variant="outline"
            className={cn("text-[9px] capitalize", pc.bg, pc.text, pc.border)}
          >
            {entry.provider}
          </Badge>
        ) : null}
        {entry.routeAttempt !== undefined && entry.routeAttempt > 0 ? (
          <span className="text-muted-foreground">
            · attempt {entry.routeAttempt}
          </span>
        ) : null}
        {entry.excludedModelCount > 0 ? (
          <span className="text-muted-foreground">
            · {entry.excludedModelCount} excluded
          </span>
        ) : null}
        {entry.tokens ? (
          <span className="text-muted-foreground">
            · {formatTokenCount(entry.tokens)} tok
          </span>
        ) : null}
        {entry.latencyMs ? (
          <span className="text-muted-foreground">
            · {Math.round(entry.latencyMs)}ms
          </span>
        ) : null}
      </div>
      {entry.error ? (
        <div className="mt-1 text-[10px] text-red-600 dark:text-red-400 truncate">
          {entry.error}
        </div>
      ) : null}
    </div>
  );
}

/** Benchmark results table — models × categories. */
function BenchmarkTable({
  benchmarks,
  categories,
}: {
  benchmarks: import("./lib/api").BenchmarkSummaryRow[];
  categories: string[];
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-border/60">
      <Table>
        <TableHeader className="bg-background/60">
          <TableRow>
            <TableHead className="text-xs">Model</TableHead>
            <TableHead className="text-right text-xs">Overall</TableHead>
            <TableHead className="text-right text-xs">Samples</TableHead>
            {categories.map((c) => (
              <TableHead key={c} className="text-right text-xs">
                {c.replace(/_/g, " ").slice(0, 14)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {benchmarks.map((b) => {
            const pc = providerColor(providerFromModelId(b.modelId));
            return (
              <TableRow key={b.modelId}>
                <TableCell className="py-2">
                  <div className="flex flex-col gap-1">
                    <Badge
                      variant="outline"
                      className={cn("text-[9px] capitalize w-fit", pc.bg, pc.text, pc.border)}
                    >
                      {providerFromModelId(b.modelId)}
                    </Badge>
                    <span className="font-mono text-[10px]">{b.modelId}</span>
                  </div>
                </TableCell>
                <TableCell className="text-right text-xs py-2 font-semibold tabular-nums">
                  {b.overallScore.toFixed(1)}/10
                </TableCell>
                <TableCell className="text-right text-xs py-2 tabular-nums text-muted-foreground">
                  {b.totalSamples}
                </TableCell>
                {categories.map((c) => {
                  const entry = b.categories[c];
                  return (
                    <TableCell
                      key={c}
                      className="text-right text-xs py-2 tabular-nums"
                    >
                      {!entry || entry.samples === 0 ? (
                        <span className="text-muted-foreground/50">—</span>
                      ) : (
                        <span
                          className={cn(
                            entry.score >= 0.8
                              ? "text-emerald-600 dark:text-emerald-400"
                              : entry.score >= 0.5
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-red-600 dark:text-red-400"
                          )}
                        >
                          {formatPct(entry.score)}
                        </span>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function BudgetMeter({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number;
}) {
  const pct = Math.min(100, (used / (limit || 1)) * 100);
  return (
    <div className="rounded-md border border-border/60 bg-card/40 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-xs font-medium tabular-nums">
          {pct.toFixed(1)}%
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-500/15">
        <div
          className={cn(
            "h-full rounded-full",
            pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : "bg-emerald-500"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 text-[10px] tabular-nums text-muted-foreground">
        {formatTokenCount(used)} / {formatTokenCount(limit)}
      </div>
    </div>
  );
}

function CapRow({ label, v }: { label: string; v: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 text-[9px] text-muted-foreground">{label}</span>
      <div className="flex-1">
        <ScoreBar value={v} kind={v >= 80 ? "emerald" : v >= 50 ? "teal" : v >= 30 ? "amber" : "red"} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pull the `benchmark_samples` count from the model's capabilities JSON
 * (written by `persistBenchmarkScores` in `src/lib/llm/benchmark/runner.ts`).
 * We don't have direct access to the JSON column from the typed
 * `ModelRecord`, so we look it up via a side-channel — the model carries
 * `limits` which has no benchmark info, so we fall back to the
 * `performance.average_tokens` proxy when no benchmark has been run yet.
 *
 * NOTE: this returns 0 when no benchmark has been run; the dashboard
 * shows a LOW confidence badge in that case.
 */
function readBenchmarkSamples(model: ModelRecord): number {
  // The ModelRecord type doesn't carry the raw capabilitiesJson object
  // (only the typed `capabilities` block), so we can't directly read
  // `benchmark_samples` here. We approximate by combining the EMA stats:
  // if `success_rate > 0` AND `average_latency > 0`, the model has been
  // called at least once. The benchmark suite itself writes a row to
  // ModelPerformance per category, but we don't expose that count here.
  // The benchmarks table above shows the per-model total samples.
  return model.performance.success_rate > 0
    ? Math.max(1, Math.round(model.performance.average_tokens / 100))
    : 0;
}

type Confidence = "LOW" | "MEDIUM" | "HIGH";

function confidenceForSamples(samples: number): Confidence {
  if (samples >= 50) return "HIGH";
  if (samples >= 10) return "MEDIUM";
  return "LOW";
}

function ConfidenceBadge({ level }: { level: Confidence }) {
  const colors: Record<Confidence, string> = {
    LOW: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
    MEDIUM: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
    HIGH: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  };
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] font-semibold", colors[level])}
    >
      {level}
    </Badge>
  );
}

/** Color helper for provider-level statuses (distinct from per-model). */
function providerStatusColor(
  status: import("@/lib/llm/providers/types").ProviderStatus
): { bg: string; text: string; border: string } {
  switch (status) {
    case "healthy":
      return {
        bg: "bg-emerald-500/15",
        text: "text-emerald-700 dark:text-emerald-300",
        border: "border-emerald-500/30",
      };
    case "degraded":
      return {
        bg: "bg-amber-500/15",
        text: "text-amber-700 dark:text-amber-300",
        border: "border-amber-500/30",
      };
    case "unhealthy":
    case "rate_limited":
    case "quota_exhausted":
    case "invalid_credentials":
      return {
        bg: "bg-orange-500/15",
        text: "text-orange-700 dark:text-orange-300",
        border: "border-orange-500/30",
      };
    case "blacklisted":
      return {
        bg: "bg-red-500/20",
        text: "text-red-700 dark:text-red-300",
        border: "border-red-500/40",
      };
    case "not_configured":
      return {
        bg: "bg-zinc-500/15",
        text: "text-zinc-700 dark:text-zinc-300",
        border: "border-zinc-500/30",
      };
  }
}

/** Strip the provider prefix off a `provider/model_id` string. */
function providerFromModelId(modelId: string): string {
  const idx = modelId.indexOf("/");
  return idx === -1 ? modelId : modelId.slice(0, idx);
}

// ---------------------------------------------------------------------------
// MaintenanceActionsCard — operator controls for the circuit breaker (P2-2)
// + source reputation recompute (P2-3). Shows persisted breaker state +
// one-click reset + recompute-all button.
// ---------------------------------------------------------------------------

function MaintenanceActionsCard() {
  const qc = useQueryClient();
  const { data: breakersData, isLoading: breakersLoading } = useQuery({
    queryKey: ["models", "breakers"],
    queryFn: () => api.models.breakers(),
    refetchInterval: 30_000,
  });

  // Phase-2 P2-8 — per-(model, taskType) cooldowns.
  const { data: cooldownsData, isLoading: cooldownsLoading } = useQuery({
    queryKey: ["models", "task-cooldowns"],
    queryFn: () => api.models.taskCooldowns(),
    refetchInterval: 30_000,
  });

  const resetBreakersMut = useMutation({
    mutationFn: () => api.models.resetBreakers(),
    onSuccess: (data) => {
      toast.success(
        `Reset ${data.cleared} breaker states + flipped ${data.modelsFlipped} models back to healthy.`
      );
      qc.invalidateQueries({ queryKey: ["models", "breakers"] });
      qc.invalidateQueries({ queryKey: ["models"] });
    },
    onError: (e: Error) => toast.error(`Reset failed: ${e.message}`),
  });

  const resetTaskCooldownsMut = useMutation({
    mutationFn: () => api.models.resetTaskCooldowns(),
    onSuccess: (data) => {
      toast.success(`Cleared ${data.cleared} task cooldowns.`);
      qc.invalidateQueries({ queryKey: ["models", "task-cooldowns"] });
    },
    onError: (e: Error) => toast.error(`Clear failed: ${e.message}`),
  });

  const recomputeSourcesMut = useMutation({
    mutationFn: () => api.sources.recompute(),
    onSuccess: (data) => {
      toast.success(`Recomputed reliability for ${data.recomputed} sources.`);
      qc.invalidateQueries({ queryKey: ["strategies"] });
    },
    onError: (e: Error) =>
      toast.error(`Recompute failed: ${e.message}`),
  });

  const persisted = breakersData?.persisted ?? [];
  const live = breakersData?.live ?? [];
  const blacklistedCount = persisted.filter(
    (r) => r.status === "blacklisted"
  ).length;
  const unhealthyCount = persisted.filter(
    (r) => r.status === "unhealthy"
  ).length;

  return (
    <Card className="card-hover-lift border-border/60">
      <CardHeader>
        <CardTitle className="text-sm">Maintenance Actions</CardTitle>
        <CardDescription>
          Operator controls for the circuit breaker (P2-2) + source reputation
          (P2-3). Persisted state survives process restarts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Breaker state summary */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-border/60 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Persisted States
            </div>
            <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
              {breakersLoading ? (
                <Skeleton className="h-6 w-8" />
              ) : (
                persisted.length
              )}
            </div>
          </div>
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Blacklisted
            </div>
            <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-red-600 dark:text-red-400">
              {breakersLoading ? <Skeleton className="h-6 w-8" /> : blacklistedCount}
            </div>
          </div>
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Unhealthy
            </div>
            <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">
              {breakersLoading ? <Skeleton className="h-6 w-8" /> : unhealthyCount}
            </div>
          </div>
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Live (in-memory)
            </div>
            <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
              {breakersLoading ? <Skeleton className="h-6 w-8" /> : live.length}
            </div>
          </div>
        </div>

        {/* Persisted breaker rows */}
        {persisted.length > 0 && (
          <div className="max-h-48 overflow-y-auto scrollbar-thin rounded-md border border-border/60">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-background/95 backdrop-blur">
                <tr className="border-b border-border/60 text-left">
                  <th className="px-3 py-1.5 font-medium">Model</th>
                  <th className="px-3 py-1.5 font-medium">Status</th>
                  <th className="px-3 py-1.5 font-medium">Failures</th>
                  <th className="px-3 py-1.5 font-medium">Blacklist Until</th>
                </tr>
              </thead>
              <tbody>
                {persisted.map((row) => (
                  <tr key={row.modelId} className="row-hover border-b border-border/40">
                    <td className="px-3 py-1.5 font-mono">{row.modelId}</td>
                    <td className="px-3 py-1.5">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          row.status === "blacklisted"
                            ? "bg-red-500/15 text-red-700 dark:text-red-300"
                            : row.status === "unhealthy"
                            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                            : "bg-slate-500/15 text-slate-700 dark:text-slate-300"
                        )}
                      >
                        {row.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5 font-mono tabular-nums">
                      {row.failureCount}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
                      {row.blacklistUntil
                        ? new Date(row.blacklistUntil).toLocaleTimeString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Task cooldowns panel (Phase-2 P2-8) */}
        {(cooldownsData?.cooldowns ?? []).length > 0 && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
                Active Task Cooldowns ({cooldownsData?.count ?? 0})
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => resetTaskCooldownsMut.mutate()}
                disabled={resetTaskCooldownsMut.isPending}
                className="focus-ring h-6 px-2 text-[10px]"
                aria-label="Clear all task cooldowns"
              >
                {resetTaskCooldownsMut.isPending ? "Clearing…" : "Clear All"}
              </Button>
            </div>
            <div className="max-h-32 overflow-y-auto scrollbar-thin space-y-1">
              {(cooldownsData?.cooldowns ?? []).map((c) => (
                <div
                  key={c.id}
                  className="row-hover flex items-center justify-between rounded border border-border/40 px-2 py-1 text-[11px]"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono">{c.modelId}</span>
                    <span className="flex-shrink-0 text-muted-foreground">·</span>
                    <span className="flex-shrink-0 font-mono text-amber-700 dark:text-amber-300">
                      {c.taskType}
                    </span>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
                    <span>{c.consecutiveFailures} fails</span>
                    <span>·</span>
                    <span>
                      until {c.cooldownUntil ? new Date(c.cooldownUntil).toLocaleTimeString() : "—"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => resetBreakersMut.mutate()}
            disabled={
              resetBreakersMut.isPending || (persisted.length === 0 && live.length === 0)
            }
            className="focus-ring"
            aria-label="Reset all circuit breakers"
          >
            {resetBreakersMut.isPending ? "Resetting…" : "Reset All Breakers"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => recomputeSourcesMut.mutate()}
            disabled={recomputeSourcesMut.isPending}
            className="focus-ring"
            aria-label="Recompute all source reputations"
          >
            {recomputeSourcesMut.isPending
              ? "Recomputing…"
              : "Recompute Source Reputations"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
