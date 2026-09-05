"use client";

// PendingApprovalBanner — a dismissible alert that surfaces pending Approval
// rows that have been waiting for operator action for more than X hours
// (Phase-3 dev-review, priority #4).
//
// Distinct from StuckOpportunitiesBanner (which covers non-terminal
// opportunity statuses). This banner specifically covers the human-in-the-loop
// bottleneck: when a level-2/3 action needs approval and the operator hasn't
// decided yet, the agent is blocked. A high-value bounty stuck in "pending
// approval" for 6+ hours is a revenue opportunity slipping away.
//
// Uses the existing GET /api/approvals?status=pending endpoint. Filters
// approvals older than STALE_THRESHOLD_HOURS (default 6h). Renders as a
// dismissible rose-colored banner (distinct from the amber stuck banner so
// the operator can tell at a glance "this is an approval I need to act on"
// vs "this is a pipeline stall I should investigate").
//
// Dismissal is per-approval-id, persisted to localStorage for 1 hour (so the
// banner resurfaces if the approval is still pending after the dismissal
// expires — forces the operator to either act or re-dismiss).

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldAlert, ArrowRight, X, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api, type ApprovalRow } from "./lib/api";

const DISMISS_KEY_PREFIX = "cryptoearn-pending-approval-dismissed-";
const DISMISS_TTL_MS = 60 * 60 * 1000; // 1 hour

// Phase-3 dev-review #2 (priority #2): the staleness threshold is now
// configurable via the PENDING_APPROVAL_STALE_HOURS env var. The dashboard
// can't read process.env directly (it's client-side), so we expose the
// configured value via a Next.js `publicRuntimeConfig`-style approach:
// the value is injected at build time into `NEXT_PUBLIC_*`. We default to
// 6h when the env var is unset. Operators can set
// `PENDING_APPROVAL_STALE_HOURS=2` (tighter SLA) or `=24` (looser).
//
// The threshold is also overridable at runtime per-session via localStorage
// key `cryptoearn-pending-approval-threshold-hours` — useful for testing
// without a redeploy.
function readStaleThresholdHours(): number {
  // Build-time env var (highest precedence).
  // Next.js inlines NEXT_PUBLIC_* at build time.
  const envVal =
    typeof process !== "undefined"
      ? (process as NodeJS.Process & { env: Record<string, string | undefined> }).env
          ?.NEXT_PUBLIC_PENDING_APPROVAL_STALE_HOURS
      : undefined;
  if (envVal) {
    const n = Number(envVal);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Runtime localStorage override (testing / debugging).
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(
        "cryptoearn-pending-approval-threshold-hours"
      );
      if (stored) {
        const n = Number(stored);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch {
      // ignore
    }
  }
  // Default: 6h.
  return 6;
}

const STALE_THRESHOLD_HOURS = readStaleThresholdHours();

interface StaleApproval {
  id: string;
  riskLevel: string;
  executionLevel: number;
  reason: string;
  createdAt: string;
  hoursWaiting: number;
  opportunityTitle: string | null;
  opportunityId: string | null;
}

function hoursSince(iso: string): number {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 0;
  return (Date.now() - then) / (1000 * 60 * 60);
}

function isDismissed(approvalId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem(DISMISS_KEY_PREFIX + approvalId);
    if (!raw) return false;
    const dismissedAt = Number(raw);
    if (!Number.isFinite(dismissedAt)) return false;
    return Date.now() - dismissedAt < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

function dismissApproval(approvalId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(DISMISS_KEY_PREFIX + approvalId, String(Date.now()));
  } catch {
    // ignore
  }
}

function riskBadgeClass(riskLevel: string): string {
  switch (riskLevel) {
    case "financial":
      return "border-rose-500/40 bg-rose-500/15 text-rose-800 dark:text-rose-200";
    case "high":
      return "border-orange-500/40 bg-orange-500/15 text-orange-800 dark:text-orange-200";
    case "moderate":
    default:
      return "border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-200";
  }
}

export function PendingApprovalBanner({
  onViewApprovals,
}: {
  onViewApprovals?: () => void;
}) {
  const { data } = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => api.approvals.list({ status: "pending", limit: 50 }),
    refetchInterval: 60_000, // refresh every minute
  });

  const [dismissedIds, setDismissedIds] = React.useState<Set<string>>(new Set());

  // Load dismissed IDs from localStorage on mount + every refresh.
  React.useEffect(() => {
    const approvals = data?.approvals ?? [];
    if (approvals.length === 0) return;
    const dismissed = new Set<string>();
    for (const a of approvals) {
      if (isDismissed(a.id)) dismissed.add(a.id);
    }
    setDismissedIds(dismissed);
  }, [data]);

  const staleApprovals: StaleApproval[] = React.useMemo(() => {
    const approvals = data?.approvals ?? [];
    const stale: StaleApproval[] = [];
    for (const a of approvals) {
      if (dismissedIds.has(a.id)) continue;
      const hours = hoursSince(a.createdAt);
      if (hours >= STALE_THRESHOLD_HOURS) {
        stale.push({
          id: a.id,
          riskLevel: a.riskLevel,
          executionLevel: a.executionLevel,
          reason: a.reason,
          createdAt: a.createdAt,
          hoursWaiting: hours,
          opportunityTitle: a.opportunity?.title ?? null,
          opportunityId: a.opportunityId ?? null,
        });
      }
    }
    // Sort by hours waiting descending — oldest first.
    stale.sort((a, b) => b.hoursWaiting - a.hoursWaiting);
    return stale;
  }, [data, dismissedIds]);

  const handleDismiss = React.useCallback((approvalId: string) => {
    dismissApproval(approvalId);
    setDismissedIds((prev) => new Set(prev).add(approvalId));
  }, []);

  return (
    <AnimatePresence>
      {staleApprovals.length > 0 ? (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="border-b border-rose-500/20 bg-rose-500/5"
          role="alert"
          aria-live="assertive"
        >
          <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-2 px-4 py-2 text-xs sm:text-sm">
            <ShieldAlert className="size-4 shrink-0 text-rose-600 dark:text-rose-400" />
            <span className="font-medium text-rose-900 dark:text-rose-100">
              {staleApprovals.length} approval{staleApprovals.length === 1 ? "" : "s"} pending for &gt; {STALE_THRESHOLD_HOURS}h
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {staleApprovals.slice(0, 2).map((a) => (
                <Badge
                  key={a.id}
                  variant="outline"
                  className="gap-1 border-rose-500/40 bg-rose-500/10 text-[10px] text-rose-800 dark:text-rose-200"
                >
                  <span className={riskBadgeClass(a.riskLevel) + " -ml-1 pl-1 pr-1 rounded-sm"}>
                    L{a.executionLevel}
                  </span>
                  <span className="max-w-[180px] truncate">
                    {a.opportunityTitle ?? a.reason.slice(0, 40)}
                  </span>
                  <span className="opacity-70">·</span>
                  <span className="flex items-center gap-0.5">
                    <Clock className="size-2.5" />
                    {Math.round(a.hoursWaiting)}h
                  </span>
                  <button
                    type="button"
                    aria-label={`Dismiss approval ${a.id} alert`}
                    onClick={() => handleDismiss(a.id)}
                    className="ml-0.5 rounded-sm p-0.5 hover:bg-rose-500/20"
                  >
                    <X className="size-2.5" />
                  </button>
                </Badge>
              ))}
              {staleApprovals.length > 2 ? (
                <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 text-[10px] text-rose-800 dark:text-rose-200">
                  +{staleApprovals.length - 2} more
                </Badge>
              ) : null}
            </div>
            <div className="ml-auto flex items-center gap-1">
              {onViewApprovals ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-[11px] text-rose-800 hover:bg-rose-500/15 dark:text-rose-200"
                  onClick={onViewApprovals}
                >
                  Review approvals
                  <ArrowRight className="size-3" />
                </Button>
              ) : null}
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
