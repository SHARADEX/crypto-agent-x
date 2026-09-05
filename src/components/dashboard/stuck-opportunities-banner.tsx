"use client";

// StuckOpportunitiesBanner — a dismissible alert that surfaces opportunities
// stuck in a non-terminal status for > 24 hours (Phase-3 dev-review).
//
// Uses the GET /api/analytics/lifecycle endpoint (added in the same phase)
// to detect stuck statuses. When stuck opportunities exist, a dismissible
// amber banner appears at the top of the dashboard with:
//   - The count of stuck statuses + the worst offender (longest stuck).
//   - A "View on Lifecycle tab" CTA that switches to the Lifecycle tab.
//   - A dismiss button (per-status, persisted in localStorage for 1 hour).
//
// This is a real operational improvement: before this banner, the operator
// had to manually scroll the Opportunities table or the Events feed to notice
// a stalled pipeline. Now they get a proactive amber alert.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, ArrowRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "./lib/api";
import { cn } from "@/lib/utils";

const DISMISS_KEY_PREFIX = "cryptoearn-stuck-dismissed-";
const DISMISS_TTL_MS = 60 * 60 * 1000; // 1 hour

const TERMINAL_STATUSES = new Set(["paid", "failed", "rejected"]);

interface StuckStatus {
  status: string;
  count: number;
  oldestUpdatedAt: string | null;
  hoursStuck: number;
}

function isStuck(entry: { status: string; oldestUpdatedAt: string | null }): {
  stuck: boolean;
  hoursStuck: number;
} {
  if (TERMINAL_STATUSES.has(entry.status)) return { stuck: false, hoursStuck: 0 };
  if (!entry.oldestUpdatedAt) return { stuck: false, hoursStuck: 0 };
  const then = new Date(entry.oldestUpdatedAt).getTime();
  if (!Number.isFinite(then)) return { stuck: false, hoursStuck: 0 };
  const hoursStuck = (Date.now() - then) / (1000 * 60 * 60);
  return { stuck: hoursStuck > 24, hoursStuck };
}

function isDismissed(status: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem(DISMISS_KEY_PREFIX + status);
    if (!raw) return false;
    const dismissedAt = Number(raw);
    if (!Number.isFinite(dismissedAt)) return false;
    return Date.now() - dismissedAt < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

function dismissStatus(status: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(DISMISS_KEY_PREFIX + status, String(Date.now()));
  } catch {
    // ignore
  }
}

export function StuckOpportunitiesBanner({
  onViewLifecycle,
}: {
  onViewLifecycle?: () => void;
}) {
  const { data } = useQuery({
    queryKey: ["analytics", "lifecycle"],
    queryFn: () => api.analytics.lifecycle(),
    refetchInterval: 60_000, // refresh every minute
  });

  const [dismissedStatuses, setDismissedStatuses] = React.useState<Set<string>>(
    new Set()
  );

  // Load dismissed statuses from localStorage on mount + every refresh.
  React.useEffect(() => {
    if (!data?.statuses) return;
    const dismissed = new Set<string>();
    for (const entry of data.statuses) {
      if (isDismissed(entry.status)) dismissed.add(entry.status);
    }
    setDismissedStatuses(dismissed);
  }, [data]);

  const stuckStatuses: StuckStatus[] = React.useMemo(() => {
    if (!data?.statuses) return [];
    const stuck: StuckStatus[] = [];
    for (const entry of data.statuses) {
      if (dismissedStatuses.has(entry.status)) continue;
      const { stuck: isStuckFlag, hoursStuck } = isStuck(entry);
      if (isStuckFlag) {
        stuck.push({
          status: entry.status,
          count: entry.count,
          oldestUpdatedAt: entry.oldestUpdatedAt,
          hoursStuck,
        });
      }
    }
    // Sort by hours stuck descending — worst offender first.
    stuck.sort((a, b) => b.hoursStuck - a.hoursStuck);
    return stuck;
  }, [data, dismissedStatuses]);

  const handleDismiss = React.useCallback((status: string) => {
    dismissStatus(status);
    setDismissedStatuses((prev) => new Set(prev).add(status));
  }, []);

  return (
    <AnimatePresence>
      {stuckStatuses.length > 0 ? (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="border-b border-amber-500/20 bg-amber-500/5"
          role="alert"
          aria-live="polite"
        >
          <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-2 px-4 py-2 text-xs sm:text-sm">
            <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="font-medium text-amber-900 dark:text-amber-100">
              {stuckStatuses.length} status{stuckStatuses.length === 1 ? "" : "es"} stuck for &gt; 24h
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {stuckStatuses.slice(0, 3).map((s) => (
                <Badge
                  key={s.status}
                  variant="outline"
                  className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-800 dark:text-amber-200"
                >
                  <span className="font-mono">{s.status}</span>
                  <span className="opacity-70">·</span>
                  <span>{s.count} for {Math.round(s.hoursStuck)}h</span>
                  <button
                    type="button"
                    aria-label={`Dismiss ${s.status} alert`}
                    onClick={() => handleDismiss(s.status)}
                    className="ml-0.5 rounded-sm p-0.5 hover:bg-amber-500/20"
                  >
                    <X className="size-2.5" />
                  </button>
                </Badge>
              ))}
              {stuckStatuses.length > 3 ? (
                <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-800 dark:text-amber-200">
                  +{stuckStatuses.length - 3} more
                </Badge>
              ) : null}
            </div>
            <div className="ml-auto flex items-center gap-1">
              {onViewLifecycle ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-[11px] text-amber-800 hover:bg-amber-500/15 dark:text-amber-200"
                  onClick={onViewLifecycle}
                >
                  View lifecycle
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
