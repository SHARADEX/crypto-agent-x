"use client";

// PublicDashboard — a read-only, shareable summary view of the agent.
//
// Rendered when the URL has `?view=public`. Consumes `/api/public/status`
// (which returns NO secrets — only headline metrics + opportunity counts +
// recent events). This is safe to share via a public link for grant
// applications, hackathon demos, or audits.
//
// The view is intentionally minimal: no mutating controls, no operator
// tokens, no internal API keys. Just the numbers + a "generated at"
// timestamp. Polls every 30s.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Activity,
  DollarSign,
  Target,
  Trophy,
  Zap,
  Shield,
  Clock,
  ExternalLink,
  ArrowLeft,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, formatRelativeTime, type PublicStatusResponse } from "./lib/api";
import { BadgePill, EmptyState } from "./ui-primitives";

interface PublicDashboardProps {
  onExitToOperator: () => void;
}

export function PublicDashboard({ onExitToOperator }: PublicDashboardProps) {
  const { data, isLoading, error } = useQuery<PublicStatusResponse>({
    queryKey: ["public", "status"],
    queryFn: () => api.public.status(),
    refetchInterval: 30_000,
  });

  if (error) {
    return (
      <div className="empty-state">
        <p className="text-sm font-medium text-red-600">Failed to load public status</p>
        <p className="text-xs text-muted-foreground">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </div>
    );
  }

  const agent = data?.agent;
  const earnings = data?.earnings;
  const opportunities = data?.opportunities;
  const topStrategies = data?.topStrategies ?? [];
  const models = data?.models;
  const recentEvents = data?.recentEvents ?? [];

  return (
    <div className="space-y-6">
      {/* Hero — public read-only banner */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="rounded-lg border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-teal-500/5 p-4 md:p-6"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Shield className="size-5 text-emerald-600 dark:text-emerald-400" />
              <h1 className="text-lg font-semibold sm:text-xl">
                CryptoEarn Agent — Public Status
              </h1>
            </div>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
              Read-only summary of the autonomous crypto-earning agent. Updated every 30 seconds.
              No sensitive data is exposed.
            </p>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            {agent && (
              <BadgePill
                color={
                  agent.emergencyStop
                    ? "red"
                    : agent.paused
                    ? "amber"
                    : agent.running
                    ? "emerald"
                    : "slate"
                }
                dot
                pulse={agent.running}
              >
                {agent.emergencyStop
                  ? "STOPPED"
                  : agent.paused
                  ? "PAUSED"
                  : agent.running
                  ? "RUNNING"
                  : "IDLE"}
              </BadgePill>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={onExitToOperator}
              className="focus-ring"
              aria-label="Exit to operator dashboard"
            >
              <ArrowLeft className="size-3" />
              <span className="hidden sm:inline">Operator View</span>
            </Button>
          </div>
        </div>
      </motion.div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <PublicKpi
          label="Verified Earnings"
          value={isLoading ? null : earnings?.verifiedNetUsd}
          format={(v) => `$${v.toFixed(2)}`}
          icon={<DollarSign className="size-4" />}
          accent="emerald"
          isLoading={isLoading}
        />
        <PublicKpi
          label="Verified Count"
          value={isLoading ? null : earnings?.verifiedCount}
          icon={<Trophy className="size-4" />}
          accent="teal"
          isLoading={isLoading}
        />
        <PublicKpi
          label="Opportunities"
          value={isLoading ? null : opportunities?.total}
          icon={<Target className="size-4" />}
          accent="blue"
          isLoading={isLoading}
        />
        <PublicKpi
          label="Cycles Run"
          value={isLoading ? null : agent?.cycleCount}
          icon={<Activity className="size-4" />}
          accent="purple"
          isLoading={isLoading}
        />
      </div>

      {/* Agent state + autonomy */}
      {agent && (
        <Card className="card-hover-lift border-border/60">
          <CardContent className="p-4 md:p-5">
            <div className="mb-3 flex items-center gap-2">
              <Zap className="size-4 text-emerald-600 dark:text-emerald-400" />
              <h3 className="text-sm font-semibold">Agent State</h3>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <PublicField label="Autonomy Mode" value={agent.autonomyMode} />
              <PublicField
                label="Last Cycle"
                value={
                  agent.lastCycleAt
                    ? formatRelativeTime(agent.lastCycleAt)
                    : "never"
                }
                title={agent.lastCycleAt ? new Date(agent.lastCycleAt).toLocaleString() : undefined}
              />
              <PublicField
                label="Last Result"
                value={agent.lastCycleResult ?? "—"}
              />
              <PublicField
                label="Running Since"
                value={agent.lastCycleAt ? "active" : "idle"}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Opportunities by status */}
      {opportunities && (
        <Card className="card-hover-lift border-border/60">
          <CardContent className="p-4 md:p-5">
            <div className="mb-3 flex items-center gap-2">
              <Target className="size-4 text-emerald-600 dark:text-emerald-400" />
              <h3 className="text-sm font-semibold">Opportunities by Status</h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(opportunities.byStatus).map(([status, count]) => (
                <BadgePill
                  key={status}
                  color={statusColor(status)}
                >
                  {status.replace(/_/g, " ")}: {count}
                </BadgePill>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top strategies */}
      {topStrategies.length > 0 && (
        <Card className="card-hover-lift border-border/60">
          <CardContent className="p-4 md:p-5">
            <div className="mb-3 flex items-center gap-2">
              <Trophy className="size-4 text-amber-500" />
              <h3 className="text-sm font-semibold">Top Strategies</h3>
            </div>
            <div className="space-y-2">
              {topStrategies.map((s, i) => (
                <div
                  key={s.strategy}
                  className="row-hover flex items-center justify-between rounded-md border border-border/40 px-3 py-2"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex size-6 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                      {i + 1}
                    </span>
                    <span className="font-mono text-sm">{s.strategy}</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs">
                    <span className="text-muted-foreground">
                      {s.completed}/{s.attempted} done
                    </span>
                    <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                      ${(s.totalNetUsd ?? 0).toFixed(2)}
                    </span>
                    <span className="font-mono text-muted-foreground">
                      ${(s.avgHourly ?? 0).toFixed(2)}/hr
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Models summary */}
      {models && (
        <Card className="card-hover-lift border-border/60">
          <CardContent className="p-4 md:p-5">
            <div className="mb-3 flex items-center gap-2">
              <Activity className="size-4 text-sky-500" />
              <h3 className="text-sm font-semibold">Models by Provider</h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(models.byProvider).map(([provider, count]) => (
                <BadgePill key={provider} color="slate">
                  {provider}: {count}
                </BadgePill>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent events (read-only) */}
      <Card className="border-border/60">
        <CardContent className="p-4 md:p-5">
          <div className="mb-3 flex items-center gap-2">
            <Clock className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Recent Activity</h3>
            <span className="text-xs text-muted-foreground">(last 10 events)</span>
          </div>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : recentEvents.length === 0 ? (
            <EmptyState
              title="No recent events"
              description="The agent hasn't logged any activity yet."
            />
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto scrollbar-thin">
              {recentEvents.map((e) => (
                <div
                  key={e.id}
                  className="row-hover flex items-center gap-2 rounded-md px-2 py-1.5 text-xs"
                >
                  <BadgePill color={eventLevelColor(e.level)} className="flex-shrink-0">
                    {e.level}
                  </BadgePill>
                  <span
                    className="font-mono text-[10px] text-muted-foreground"
                    title={new Date(e.createdAt).toLocaleString()}
                  >
                    {formatRelativeTime(e.createdAt)}
                  </span>
                  <span className="flex-shrink-0 font-mono text-[10px] text-muted-foreground">
                    [{e.agent}]
                  </span>
                  <span className="truncate font-mono">{e.event}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Footer — generated-at timestamp */}
      <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
        <Clock className="size-3" />
        <span>
          Generated at{" "}
          {data?.generatedAt
            ? new Date(data.generatedAt).toLocaleString()
            : "—"}
        </span>
        {data?.publicReadOnly && (
          <Badge variant="outline" className="text-[10px]">
            read-only mode
          </Badge>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function PublicKpi({
  label,
  value,
  format,
  icon,
  accent,
  isLoading,
}: {
  label: string;
  value: number | null | undefined;
  format?: (v: number) => string;
  icon?: React.ReactNode;
  accent: "emerald" | "amber" | "red" | "slate" | "teal" | "blue" | "purple";
  isLoading?: boolean;
}) {
  const ACCENT_TEXT: Record<string, string> = {
    emerald: "text-emerald-600 dark:text-emerald-400",
    amber: "text-amber-600 dark:text-amber-400",
    red: "text-red-600 dark:text-red-400",
    slate: "text-slate-600 dark:text-slate-300",
    teal: "text-teal-600 dark:text-teal-400",
    blue: "text-sky-600 dark:text-sky-400",
    purple: "text-purple-600 dark:text-purple-400",
  };
  const ACCENT_BG: Record<string, string> = {
    emerald: "bg-emerald-500/10",
    amber: "bg-amber-500/10",
    red: "bg-red-500/10",
    slate: "bg-slate-500/10",
    teal: "bg-teal-500/10",
    blue: "bg-sky-500/10",
    purple: "bg-purple-500/10",
  };

  const display = (() => {
    if (value === null || value === undefined) return "—";
    if (format) return format(value);
    return value.toLocaleString();
  })();

  return (
    <Card className="card-hover-lift border-border/60">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          {icon && (
            <span
              className={`flex size-7 items-center justify-center rounded-md ${ACCENT_BG[accent]}`}
            >
              {icon}
            </span>
          )}
        </div>
        <div
          className={`number-tick mt-2 font-mono text-2xl font-semibold tabular-nums ${ACCENT_TEXT[accent]}`}
          key={String(value)}
        >
          {isLoading ? <Skeleton className="h-7 w-20" /> : display}
        </div>
      </CardContent>
    </Card>
  );
}

function PublicField({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div title={title}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-mono text-sm capitalize">{value}</div>
    </div>
  );
}

function statusColor(status: string): "emerald" | "amber" | "red" | "slate" | "blue" | "purple" {
  if (status === "paid" || status === "verified") return "emerald";
  if (status === "queued" || status === "planning" || status === "approved") return "blue";
  if (status === "executing" || status === "executed" || status === "awaiting_payment") return "purple";
  if (status === "submitted") return "amber"; // Phase-3 fix (Issue 10): awaiting PR review/merge.
  if (status === "needs_improvement") return "amber";
  if (status === "discovered" || status === "researching") return "slate";
  if (status === "failed" || status === "rejected") return "red";
  return "slate";
}

function eventLevelColor(level: string): "emerald" | "amber" | "red" | "slate" | "blue" {
  switch (level) {
    case "error":
    case "critical":
      return "red";
    case "warn":
      return "amber";
    case "info":
      return "emerald";
    case "debug":
      return "slate";
    default:
      return "slate";
  }
}
