"use client";

// NotificationHistory — a floating panel that shows past terminal-state
// notifications (opportunity paid / failed / rejected).
//
// Phase-2 CRON-REVIEW-9: the operator can see a history of what happened
// while they were away — even if they missed the browser notification.
// The panel is toggled via a bell icon in the header area (or a floating
// button when in focus mode). It subscribes to the events SSE stream +
// keeps the last 50 terminal-state events.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, X, CheckCircle2, XCircle, Ban, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useEventSource } from "./use-event-source";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "./lib/api";

const SSE_URL = "/api/events/sse?level=info";
const MAX_HISTORY = 50;
const STORAGE_KEY = "cryptoearn-notification-history";

export interface NotificationHistoryEntry {
  id: string;
  opportunityId: string;
  finalStatus: "paid" | "failed" | "rejected";
  title?: string;
  timestamp: string;
}

export function NotificationHistory({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  // Load persisted history from localStorage.
  const [history, setHistory] = React.useState<NotificationHistoryEntry[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as NotificationHistoryEntry[];
        if (Array.isArray(parsed)) return parsed.slice(0, MAX_HISTORY);
      }
    } catch {
      // ignore
    }
    return [];
  });

  // Subscribe to the events SSE stream for terminal states.
  const { events } = useEventSource(SSE_URL, {
    enabled: true,
    maxEvents: 100,
  });

  // Watch for terminal-state events + add to history.
  React.useEffect(() => {
    for (const sseEvent of events) {
      const data = sseEvent.data;
      const eventName = data.event as string;
      const opportunityId = data.opportunityId as string | undefined;

      if (eventName !== "process_opportunity_completed" || !opportunityId) continue;

      const finalStatus = data.finalStatus as string | undefined;
      if (finalStatus !== "paid" && finalStatus !== "failed" && finalStatus !== "rejected") continue;

      // Check if already in history (dedupe).
      setHistory((prev) => {
        if (prev.some((h) => h.opportunityId === opportunityId)) return prev;

        const entry: NotificationHistoryEntry = {
          id: sseEvent.id,
          opportunityId,
          finalStatus: finalStatus as "paid" | "failed" | "rejected",
          title: data.title as string | undefined,
          timestamp: (data.createdAt as string) ?? new Date().toISOString(),
        };

        const next = [entry, ...prev].slice(0, MAX_HISTORY);

        // Persist to localStorage.
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // ignore
        }

        return next;
      });
    }
  }, [events]);

  const clearHistory = React.useCallback(() => {
    setHistory([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const paidCount = history.filter((h) => h.finalStatus === "paid").length;
  const failedCount = history.filter((h) => h.finalStatus === "failed").length;
  const rejectedCount = history.filter((h) => h.finalStatus === "rejected").length;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 20 }}
          transition={{ duration: 0.2 }}
          className="fixed right-4 top-16 z-50 w-80 rounded-xl border border-border/60 bg-card shadow-2xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
            <div className="flex items-center gap-2">
              <Bell className="size-4 text-emerald-500" />
              <span className="text-sm font-semibold">Notification History</span>
            </div>
            <div className="flex items-center gap-1">
              {history.length > 0 && (
                <button
                  onClick={clearHistory}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="Clear history"
                  title="Clear all"
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
              <button
                onClick={onClose}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Close panel"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          {/* Summary badges */}
          {history.length > 0 && (
            <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
              <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20 text-[10px]">
                <CheckCircle2 className="mr-1 size-2.5" />
                {paidCount} paid
              </Badge>
              <Badge variant="outline" className="bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/20 text-[10px]">
                <XCircle className="mr-1 size-2.5" />
                {failedCount} failed
              </Badge>
              <Badge variant="outline" className="bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20 text-[10px]">
                <Ban className="mr-1 size-2.5" />
                {rejectedCount} rejected
              </Badge>
            </div>
          )}

          {/* History list */}
          <div className="max-h-96 overflow-y-auto scrollbar-thin">
            {history.length === 0 ? (
              <div className="empty-state py-8">
                <Bell className="size-5 text-muted-foreground" />
                <p className="text-xs font-medium">No notifications yet</p>
                <p className="text-[10px] text-muted-foreground">
                  Terminal-state events (paid, failed, rejected) will appear here
                </p>
              </div>
            ) : (
              <div className="space-y-1 p-2">
                {history.map((entry) => (
                  <div
                    key={entry.id}
                    className="row-hover flex items-start gap-2 rounded-md border border-border/40 p-2"
                  >
                    <span className="mt-0.5 flex-shrink-0">
                      {entry.finalStatus === "paid" ? (
                        <CheckCircle2 className="size-4 text-emerald-500" />
                      ) : entry.finalStatus === "failed" ? (
                        <XCircle className="size-4 text-red-500" />
                      ) : (
                        <Ban className="size-4 text-amber-500" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-xs font-medium">
                        {entry.title
                          ? entry.title.slice(0, 80)
                          : `Opportunity ${entry.opportunityId.slice(-8)}`}
                      </p>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span
                          className={cn(
                            "font-semibold uppercase",
                            entry.finalStatus === "paid"
                              ? "text-emerald-600 dark:text-emerald-400"
                              : entry.finalStatus === "failed"
                              ? "text-red-600 dark:text-red-400"
                              : "text-amber-600 dark:text-amber-400"
                          )}
                        >
                          {entry.finalStatus}
                        </span>
                        <span>·</span>
                        <span>{formatRelativeTime(entry.timestamp)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
