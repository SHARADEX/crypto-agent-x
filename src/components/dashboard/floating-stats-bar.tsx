"use client";

// FloatingStatsBar — a compact always-visible stats bar fixed to the
// bottom-right corner of the dashboard (Phase-3 DEV-REVIEW-9, priority #3).
//
// Unlike the QuickStatsWidget (which only shows in focus mode), this bar
// is always visible — so the operator doesn't need to switch to the
// Overview tab to check cycle count, budget %, pending approvals, or
// the last error.
//
// The bar is collapsible — click to expand/collapse. Collapsed state
// shows just a small pulsing status dot + the budget %. Expanded state
// shows: agent status, cycle count, budget %, pending approvals, last
// error (if any), + last cycle time.
//
// Uses TanStack Query to poll /api/agent/status every 15s + caches
// the result so it doesn't trigger redundant requests when multiple
// components need the same data.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  ChevronUp,
  ChevronDown,
  Layers,
  Zap,
} from "lucide-react";
import { api } from "./lib/api";
import { cn } from "@/lib/utils";

const COLLAPSED_KEY = "cryptoearn-floating-stats-collapsed";

export function FloatingStatsBar() {
  const [collapsed, setCollapsed] = React.useState(false);

  // Load collapsed state from localStorage on mount.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const v = localStorage.getItem(COLLAPSED_KEY);
      if (v === "true") setCollapsed(true);
    } catch {
      // ignore
    }
  }, []);

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(COLLAPSED_KEY, String(next));
        } catch {
          // ignore
        }
      }
      return next;
    });
  }, []);

  const { data: status } = useQuery({
    queryKey: ["agent", "status"],
    queryFn: () => api.agent.status(),
    refetchInterval: 15_000,
  });

  const { data: pendingApprovals } = useQuery({
    queryKey: ["approvals", "pending", "count"],
    queryFn: () => api.approvals.list({ status: "pending", limit: 1 }),
    refetchInterval: 15_000,
  });

  if (!status) return null;

  const isRunning = status.running && !status.paused && !status.emergencyStop;
  const budgetPct =
    status.budget?.limits?.dailyLlmTokens && status.budget.limits.dailyLlmTokens > 0
      ? Math.round(
          ((status.budget?.day?.llmTokens ?? 0) /
            status.budget.limits.dailyLlmTokens) *
            100
        )
      : 0;
  const pendingCount =
    pendingApprovals?.count ?? pendingApprovals?.approvals?.length ?? 0;

  const budgetColor =
    budgetPct >= 90
      ? "text-red-500"
      : budgetPct >= 70
        ? "text-amber-500"
        : "text-emerald-500";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed bottom-4 right-4 z-30"
    >
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border bg-background/95 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80 transition-all",
          collapsed ? "px-2 py-1" : "px-3 py-2"
        )}
      >
        {/* Status dot */}
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "size-2 rounded-full",
              isRunning
                ? "bg-emerald-500 animate-pulse"
                : status.emergencyStop
                  ? "bg-red-500"
                  : "bg-amber-500"
            )}
            title={
              isRunning
                ? "Running"
                : status.emergencyStop
                  ? "Emergency stop"
                  : "Paused"
            }
          />
          {!collapsed && (
            <span className="text-[10px] font-medium text-muted-foreground">
              {status.emergencyStop
                ? "STOPPED"
                : status.paused
                  ? "PAUSED"
                  : "RUNNING"}
            </span>
          )}
        </div>

        <AnimatePresence>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "auto" }}
              exit={{ opacity: 0, width: 0 }}
              transition={{ duration: 0.15 }}
              className="flex items-center gap-3 overflow-hidden"
            >
              {/* Cycle count */}
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Activity className="size-3" />
                <span className="tabular-nums">{status.cycleCount ?? 0}</span>
                <span className="hidden sm:inline">cycles</span>
              </div>

              {/* Budget */}
              <div className="flex items-center gap-1 text-[10px]">
                <Zap className={cn("size-3", budgetColor)} />
                <span className={cn("tabular-nums font-medium", budgetColor)}>
                  {budgetPct}%
                </span>
                <span className="hidden sm:inline text-muted-foreground">budget</span>
              </div>

              {/* Pending approvals */}
              {pendingCount > 0 ? (
                <div className="flex items-center gap-1 text-[10px]">
                  <Layers className="size-3 text-amber-500" />
                  <span className="tabular-nums font-medium text-amber-600 dark:text-amber-400">
                    {pendingCount}
                  </span>
                  <span className="hidden sm:inline text-muted-foreground">
                    pending
                  </span>
                </div>
              ) : null}

              {/* Last cycle time */}
              {status.lastCycleAt ? (
                <div className="hidden items-center gap-1 text-[10px] text-muted-foreground lg:flex">
                  <Clock className="size-3" />
                  <span>
                    {new Date(status.lastCycleAt).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
              ) : null}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Expand/collapse toggle */}
        <button
          type="button"
          onClick={toggleCollapsed}
          className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted"
          aria-label={collapsed ? "Expand stats bar" : "Collapse stats bar"}
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? (
            <ChevronUp className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )}
        </button>
      </div>
    </motion.div>
  );
}
