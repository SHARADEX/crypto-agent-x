"use client";

// OverviewTab v2 — "Daily Briefing".
//
// Redesigned around the operator's real daily check-in ritual:
//   1. Greeting + what changed since last visit
//   2. Action Center — ONE consolidated strip of things needing attention
//      (replaces the three stacked banners of the old design)
//   3. Hero KPIs — the 4 numbers that matter
//   4. Pipeline funnel — where opportunities sit right now
//   5. Top picks — the highest-EV opportunities with one-click view
//   6. Activity feed — the last agent events
//
// Dev metrics (token budgets, RPC counts) live in the sidebar health card,
// NOT on this page. The briefing answers "what do I need to know/do today?"

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  CircleDollarSign,
  Radar,
  Target,
  CheckCircle2,
  AlertTriangle,
  Bell,
  Play,
  GitBranch,
  ArrowRight,
  Coins,
  Zap,
  ShieldAlert,
  ChevronRight,
  Sparkles,
  Star,
  TrendingUp,
  Clock,
  KeyRound,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  api,
  formatRelativeTime,
  formatUsd,
  statusColor,
  truncateText,
} from "./lib/api";
import { ScoreBar } from "./score-bar";
import { WatchStar } from "./watch-star";
import { KpiCard } from "./ui-primitives";
import {
  DEADLINE_ACTIVE_STATUSES,
  daysUntil,
  deadlineUrgency,
} from "./lib/deadline";
import type { Opportunity } from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// Greeting — time-aware + "since last visit" delta
// ---------------------------------------------------------------------------

const LAST_VISIT_KEY = "cryptoearn-last-briefing-visit";

function greeting(): { text: string; icon: React.ComponentType<{ className?: string }> } {
  const h = new Date().getHours();
  if (h < 5) return { text: "Working late", icon: Moonish };
  if (h < 12) return { text: "Good morning", icon: SunRise };
  if (h < 17) return { text: "Good afternoon", icon: Sunish };
  return { text: "Good evening", icon: Moonish };
}
function Sunish({ className }: { className?: string }) {
  return <Sparkles className={className} />;
}
function Moonish({ className }: { className?: string }) {
  return <Clock className={className} />;
}
function SunRise({ className }: { className?: string }) {
  return <TrendingUp className={className} />;
}

function BriefingHeader({
  lastVisit,
  newSince,
  lastCycle,
  cycleCount,
}: {
  lastVisit: Date | null;
  newSince: number;
  lastCycle: string | null;
  cycleCount: number;
}) {
  const g = greeting();
  const GIcon = g.icon;
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <GIcon className="size-4 text-emerald-500" />
          <h2 className="text-lg font-bold tracking-tight sm:text-xl">
            {g.text}, Operator
          </h2>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground sm:text-[13px]">
          {lastVisit
            ? `${newSince > 0 ? `${newSince} new opportunit${newSince === 1 ? "y" : "ies"} since your last visit · ` : ""}last visit ${formatRelativeTime(lastVisit.toISOString())}`
            : "This is your first briefing. The agent has been working — here's the state of the system."}
        </p>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Zap className="size-3 text-emerald-500" />
          {cycleCount} cycle{cycleCount === 1 ? "" : "s"} run
        </span>
        {lastCycle && (
          <span className="hidden items-center gap-1.5 sm:flex">
            · last {formatRelativeTime(lastCycle)}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action Center — consolidated "needs your attention" strip
// ---------------------------------------------------------------------------

interface ActionItem {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  text: string;
  cta: string;
  onClick: () => void;
  tone: "danger" | "warn" | "info";
}

function ActionCenter({
  pendingApprovals,
  stuckCount,
  agentIdle,
  killReason,
  urgentDeadlines,
  githubTokenSet,
  onGoApprovals,
  onGoLifecycle,
  onGoClosingSoon,
  onRunCycle,
  onConnectGithub,
}: {
  pendingApprovals: number;
  stuckCount: number;
  agentIdle: boolean;
  killReason?: string;
  urgentDeadlines: number;
  /** v0.4.6: null = unknown (API unreachable) — the connect item is
   *  fail-safe and only renders when presence is confirmed missing. */
  githubTokenSet: boolean | null;
  onGoApprovals: () => void;
  onGoLifecycle: () => void;
  onGoClosingSoon: () => void;
  onRunCycle: () => void;
  onConnectGithub: () => void;
}) {
  const actions: ActionItem[] = [];

  // v0.4.6: the top operator-blocked priority — surfaced where the operator
  // already looks every morning. Approvals can't ship without the token.
  if (githubTokenSet === false) {
    actions.push({
      id: "github-token",
      icon: KeyRound,
      text: `PR submission locked — GITHUB_TOKEN not set${pendingApprovals > 0 ? ` · ${pendingApprovals} approval${pendingApprovals === 1 ? "" : "s"} waiting to ship` : ""}. Connect GitHub to unlock it.`,
      cta: "Connect",
      onClick: onConnectGithub,
      tone: "warn",
    });
  }
  if (killReason) {
    actions.push({
      id: "kill",
      icon: ShieldAlert,
      text: `Kill switch engaged — ${truncateText(killReason, 70)}`,
      cta: "View system",
      onClick: onGoLifecycle,
      tone: "danger",
    });
  }
  if (urgentDeadlines > 0) {
    actions.push({
      id: "deadlines",
      icon: Clock,
      text: `${urgentDeadlines} opportunit${urgentDeadlines === 1 ? "y" : "ies"} with a deadline inside 3 days — act or skip`,
      cta: "Triage",
      onClick: onGoClosingSoon,
      tone: "warn",
    });
  }
  if (pendingApprovals > 0) {
    actions.push({
      id: "approvals",
      icon: GitBranch,
      text: `${pendingApprovals} approval${pendingApprovals === 1 ? "" : "s"} awaiting your decision`,
      cta: "Review",
      onClick: onGoApprovals,
      tone: "warn",
    });
  }
  if (stuckCount > 0) {
    actions.push({
      id: "stuck",
      icon: AlertTriangle,
      text: `${stuckCount} opportunit${stuckCount === 1 ? "y" : "ies"} stuck in the pipeline`,
      cta: "Inspect",
      onClick: onGoLifecycle,
      tone: "warn",
    });
  }
  if (agentIdle && !killReason) {
    actions.push({
      id: "idle",
      icon: Play,
      text: "Agent is idle — run a cycle to resume discovery",
      cta: "Run cycle",
      onClick: onRunCycle,
      tone: "info",
    });
  }

  if (actions.length === 0) {
    return (
      <Card className="border-emerald-500/25 bg-emerald-500/[0.04]">
        <CardContent className="flex items-center gap-3 p-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/15">
            <CheckCircle2 className="size-4.5 text-emerald-500" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
              All clear — nothing needs your attention
            </p>
            <p className="text-xs text-muted-foreground">
              The agent is working autonomously. Next actions will appear here.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="action-strip space-y-2 rounded-xl p-3">
      <p className="flex items-center gap-2 px-1 pb-1 text-[11px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
        <Bell className="size-3.5" />
        Needs your attention ({actions.length})
      </p>
      {actions.map((a) => {
        const AIcon = a.icon;
        return (
          <div
            key={a.id}
            className={cn(
              "flex items-center gap-3 rounded-lg border border-border/50 bg-background/60 p-2.5 transition-colors hover:border-border",
              a.id === "github-token" && "border-amber-500/30 bg-amber-500/[0.04]"
            )}
          >
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full",
                a.tone === "danger"
                  ? "bg-red-500/15 text-red-600 dark:text-red-400"
                  : a.tone === "warn"
                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    : "bg-sky-500/15 text-sky-600 dark:text-sky-400"
              )}
            >
              <AIcon className="size-4" />
            </span>
            <p className="min-w-0 flex-1 text-[13px] leading-snug">{a.text}</p>
            <Button
              size="sm"
              variant={a.id === "github-token" ? "default" : "outline"}
              className={cn(
                "h-7 shrink-0 gap-1 text-[11px]",
                a.id === "github-token" &&
                  "bg-amber-600 text-white hover:bg-amber-600/90"
              )}
              onClick={a.onClick}
            >
              {a.cta}
              <ChevronRight className="size-3" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline funnel — horizontal stacked segments by status
// ---------------------------------------------------------------------------

const FUNNEL_ORDER: {
  status: string;
  label: string;
  color: string;
}[] = [
  { status: "discovered", label: "Discovered", color: "bg-slate-500/70" },
  { status: "verified", label: "Verified", color: "bg-sky-500/80" },
  { status: "queued", label: "Queued", color: "bg-violet-500/80" },
  { status: "approved", label: "Approved", color: "bg-cyan-500/80" },
  { status: "executing", label: "Executing", color: "bg-amber-500/80" },
  { status: "executed", label: "Executed", color: "bg-orange-500/80" },
  { status: "submitted", label: "Submitted", color: "bg-lime-500/80" },
  { status: "awaiting_payment", label: "Awaiting pay", color: "bg-yellow-400/90" },
  { status: "paid", label: "Paid", color: "bg-emerald-500" },
  { status: "rejected", label: "Rejected", color: "bg-red-500/60" },
  { status: "failed", label: "Failed", color: "bg-red-600/70" },
  { status: "needs_improvement", label: "Rework", color: "bg-fuchsia-500/70" },
];

function PipelineFunnel({
  byStatus,
  total,
  onSelectStatus,
  isLoading,
}: {
  byStatus: Record<string, number>;
  total: number;
  onSelectStatus: (s: string) => void;
  isLoading: boolean;
}) {
  if (isLoading) {
    return <Skeleton className="h-24 w-full rounded-xl" />;
  }

  const entries = FUNNEL_ORDER.map((f) => ({ ...f, count: byStatus[f.status] ?? 0 })).filter(
    (f) => f.count > 0
  );
  const max = Math.max(...entries.map((e) => e.count), 1);

  if (entries.length === 0) {
    return (
      <div className="flex h-24 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border/60 text-center">
        <Radar className="size-4 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Pipeline is empty — run a cycle to discover opportunities
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {/* Stacked proportional bar */}
      <div
        className="flex h-6 w-full overflow-hidden rounded-full bg-muted/50"
        role="img"
        aria-label={`Pipeline distribution across ${total} opportunities`}
      >
        {entries.map((e) => (
          <button
            key={e.status}
            type="button"
            className={cn("funnel-seg h-full first:rounded-l-full last:rounded-r-full hover:opacity-80", e.color)}
            style={{ width: `${Math.max((e.count / total) * 100, 2.5)}%` }}
            onClick={() => onSelectStatus(e.status)}
            title={`${e.label}: ${e.count}`}
            aria-label={`${e.label}: ${e.count}`}
          />
        ))}
      </div>
      {/* Row list */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        {entries.map((e) => (
          <button
            key={e.status}
            type="button"
            className="group flex items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted/60"
            onClick={() => onSelectStatus(e.status)}
          >
            <span className={cn("size-2 shrink-0 rounded-full", e.color)} />
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground group-hover:text-foreground">
              {e.label}
            </span>
            <span className="font-mono text-[11px] font-semibold tabular-nums">{e.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Watchlist — starred opportunities for the daily check-in (v0.4.1)
// ---------------------------------------------------------------------------

function WatchlistSection({
  opportunities,
  onOpen,
  onGoOpportunities,
}: {
  opportunities: Opportunity[];
  onOpen: (id: string) => void;
  onGoOpportunities: () => void;
}) {
  if (opportunities.length === 0) return null;

  return (
    <Card className="min-w-0 border-amber-500/30 bg-amber-500/[0.03]">
      <CardContent className="min-w-0 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Star className="size-4 shrink-0 fill-amber-500 text-amber-500" aria-hidden />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">Your Watchlist</h3>
              <p className="text-[11px] text-muted-foreground">
                {opportunities.length} starred for later review
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-[11px] text-muted-foreground"
            onClick={onGoOpportunities}
          >
            All opportunities
            <ChevronRight className="size-3" />
          </Button>
        </div>
        <ul className="space-y-2">
          {opportunities.slice(0, 5).map((opp, i) => {
            const sc = statusColor(opp.status);
            return (
              <motion.li
                key={opp.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
              >
                <div className="row-hover flex w-full items-center gap-3 rounded-lg border border-border/50 bg-card p-3">
                  <button
                    type="button"
                    onClick={() => onOpen(opp.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    aria-label={`Open ${opp.title}`}
                  >
                    <span className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold leading-tight">
                        {opp.title}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span
                          className={cn(
                            "rounded-full border px-1.5 py-px font-medium",
                            sc.bg,
                            sc.text,
                            sc.border
                          )}
                        >
                          {sc.label}
                        </span>
                        <span className="font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                          {formatUsd(opp.reward.estimated_usd, { compact: true })}
                        </span>
                        <span>·</span>
                        <span>{opp.organization || opp.source}</span>
                      </div>
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <span
                      className="text-[10px] tabular-nums text-muted-foreground"
                      title="Risk-adjusted expected value per hour"
                    >
                      {formatUsd(opp.riskAdjustedHourly, { compact: true })}/hr
                    </span>
                    <WatchStar id={opp.id} watched={!!opp.watched} />
                  </div>
                </div>
              </motion.li>
            );
          })}
          {opportunities.length > 5 && (
            <li className="pt-0.5 text-center text-[10px] text-muted-foreground">
              + {opportunities.length - 5} more on the Opportunities tab
            </li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Closing soon — deadline urgency for the daily check-in (v0.4.2)
// (urgency helpers live in ./lib/deadline — shared with Opportunities tab)
// ---------------------------------------------------------------------------

export function ClosingSoonSection({
  opportunities,
  onOpen,
  onGoOpportunities,
}: {
  opportunities: Opportunity[];
  onOpen: (id: string) => void;
  onGoOpportunities: () => void;
}) {
  // Split into "closing" (future deadline, active) + "passed" (overdue
  // + still active — the operator should know work is likely wasted).
  const active = opportunities.filter((o) =>
    DEADLINE_ACTIVE_STATUSES.has(o.status)
  );
  const closing = active
    .filter((o) => o.deadline && Date.parse(o.deadline) > Date.now())
    .sort(
      (a, b) => Date.parse(a.deadline!) - Date.parse(b.deadline!)
    )
    .slice(0, 4);
  const passedCount = active.filter(
    (o) => o.deadline && Date.parse(o.deadline) <= Date.now()
  ).length;

  if (closing.length === 0 && passedCount === 0) return null;

  return (
    <Card
      className={cn(
        "min-w-0",
        closing.some((o) => daysUntil(o.deadline!) <= 3)
          ? "border-red-500/30 bg-red-500/[0.02]"
          : "border-border/60"
      )}
    >
      <CardContent className="min-w-0 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Clock className="size-4 shrink-0 text-amber-500" aria-hidden />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">Closing Soon</h3>
              <p className="text-[11px] text-muted-foreground">
                {closing.length > 0
                  ? "Deadlines within reach — act or skip"
                  : "No upcoming deadlines"}
                {passedCount > 0 && (
                  <span className="text-red-600 dark:text-red-400">
                    {" "}· {passedCount} past deadline
                  </span>
                )}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-[11px] text-muted-foreground"
            onClick={onGoOpportunities}
          >
            All opportunities
            <ChevronRight className="size-3" />
          </Button>
        </div>
        {closing.length > 0 && (
          <ul className="space-y-2">
            {closing.map((opp, i) => {
              const d = daysUntil(opp.deadline!);
              const u = deadlineUrgency(d);
              const sc = statusColor(opp.status);
              return (
                <motion.li
                  key={opp.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                >
                  <div
                    className={cn(
                      "row-hover flex w-full items-center gap-3 rounded-lg border bg-card p-3",
                      u.ringClass
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onOpen(opp.id)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      aria-label={`Open ${opp.title} — ${u.label}`}
                    >
                      <span className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold leading-tight">
                          {opp.title}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span
                            className={cn(
                              "rounded-full border px-1.5 py-px font-medium",
                              sc.bg,
                              sc.text,
                              sc.border
                            )}
                          >
                            {sc.label}
                          </span>
                          <span className="font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                            {formatUsd(opp.reward.estimated_usd, {
                              compact: true,
                            })}
                          </span>
                          <span>·</span>
                          <span>{opp.organization || opp.source}</span>
                        </div>
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums",
                          u.className
                        )}
                        title={
                          opp.deadline
                            ? new Date(opp.deadline).toLocaleString()
                            : undefined
                        }
                      >
                        {u.label}
                      </span>
                      <WatchStar id={opp.id} watched={!!opp.watched} />
                    </div>
                  </div>
                </motion.li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Top picks — highest risk-adjusted value opportunities
// ---------------------------------------------------------------------------

function TopPicks({
  opportunities,
  isLoading,
  onOpen,
}: {
  opportunities: Opportunity[];
  isLoading: boolean;
  onOpen: (id: string) => void;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (opportunities.length === 0) {
    return (
      <div className="flex h-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border/60 text-center">
        <Target className="size-4 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">No open opportunities yet</p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {opportunities.map((opp, i) => {
        const sc = statusColor(opp.status);
        const du = opp.deadline
          ? deadlineUrgency(daysUntil(opp.deadline))
          : null;
        return (
          <motion.li
            key={opp.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
          >
            {/* v0.4.3 fix: row is a div[role=button] (was a real <button>) —
                nesting the WatchStar <button> inside a <button> is invalid
                HTML and raised hydration errors in the console. */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => onOpen(opp.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(opp.id);
                }
              }}
              className="card-hover-lift row-hover flex w-full cursor-pointer items-center gap-3 rounded-lg border border-border/50 bg-card p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500/60"
              aria-label={`Open ${opp.title}`}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 font-mono text-[13px] font-bold text-emerald-600 dark:text-emerald-400">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold leading-tight">
                  {opp.title}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className={cn("rounded-full border px-1.5 py-px font-medium", sc.bg, sc.text, sc.border)}>
                    {sc.label}
                  </span>
                  <span className="font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                    {formatUsd(opp.reward.estimated_usd, { compact: true })}
                  </span>
                  <span>·</span>
                  <span>{opp.organization || opp.source}</span>
                  {opp.deadline && du && (
                    <span
                      className={cn(
                        "rounded-full border px-1.5 py-px font-semibold tabular-nums",
                        du.className
                      )}
                      title={`Deadline: ${new Date(opp.deadline).toLocaleString()}`}
                    >
                      {du.label}
                    </span>
                  )}
                </div>
              </div>
              <div className="hidden w-24 shrink-0 sm:block">
                <p className="mb-1 text-right text-[9px] uppercase tracking-wide text-muted-foreground">
                  EV / hr
                </p>
                <ScoreBar
                  value={opp.riskAdjustedHourly}
                  max={Math.max(...opportunities.map((o) => o.riskAdjustedHourly), 1)}
                />
              </div>
              {/* v0.4.1: quick star for pinning a pick */}
              <WatchStar id={opp.id} watched={!!opp.watched} />
              <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
          </motion.li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Activity feed — compact recent events
// ---------------------------------------------------------------------------

function ActivityFeed({
  events,
  isLoading,
}: {
  events: Array<{ id: string; agent: string; level: string; event: string; createdAt: string }>;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">
        No recent activity
      </p>
    );
  }

  return (
    <ul className="scrollbar-thin max-h-72 space-y-1 overflow-y-auto pr-1">
      {events.map((e) => {
        return (
          <li
            key={e.id}
            className="row-hover flex items-center gap-2 rounded px-1.5 py-1 text-[11px]"
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", e.level === "error" || e.level === "critical" ? "bg-red-500" : e.level === "warn" ? "bg-amber-500" : e.level === "debug" ? "bg-slate-500" : "bg-emerald-500")} />
            <span className="w-20 shrink-0 truncate font-medium text-muted-foreground">
              {e.agent}
            </span>
            <span className="min-w-0 flex-1 truncate">{e.event}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {formatRelativeTime(e.createdAt)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OverviewTab({
  onOpenOpportunity,
  onNavigate,
  onRunCycle,
  onOpenTerminal,
}: {
  onOpenOpportunity: (id: string) => void;
  onNavigate: (
    tab: string,
    statusFilter?: string,
    opts?: { closingSoon?: boolean }
  ) => void;
  onRunCycle: () => void;
  /** v0.4.6: opens the docked terminal with the GITHUB_TOKEN connect flow
   *  (pre-filled echo command + focused input). */
  onOpenTerminal: () => void;
}) {
  // Track last-visit for the "since your last visit" line.
  const [lastVisit, setLastVisit] = React.useState<Date | null>(null);
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
    try {
      const raw = localStorage.getItem(LAST_VISIT_KEY);
      if (raw) setLastVisit(new Date(raw));
      localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
    } catch {
      // ignore
    }
  }, []);

  const { data: analytics, isLoading: analyticsLoading } = useQuery({
    queryKey: ["analytics"],
    queryFn: () => api.analytics.get(),
    refetchInterval: 30_000,
  });

  const { data: status } = useQuery({
    queryKey: ["agent-status"],
    queryFn: () => api.agent.status(),
    refetchInterval: 10_000,
  });

  const { data: pendingApprovals } = useQuery({
    queryKey: ["approvals", "pending-count"],
    queryFn: () => api.approvals.list({ status: "pending", limit: 1 }),
    refetchInterval: 15_000,
  });
  const pendingCount = pendingApprovals?.count ?? 0;

  // v0.4.6: GITHUB_TOKEN presence — same endpoint the terminal panel reads
  // (GET /api/terminal returns a presence boolean; the value never leaves
  // the server). Powers the Action Center "Connect GitHub" item.
  const { data: githubTokenSet } = useQuery<boolean | null>({
    queryKey: ["terminal-token-status"],
    queryFn: async () => {
      const res = await fetch("/api/terminal");
      if (!res.ok) throw new Error("terminal status unavailable");
      const data = (await res.json()) as {
        tokenStatus?: { githubTokenSet?: boolean };
      };
      return data.tokenStatus?.githubTokenSet ?? null;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });

  const { data: opps } = useQuery({
    queryKey: ["opportunities", "briefing"],
    queryFn: () =>
      api.opportunities.list({ limit: 500 } as Parameters<typeof api.opportunities.list>[0]),
    refetchInterval: 60_000,
  });

  const killReason = status?.killSwitch?.reason;
  const running = !!status?.running && !status?.paused && !status?.emergencyStop;

  // Derive funnel + stuck + top picks from the opportunities list.
  const opportunities = opps?.opportunities ?? [];
  const byStatus: Record<string, number> = {};
  for (const o of opportunities) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

  const lastVisitTime = lastVisit?.getTime() ?? 0;
  const newSince = mounted
    ? opportunities.filter((o) => new Date(o.createdAt).getTime() > lastVisitTime).length
    : 0;

  const ACTIVE_STATUSES = new Set([
    "queued",
    "approved",
    "executing",
    "executed",
    "submitted",
    "awaiting_payment",
    "needs_improvement",
  ]);
  const pipelineValue = opportunities
    .filter((o) => ACTIVE_STATUSES.has(o.status))
    .reduce((sum, o) => sum + (o.expectedValue ?? o.reward.estimated_usd ?? 0), 0);

  // Stuck = active + created > 36h ago
  const stuckCount = opportunities.filter(
    (o) => ACTIVE_STATUSES.has(o.status) && Date.now() - new Date(o.createdAt).getTime() > 36 * 3600 * 1000
  ).length;

  const topPicks = [...opportunities]
    .filter((o) => !["rejected", "failed", "paid"].includes(o.status))
    .sort((a, b) => (b.riskAdjustedHourly ?? 0) - (a.riskAdjustedHourly ?? 0))
    .slice(0, 4);

  // v0.4.1: starred opportunities for the daily check-in.
  const watched = React.useMemo(
    () => opportunities.filter((o) => o.watched),
    [opportunities]
  );

  // v0.4.3: urgent deadlines — active + (overdue OR ≤3 days out). Feeds the
  // Action Center triage strip.
  const urgentDeadlines = React.useMemo(
    () =>
      opportunities.filter(
        (o) =>
          DEADLINE_ACTIVE_STATUSES.has(o.status) &&
          o.deadline &&
          daysUntil(o.deadline) <= 3
      ).length,
    [opportunities]
  );

  const recentEvents = (analytics?.recentEvents ?? []).slice(0, 14);

  return (
    <div className="space-y-4">
      <BriefingHeader
        lastVisit={lastVisit}
        newSince={newSince}
        lastCycle={status?.lastCycleAt ?? null}
        cycleCount={status?.cycleCount ?? 0}
      />

      <ActionCenter
        pendingApprovals={pendingCount}
        stuckCount={stuckCount}
        agentIdle={!running}
        killReason={killReason}
        urgentDeadlines={urgentDeadlines}
        githubTokenSet={githubTokenSet ?? null}
        onGoApprovals={() => onNavigate("approvals")}
        onGoLifecycle={() => onNavigate("lifecycle")}
        onGoClosingSoon={() => onNavigate("opportunities", undefined, { closingSoon: true })}
        onRunCycle={onRunCycle}
        onConnectGithub={onOpenTerminal}
      />

      {/* Hero KPIs */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard
          label="Verified Earnings"
          value={analytics?.totalVerifiedEarningsUsd ?? 0}
          format={(v) => formatUsd(v)}
          accent="emerald"
          icon={<CircleDollarSign className="size-3.5" />}
          hint={
            (analytics?.totalVerifiedEarningsUsd ?? 0) === 0
              ? "first payout lands here"
              : "on-chain confirmed"
          }
          isLoading={analyticsLoading}
        />
        <KpiCard
          label="Pipeline Value"
          value={pipelineValue}
          format={(v) => formatUsd(v, { compact: true })}
          accent="amber"
          icon={<Coins className="size-3.5" />}
          hint={
            pipelineValue === 0
              ? "approve work to build the pipeline"
              : "expected, in-flight"
          }
          isLoading={analyticsLoading}
        />
        <KpiCard
          label="Opportunities"
          value={opps?.total ?? analytics?.opportunitiesDiscovered ?? 0}
          format={(v) => v.toLocaleString()}
          accent="teal"
          icon={<Radar className="size-3.5" />}
          hint={`${newSince > 0 ? `${newSince} new since last visit` : "across all sources"}`}
          isLoading={analyticsLoading}
        />
        <KpiCard
          label="Success Rate"
          value={
            (analytics?.opportunitiesAttempted ?? 0) > 0
              ? (analytics?.successRate ?? 0)
              : "—"
          }
          format={(v) =>
            typeof v === "number" ? `${(v * 100).toFixed(0)}%` : String(v)
          }
          accent="slate"
          icon={<Target className="size-3.5" />}
          hint={
            (analytics?.opportunitiesAttempted ?? 0) > 0
              ? `${analytics?.opportunitiesAttempted} attempted`
              : "starts after first attempt"
          }
          isLoading={analyticsLoading}
        />
      </div>

      {/* Pipeline funnel */}
      <Card className="border-border/60">
        <CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">Pipeline</h3>
              <p className="text-[11px] text-muted-foreground">
                {opps?.total ?? 0} opportunities across the lifecycle — click a stage to filter
              </p>
            </div>
          </div>
          <PipelineFunnel
            byStatus={byStatus}
            total={opps?.total ?? 0}
            onSelectStatus={(s) => onNavigate("opportunities", s)}
            isLoading={analyticsLoading && !opps}
          />
        </CardContent>
      </Card>

      {/* v0.4.1: watchlist (renders only when the operator starred something) */}
      <WatchlistSection
        opportunities={watched}
        onOpen={onOpenOpportunity}
        onGoOpportunities={() => onNavigate("opportunities")}
      />

      {/* v0.4.2: deadline urgency — "Closing soon" (renders only when
          active opportunities carry deadlines) */}
      <ClosingSoonSection
        opportunities={opportunities}
        onOpen={onOpenOpportunity}
        onGoOpportunities={() => onNavigate("opportunities")}
      />

      {/* Top picks + activity feed */}
      {/* NOTE: min-w-0 on grid items is required — grid children default to
          min-width:auto which cannot shrink below the min-content of the
          truncated nowrap titles inside, blowing out the document width on
          narrow (side-panel) viewports. */}
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="min-w-0 border-border/60">
          <CardContent className="min-w-0 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">Top Picks Right Now</h3>
                <p className="text-[11px] text-muted-foreground">
                  Highest risk-adjusted hourly value
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-[11px] text-muted-foreground"
                onClick={() => onNavigate("opportunities")}
              >
                View all
                <ChevronRight className="size-3" />
              </Button>
            </div>
            <TopPicks
              opportunities={topPicks}
              isLoading={analyticsLoading && !opps}
              onOpen={onOpenOpportunity}
            />
          </CardContent>
        </Card>

        <Card className="min-w-0 border-border/60">
          <CardContent className="min-w-0 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">Recent Activity</h3>
                <p className="text-[11px] text-muted-foreground">
                  Live from the agent event log
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-[11px] text-muted-foreground"
                onClick={() => onNavigate("events")}
              >
                Full log
                <ChevronRight className="size-3" />
              </Button>
            </div>
            <ActivityFeed events={recentEvents} isLoading={analyticsLoading} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
