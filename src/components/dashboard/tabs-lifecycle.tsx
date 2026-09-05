"use client";

// LifecycleTab — the opportunity state-machine flowchart (Phase-3 STYLING-1).
//
// Visualizes the 14 OpportunityStatus values as a 3-row flowchart so operators
// can see at a glance where opportunities are piling up. Each node is a small
// card showing the status name, a Lucide icon, the count of opportunities
// currently in that status, and a colored border that matches the status'
// semantic color (sourced from `statusColor`).
//
// Layout:
//   Row 1 (Discovery):   discovered → researching → verified → rejected
//   Row 2 (Planning):     queued → planning → approved → executing → executed
//   Row 3 (Post-submit):  submitted → awaiting_payment → needs_improvement → paid / failed
//
// Interactions:
//   - Clicking a node calls `onSelectStatus(status)` — the parent switches
//     to the Opportunities tab pre-filtered to that status.
//   - Nodes for non-terminal statuses whose oldest opportunity is > 24h
//     old get an amber pulse ring (the "stuck" indicator).
//   - A sticky callout at the top lists every stuck status with a one-click
//     "jump to filtered list" CTA.
//
// Data source: GET /api/analytics/lifecycle →
//   { statuses: [{ status, count, oldestUpdatedAt }] }
//
// No heavy graph library is used — the flowchart is pure Tailwind divs + a
// handful of SVG arrows with `marker-end` chevrons.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
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
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  ArrowRight,
  RotateCw,
  Info,
  TrendingUp,
} from "lucide-react";
import { api, statusColor, type LifecycleAnalyticsResponse } from "./lib/api";
import { statusIcon } from "./lib/status-badge";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Layout: the 3 rows of the state machine + terminal-cluster definitions.
// ---------------------------------------------------------------------------

/** Stages (rows) of the opportunity lifecycle flowchart. */
const FLOW_ROWS: { label: string; hint: string; statuses: string[] }[] = [
  {
    label: "Discovery",
    hint: "Scanner → research → verification",
    statuses: ["discovered", "researching", "verified", "rejected"],
  },
  {
    label: "Planning & Execution",
    hint: "Queue → plan → approve → execute",
    statuses: ["queued", "planning", "approved", "executing", "executed"],
  },
  {
    label: "Post-submit",
    hint: "PR merged → payment → done",
    statuses: [
      "submitted",
      "awaiting_payment",
      "needs_improvement",
      "paid",
      "failed",
    ],
  },
];

/** Terminal statuses — never flagged as "stuck" (they're done). */
const TERMINAL_STATUSES = new Set([
  "rejected",
  "paid",
  "failed",
  "skipped",
  "cancelled",
]);

/** The 24h "stuck" threshold in ms. */
const STUCK_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LifecycleTab({
  onSelectStatus,
}: {
  /**
   * Called when the user clicks a status node. The parent typically switches
   * to the Opportunities tab pre-filtered to that status.
   */
  onSelectStatus: (status: string) => void;
}) {
  // Phase-3 dev-review #3 (priority #4): toggle between the fast midpoint
  // approximation (default) and the true arithmetic mean (fetches every
  // row's updatedAt — more accurate for skewed distributions, but O(n)).
  const [trueAverage, setTrueAverage] = React.useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["analytics", "lifecycle", { trueAverage }],
    queryFn: () => api.analytics.lifecycle({ trueAverage }),
    refetchInterval: 15_000,
  });

  // Phase-3 dev-review #3 (priority #5): historical trend chart. Fetches
  // the last 7 days of lifecycle snapshots (one row per status per hour).
  // The chart renders one area per status showing how the count trended.
  const { data: snapshotData, isLoading: snapshotsLoading } = useQuery({
    queryKey: ["analytics", "lifecycle", "snapshots", "7d"],
    queryFn: () =>
      fetch("/api/analytics/lifecycle/snapshot?days=7").then((r) => r.json()),
    refetchInterval: 60_000, // refresh every minute
  });

  // Build a chart-friendly data shape: one row per bucket, with a column
  // per status (so the area chart can stack them).
  const trendChartData = React.useMemo(() => {
    const snapshots: Array<{
      bucket: string;
      status: string;
      count: number;
      avgHoursInStatus: number;
      maxHoursInStatus: number;
      createdAt: string;
    }> = snapshotData?.snapshots ?? [];
    if (snapshots.length === 0) return [];
    // Group by bucket.
    const byBucket = new Map<string, Record<string, number | string>>();
    for (const s of snapshots) {
      const entry = byBucket.get(s.bucket) ?? { bucket: s.bucket };
      entry[s.status] = s.count;
      byBucket.set(s.bucket, entry);
    }
    // Sort by bucket ascending + return as array.
    return Array.from(byBucket.values()).sort((a, b) =>
      String(a.bucket).localeCompare(String(b.bucket))
    );
  }, [snapshotData]);

  // The set of statuses present in the snapshots (for the chart legend).
  const trendStatuses = React.useMemo(() => {
    const set = new Set<string>();
    for (const row of trendChartData) {
      for (const key of Object.keys(row)) {
        if (key !== "bucket") set.add(key);
      }
    }
    return Array.from(set).sort();
  }, [trendChartData]);

  // Build a lookup map: status → { count, oldestUpdatedAt, avgHoursInStatus, maxHoursInStatus }.
  const byStatus = React.useMemo(() => {
    const m = new Map<
      string,
      {
        count: number;
        oldestUpdatedAt: string | null;
        avgHoursInStatus?: number;
        maxHoursInStatus?: number;
      }
    >();
    for (const row of data?.statuses ?? []) {
      m.set(row.status, {
        count: row.count,
        oldestUpdatedAt: row.oldestUpdatedAt,
        avgHoursInStatus: row.avgHoursInStatus,
        maxHoursInStatus: row.maxHoursInStatus,
      });
    }
    // Ensure every status in FLOW_ROWS has an entry (so empty nodes render).
    for (const row of FLOW_ROWS) {
      for (const s of row.statuses) {
        if (!m.has(s)) {
          m.set(s, { count: 0, oldestUpdatedAt: null });
        }
      }
    }
    return m;
  }, [data]);

  // Compute the global max avgHoursInStatus across all statuses — used to
  // scale the per-node sparkline bars so they're comparable across nodes.
  const maxAvgHoursForScale = React.useMemo(() => {
    let max = 0;
    for (const row of data?.statuses ?? []) {
      if (typeof row.avgHoursInStatus === "number" && row.avgHoursInStatus > max) {
        max = row.avgHoursInStatus;
      }
    }
    // Floor at 24h so the "stuck threshold" is visually anchored.
    return Math.max(max, 24);
  }, [data]);

  // Compute the set of "stuck" statuses (non-terminal + oldest > 24h).
  const stuckStatuses = React.useMemo(() => {
    if (!data?.statuses) return [];
    const now = Date.now();
    const stuck: { status: string; count: number; ageHours: number }[] = [];
    for (const row of data.statuses) {
      if (TERMINAL_STATUSES.has(row.status)) continue;
      if (row.count === 0) continue;
      if (!row.oldestUpdatedAt) continue;
      const oldest = Date.parse(row.oldestUpdatedAt);
      if (!Number.isFinite(oldest)) continue;
      const age = now - oldest;
      if (age > STUCK_THRESHOLD_MS) {
        stuck.push({
          status: row.status,
          count: row.count,
          ageHours: Math.floor(age / (60 * 60 * 1000)),
        });
      }
    }
    return stuck.sort((a, b) => b.ageHours - a.ageHours);
  }, [data]);

  if (error) {
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
        Failed to load lifecycle analytics: {String(error)}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header + Stuck callout */}
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <RotateCw className="size-4 text-teal-500" />
              Opportunity Lifecycle
            </CardTitle>
            {/* Phase-3 dev-review #3 (priority #4): true-average toggle. */}
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                className="size-3 cursor-pointer accent-teal-500"
                checked={trueAverage}
                onChange={(e) => setTrueAverage(e.target.checked)}
                title="When ON, the avg hours are the true arithmetic mean (more accurate for skewed distributions, but slower — fetches every opportunity). When OFF, the avg is the midpoint between oldest + newest (fast approximation)."
              />
              True average
              {data?.trueAverage ? (
                <span className="rounded-sm bg-teal-500/15 px-1 text-[9px] font-medium text-teal-700 dark:text-teal-300">
                  exact
                </span>
              ) : (
                <span className="rounded-sm bg-muted px-1 text-[9px] text-muted-foreground">
                  approx
                </span>
              )}
            </label>
          </div>
          <CardDescription>
            The opportunity state machine — 14 statuses grouped into 3 stages.
            Click any node to filter the Opportunities tab to that status.
          </CardDescription>
        </CardHeader>
        {stuckStatuses.length > 0 && (
          <CardContent className="pt-0">
            <div className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-amber-800 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 animate-pulse text-amber-500" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {stuckStatuses.length} status
                  {stuckStatuses.length === 1 ? "" : "es"} stuck for more than
                  24 hours
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {stuckStatuses.map((s) => (
                    <button
                      key={s.status}
                      type="button"
                      onClick={() => onSelectStatus(s.status)}
                      className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium capitalize transition-colors hover:bg-amber-500/30"
                    >
                      {s.status.replace(/_/g, " ")}
                      <span className="tabular-nums opacity-70">
                        · {s.count} for {s.ageHours}h
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Flowchart */}
      <div className="space-y-3">
        {FLOW_ROWS.map((row, rowIdx) => (
          <Card
            key={row.label}
            className="overflow-hidden border-border/60 shadow-sm"
          >
            <CardHeader className="border-b border-border/50 pb-2">
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className="size-1.5 rounded-full bg-emerald-500"
                    aria-hidden
                  />
                  <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground/80">
                    Stage {rowIdx + 1} · {row.label}
                  </CardTitle>
                </div>
                <span className="hidden text-[10px] uppercase tracking-wide text-muted-foreground sm:inline">
                  {row.hint}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <div className="flex flex-wrap items-stretch gap-2 sm:flex-nowrap">
                  {row.statuses.map((status, i) => (
                    <React.Fragment key={status}>
                      <StatusNode
                        status={status}
                        count={byStatus.get(status)?.count ?? 0}
                        oldestUpdatedAt={
                          byStatus.get(status)?.oldestUpdatedAt ?? null
                        }
                        avgHoursInStatus={
                          byStatus.get(status)?.avgHoursInStatus
                        }
                        maxHoursInStatus={
                          byStatus.get(status)?.maxHoursInStatus
                        }
                        maxAvgHoursForScale={maxAvgHoursForScale}
                        onClick={() => onSelectStatus(status)}
                      />
                      {i < row.statuses.length - 1 && <NodeArrow />}
                    </React.Fragment>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Legend */}
      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Info className="size-4 text-muted-foreground" />
            Legend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-4">
            <LegendItem
              label="Discovery"
              swatchClass="bg-slate-500"
              hint="discovered, researching"
            />
            <LegendItem
              label="Verification"
              swatchClass="bg-cyan-500"
              hint="researching"
            />
            <LegendItem
              label="Verified / Queued"
              swatchClass="bg-emerald-500"
              hint="verified, queued, approved"
            />
            <LegendItem
              label="Active Work"
              swatchClass="bg-teal-500"
              hint="planning, executing"
            />
            <LegendItem
              label="Awaiting"
              swatchClass="bg-amber-500"
              hint="awaiting_payment"
            />
            <LegendItem
              label="Submitted PR"
              swatchClass="bg-orange-500"
              hint="submitted"
            />
            <LegendItem
              label="Needs Work"
              swatchClass="bg-rose-500"
              hint="needs_improvement"
            />
            <LegendItem
              label="Terminal"
              swatchClass="bg-red-500"
              hint="rejected, failed"
            />
          </div>
          <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="inline-flex h-3 w-3 animate-pulse rounded-full border-2 border-amber-500" />
            Amber pulse = a status with at least one opportunity older than 24h.
            Click to triage.
          </div>
        </CardContent>
      </Card>

      {/* Phase-3 dev-review #3 (priority #5): 7-day trend chart. Shows how
          the count per status has changed over the last 7 days so the
          operator can see whether bottlenecks are improving or worsening. */}
      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <TrendingUp className="size-4 text-teal-500" />
            7-day trend
          </CardTitle>
          <CardDescription>
            Opportunity count per status over the last 7 days. Stacked areas
            show where the pipeline is backing up. Data is snapshotted hourly
            (POST /api/analytics/lifecycle/snapshot).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {snapshotsLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : trendChartData.length === 0 ? (
            <div className="flex h-48 items-center justify-center rounded-md border border-dashed border-border/60 text-xs text-muted-foreground">
              No snapshots yet. Run{" "}
              <code className="mx-1 rounded bg-muted px-1 py-0.5 text-[10px]">
                curl -X POST /api/analytics/lifecycle/snapshot
              </code>{" "}
              to seed the trend data.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={trendChartData}>
                <defs>
                  {trendStatuses.map((status) => {
                    const c = statusColor(status);
                    return (
                      <linearGradient
                        key={status}
                        id={`grad-${status}`}
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="5%"
                          stopColor="currentColor"
                          stopOpacity={0.3}
                        />
                        <stop
                          offset="95%"
                          stopColor="currentColor"
                          stopOpacity={0}
                        />
                      </linearGradient>
                    );
                  })}
                </defs>
                <XAxis
                  dataKey="bucket"
                  tick={{ fontSize: 9 }}
                  tickFormatter={(b: string) => {
                    // Phase-3 DEV-REVIEW-6 (#4): format the bucket string
                    // (YYYY-MM-DDTHH) as a friendly "Mon DD" label.
                    // The bucket is UTC, so we parse it as such + format
                    // with the user's locale for readability.
                    const date = new Date(b + ":00:00.000Z");
                    if (isNaN(date.getTime())) return b.slice(0, 10);
                    return date.toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    });
                  }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 9 }}
                  allowDecimals={false}
                />
                <RTooltip
                  contentStyle={{
                    fontSize: 11,
                    background: "rgba(0,0,0,0.85)",
                    border: "none",
                    borderRadius: 4,
                    color: "#fff",
                  }}
                  labelStyle={{ fontSize: 10, opacity: 0.7 }}
                  // Phase-3 DEV-REVIEW-7 (#3): format the tooltip label
                  // (the bucket string YYYY-MM-DDTHH) as a friendly
                  // "Aug 23, 14:00" matching the X-axis style.
                  labelFormatter={(b: string) => {
                    const date = new Date(b + ":00:00.000Z");
                    if (isNaN(date.getTime())) return b;
                    return date.toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    });
                  }}
                />
                {trendStatuses.map((status) => {
                  const c = statusColor(status);
                  return (
                    <Area
                      key={status}
                      type="monotone"
                      dataKey={status}
                      stackId="1"
                      stroke={c.text}
                      fill={`url(#grad-${status})`}
                      fillOpacity={1}
                    />
                  );
                })}
              </AreaChart>
            </ResponsiveContainer>
          )}
          {trendStatuses.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {trendStatuses.map((status) => {
                const c = statusColor(status);
                return (
                  <div
                    key={status}
                    className="flex items-center gap-1 text-[10px]"
                  >
                    <span
                      className={cn("size-2 rounded-full", c.bg)}
                      style={{ color: "currentColor" }}
                    />
                    <span className="capitalize">{status.replace(/_/g, " ")}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * A single status node in the flowchart. Renders as a small card with:
 *   - colored top + left border (matches the status' semantic color)
 *   - the Lucide icon for that status
 *   - the status name (humanized)
 *   - the count of opportunities currently in that status (tabular-nums)
 *   - an amber pulse ring when the status is non-terminal + oldest > 24h
 *
 * The whole card is a button so it's keyboard-accessible.
 */
function StatusNode({
  status,
  count,
  oldestUpdatedAt,
  avgHoursInStatus,
  maxHoursInStatus,
  maxAvgHoursForScale,
  onClick,
}: {
  status: string;
  count: number;
  oldestUpdatedAt: string | null;
  avgHoursInStatus?: number;
  maxHoursInStatus?: number;
  maxAvgHoursForScale: number;
  onClick: () => void;
}) {
  const c = statusColor(status);
  const Icon = statusIcon(status);
  const isTerminal = TERMINAL_STATUSES.has(status);
  const isStuck = React.useMemo(() => {
    if (isTerminal || count === 0 || !oldestUpdatedAt) return false;
    const age = Date.now() - Date.parse(oldestUpdatedAt);
    return Number.isFinite(age) && age > STUCK_THRESHOLD_MS;
  }, [isTerminal, count, oldestUpdatedAt]);

  // Sparkline bar: shows avgHoursInStatus relative to maxAvgHoursForScale.
  // Renders a horizontal bar with two segments — the "healthy" portion (< 24h)
  // in the status's accent color, and the "stuck" portion (> 24h) in amber.
  // Only rendered when count > 0 + avgHoursInStatus is a finite number.
  const showSparkline =
    count > 0 &&
    typeof avgHoursInStatus === "number" &&
    Number.isFinite(avgHoursInStatus);
  const sparklinePct =
    typeof avgHoursInStatus === "number" && maxAvgHoursForScale > 0
      ? Math.min(100, (avgHoursInStatus / maxAvgHoursForScale) * 100)
      : 0;
  const stuckPct =
    typeof avgHoursInStatus === "number" && avgHoursInStatus > 24
      ? Math.min(100, ((avgHoursInStatus - 24) / maxAvgHoursForScale) * 100)
      : 0;
  const healthyPct = Math.max(0, sparklinePct - stuckPct);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex min-w-[120px] flex-1 flex-col gap-1.5 rounded-lg border bg-card/40 p-3 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-emerald-500/40 hover:bg-card/80 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50",
        c.border,
        c.borderLeft,
        isStuck &&
          "ring-2 ring-amber-500/70 ring-offset-1 ring-offset-background animate-pulse"
      )}
      aria-label={`Filter opportunities by status: ${status} (${count} current${typeof avgHoursInStatus === "number" ? `, avg ${avgHoursInStatus.toFixed(1)}h in status` : ""})`}
    >
      <div className="flex items-center justify-between gap-1">
        <span
          className={cn(
            "flex size-7 items-center justify-center rounded-full",
            c.bg,
            c.text
          )}
        >
          <Icon
            className={cn(
              "size-3.5",
              (status === "executing" || status === "running") &&
                "animate-spin"
            )}
            aria-hidden
          />
        </span>
        <span
          className={cn(
            "text-base font-semibold tracking-tight tabular-nums",
            count > 0 ? c.text : "text-muted-foreground/40",
            count === 0 && "font-normal"
          )}
          aria-label={`${count} opportunities in ${status.replace(/_/g, " ")}`}
        >
          {count}
        </span>
      </div>
      <div className="text-[11px] font-medium capitalize leading-tight text-foreground">
        {status.replace(/_/g, " ")}
      </div>
      {showSparkline ? (
        <div className="mt-0.5 space-y-1">
          {/* Sparkline bar — healthy portion in accent color, stuck portion in amber. */}
          <div
            className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
            role="img"
            aria-label={`Average ${avgHoursInStatus?.toFixed(1)} hours in this status (max ${maxHoursInStatus?.toFixed(1)}h)`}
          >
            <div
              className={cn("absolute inset-y-0 left-0 rounded-full", c.bg, c.text)}
              style={{ width: `${healthyPct}%` }}
            />
            <div
              className="absolute inset-y-0 rounded-full bg-amber-500/70"
              style={{
                left: `${healthyPct}%`,
                width: `${stuckPct}%`,
              }}
            />
          </div>
          <div className="flex items-center gap-1 text-[9px] tabular-nums">
            <span className="rounded-sm bg-muted/70 px-1 py-px text-muted-foreground">
              avg {avgHoursInStatus?.toFixed(1)}h
            </span>
            <span className="rounded-sm bg-muted/70 px-1 py-px text-muted-foreground">
              max {maxHoursInStatus?.toFixed(1)}h
            </span>
          </div>
        </div>
      ) : isTerminal ? (
        <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
          terminal
        </div>
      ) : null}
    </button>
  );
}

/**
 * Horizontal arrow between two nodes in the same row. Pure CSS — a thin
 * line with a chevron at the right end. Stays hidden on very narrow
 * viewports where the row wraps.
 */
function NodeArrow() {
  return (
    <div
      className="hidden shrink-0 items-center self-center text-muted-foreground/50 sm:flex"
      aria-hidden
    >
      <svg
        width="20"
        height="14"
        viewBox="0 0 20 14"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M0 7 H 14"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <path
          d="M14 1 L 19 7 L 14 13"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </div>
  );
}

function LegendItem({
  label,
  swatchClass,
  hint,
}: {
  label: string;
  swatchClass: string;
  hint: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "inline-flex size-3 shrink-0 rounded-sm border border-border/60",
          swatchClass
        )}
      />
      <div className="min-w-0">
        <div className="truncate font-medium">{label}</div>
        <div className="truncate text-[10px] text-muted-foreground">
          {hint}
        </div>
      </div>
    </div>
  );
}

// Exported for tests + the dashboard's command palette.
export { FLOW_ROWS as LIFECYCLE_ROWS };
export type LifecycleRow = (typeof FLOW_ROWS)[number];
export type LifecycleData = LifecycleAnalyticsResponse;
export { TERMINAL_STATUSES as LIFECYCLE_TERMINAL_STATUSES, STUCK_THRESHOLD_MS };
