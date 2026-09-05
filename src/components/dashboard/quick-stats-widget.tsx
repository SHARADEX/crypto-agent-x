"use client";

// QuickStatsWidget — a compact KPI bar shown only when focus mode is active.
//
// Phase-2 CRON-REVIEW-9: when focus mode hides the header, the operator loses
// visibility into the agent's status + budget. This widget floats at the
// top of the screen in focus mode, showing the essential metrics:
//   - Agent status (RUNNING/PAUSED/STOPPED) with pulsing dot
//   - Cycle count
//   - Budget usage %
//   - Verified earnings
//   - Opportunities count
//
// The widget is collapsible — click the chevron to minimize it to just the
// status dot. Uses Framer Motion for smooth expand/collapse.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ChevronUp,
  ChevronDown,
  DollarSign,
  Target,
  Zap,
} from "lucide-react";
import { api } from "./lib/api";
import { cn } from "@/lib/utils";

const COLLAPSED_KEY = "cryptoearn-quick-stats-collapsed";

export function QuickStatsWidget() {
  const { data: status } = useQuery({
    queryKey: ["agent-status"],
    queryFn: () => api.agent.status(),
    refetchInterval: 5_000,
  });

  const { data: analytics } = useQuery({
    queryKey: ["analytics"],
    queryFn: () => api.analytics.get(),
    refetchInterval: 15_000,
  });

  const [collapsed, setCollapsed] = React.useState(false);

  // Restore collapsed state from localStorage.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = localStorage.getItem(COLLAPSED_KEY);
      if (stored === "true") setCollapsed(true);
    } catch {
      // ignore
    }
  }, []);

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const isPaused = !!status?.paused;
  const isStopped = !!status?.emergencyStop;
  const cycleCount = status?.cycleCount ?? 0;
  const dailyTokens = status?.budget?.day?.llmTokens ?? 0;
  const dailyTokenLimit = status?.budget?.limits?.dailyLlmTokens ?? 1;
  const budgetPct = Math.min(100, (dailyTokens / dailyTokenLimit) * 100);
  const verifiedUsd = analytics?.totalVerifiedEarningsUsd ?? 0;
  const oppCount = analytics?.opportunitiesDiscovered ?? 0;

  const statusLabel = isStopped ? "STOPPED" : isPaused ? "PAUSED" : "RUNNING";
  const statusColor = isStopped
    ? "bg-red-500"
    : isPaused
    ? "bg-amber-500"
    : "bg-emerald-500";
  const statusText = isStopped
    ? "text-red-600 dark:text-red-400"
    : isPaused
    ? "text-amber-600 dark:text-amber-400"
    : "text-emerald-600 dark:text-emerald-400";

  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.25 }}
      className="fixed left-1/2 top-3 z-40 -translate-x-1/2"
    >
      <div className="flex items-center gap-3 rounded-full border border-border/60 bg-background/95 px-4 py-2 shadow-lg backdrop-blur">
        {/* Status dot + label — always visible */}
        <div className="flex items-center gap-2">
          <span className="relative flex size-2">
            {!isStopped && !isPaused && (
              <span className={cn("pulse-dot size-2 rounded-full", statusColor)} />
            )}
            <span className={cn("size-2 rounded-full", statusColor)} />
          </span>
          <span className={cn("text-xs font-semibold", statusText)}>
            {statusLabel}
          </span>
        </div>

        {/* Expanded stats — hidden when collapsed */}
        <AnimatePresence>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "auto" }}
              exit={{ opacity: 0, width: 0 }}
              transition={{ duration: 0.2 }}
              className="flex items-center gap-4 overflow-hidden"
            >
              <div className="h-4 w-px bg-border/60" />

              {/* Cycle count */}
              <div className="flex items-center gap-1.5">
                <Activity className="size-3 text-muted-foreground" />
                <span className="font-mono text-xs tabular-nums">
                  {cycleCount}
                </span>
                <span className="text-[10px] text-muted-foreground">cycles</span>
              </div>

              {/* Budget */}
              <div className="flex items-center gap-1.5">
                <Zap className="size-3 text-muted-foreground" />
                <span
                  className={cn(
                    "font-mono text-xs tabular-nums",
                    budgetPct > 90
                      ? "text-red-600 dark:text-red-400"
                      : budgetPct > 70
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-emerald-600 dark:text-emerald-400"
                  )}
                >
                  {budgetPct.toFixed(0)}%
                </span>
              </div>

              <div className="h-4 w-px bg-border/60" />

              {/* Verified earnings */}
              <div className="flex items-center gap-1.5">
                <DollarSign className="size-3 text-muted-foreground" />
                <span className="font-mono text-xs tabular-nums text-emerald-600 dark:text-emerald-400">
                  ${verifiedUsd.toFixed(2)}
                </span>
              </div>

              {/* Opportunities */}
              <div className="flex items-center gap-1.5">
                <Target className="size-3 text-muted-foreground" />
                <span className="font-mono text-xs tabular-nums">
                  {oppCount}
                </span>
                <span className="text-[10px] text-muted-foreground">opps</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Collapse/expand button */}
        <button
          onClick={toggleCollapsed}
          className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={collapsed ? "Expand quick stats" : "Collapse quick stats"}
        >
          {collapsed ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronUp className="size-3" />
          )}
        </button>
      </div>
    </motion.div>
  );
}
