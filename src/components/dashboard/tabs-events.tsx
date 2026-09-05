"use client";

// EventsTab v2 — color-coded audit log of every agent event.
//
// Redesign (from VLM 6/10 "wall of text"):
//   1. Level quick-chips (severity filtering in one tap)
//   2. Day separators — events grouped under Today / Yesterday / date rows
//   3. Severity drives the color (left accent border + level dot);
//      agent becomes quiet mono text instead of arbitrary-colored pills
//   4. Level metadata + collapsible payload kept from v1
//
// Phase-2 P3-3: a "Live" toggle switches from polling (every 10s) to a
// persistent SSE connection (real-time push). The SSE endpoint at
// /api/events/sse streams new events as they're logged.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollText, ChevronDown, Radio, Pause, Play, Download } from "lucide-react";
import {
  api,
  formatRelativeTime,
} from "./lib/api";
import { cn } from "@/lib/utils";
import type { AgentEventLog, AgentName, EventLevel } from "@/lib/agent/types";
import { useEventSource } from "./use-event-source";

const LEVEL_OPTIONS: (EventLevel | "all")[] = [
  "all",
  "debug",
  "info",
  "warn",
  "error",
  "critical",
];

const AGENT_OPTIONS: (AgentName | "all")[] = [
  "all",
  "orchestrator",
  "task_classifier",
  "model_router",
  "scout",
  "research",
  "verification",
  "economics",
  "coding",
  "web3",
  "writing",
  "security",
  "execution",
  "payment",
  "review",
];

// Severity → visual accent for the row (dot + left border).
const SEVERITY: Record<
  EventLevel,
  { dot: string; border: string; label: string }
> = {
  debug: { dot: "bg-slate-500", border: "border-l-slate-500/50", label: "text-slate-500" },
  info: { dot: "bg-emerald-500", border: "border-l-emerald-500/60", label: "text-emerald-600 dark:text-emerald-400" },
  warn: { dot: "bg-amber-500", border: "border-l-amber-500/70", label: "text-amber-600 dark:text-amber-400" },
  error: { dot: "bg-red-500", border: "border-l-red-500/80", label: "text-red-600 dark:text-red-400" },
  critical: { dot: "bg-red-600", border: "border-l-red-600", label: "text-red-700 dark:text-red-400" },
};

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 3600 * 1000;
  const t = d.getTime();
  if (t >= startOfToday) return "Today";
  if (t >= startOfYesterday) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function EventsTab() {
  const [level, setLevel] = React.useState<EventLevel | "all">("all");
  const [agent, setAgent] = React.useState<AgentName | "all">("all");
  const [limit, setLimit] = React.useState<number>(200);
  const [live, setLive] = React.useState(false);

  // Polling query (used when live mode is OFF).
  const { data, isLoading, error } = useQuery({
    queryKey: ["events", { level, agent, limit }],
    queryFn: () =>
      api.events.list({
        limit,
        level: level === "all" ? undefined : level,
        agent: agent === "all" ? undefined : agent,
      }),
    refetchInterval: live ? false : 10_000,
  });

  // SSE live stream (used when live mode is ON).
  const sseUrl = React.useMemo(() => {
    if (!live) return null;
    const params = new URLSearchParams();
    if (level !== "all") params.set("level", level);
    if (agent !== "all") params.set("agent", agent);
    return `/api/events/sse?${params.toString()}`;
  }, [live, level, agent]);

  const { events: sseEvents, status: sseStatus } = useEventSource(sseUrl, {
    enabled: live,
    maxEvents: limit,
  });

  // Merge polled events or use SSE events depending on mode.
  const polledEvents = (data?.events ?? []) as AgentEventLog[];
  const liveEvents: AgentEventLog[] = React.useMemo(
    () =>
      sseEvents.map((sse) => ({
        id: sse.id,
        taskId: (sse.data.taskId as string) ?? null,
        opportunityId: (sse.data.opportunityId as string) ?? null,
        agent: (sse.data.agent as AgentName) ?? "orchestrator",
        level: (sse.data.level as EventLevel) ?? "info",
        event: (sse.data.event as string) ?? "unknown",
        payload: (sse.data.payload as Record<string, unknown>) ?? {},
        createdAt: (sse.data.createdAt as string) ?? new Date().toISOString(),
      })),
    [sseEvents]
  );

  if (error && !live) {
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
        Failed to load events: {String(error)}
      </div>
    );
  }

  const events = live ? [...liveEvents].reverse() : polledEvents;

  return (
    <div className="space-y-4">
      {/* Header + actions */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold tracking-tight">
            <ScrollText className="size-4 text-emerald-500" />
            Event Log
            {live && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                <Radio className="size-2.5 animate-pulse" />
                LIVE
              </span>
            )}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {events.length} events{live ? ` streaming via SSE (${sseStatus})` : " · most recent first"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={live ? "default" : "outline"}
            onClick={() => setLive(!live)}
            className={cn(
              "focus-ring gap-1.5",
              live && "bg-emerald-600 text-white hover:bg-emerald-600/90"
            )}
            aria-label={live ? "Pause live stream" : "Start live stream"}
          >
            {live ? (
              <>
                <Pause className="size-3" />
                <span className="hidden sm:inline">Pause Live</span>
              </>
            ) : (
              <>
                <Play className="size-3" />
                <span className="hidden sm:inline">Go Live</span>
              </>
            )}
          </Button>

          <Select
            value={agent}
            onValueChange={(v) => setAgent(v as AgentName | "all")}
          >
            <SelectTrigger size="sm" className="w-[130px]" aria-label="Filter by agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AGENT_OPTIONS.map((a) => (
                <SelectItem key={a} value={a}>
                  {a === "all" ? "All agents" : a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={String(limit)}
            onValueChange={(v) => setLimit(Number(v))}
          >
            <SelectTrigger size="sm" className="w-[100px]" aria-label="Limit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[50, 100, 200, 500].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  Last {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Phase-3 DEV-REVIEW-4 (priority #4): operator data export. */}
          <Button
            size="sm"
            variant="ghost"
            className="gap-1 text-muted-foreground"
            title="Export the current filtered event log as CSV (download)"
            onClick={() => {
              const params = new URLSearchParams({ format: "csv" });
              if (level !== "all") params.set("level", level);
              if (agent !== "all") params.set("agent", agent);
              window.open(`/api/export/events?${params.toString()}`, "_blank");
            }}
          >
            <Download className="size-3.5" />
            <span className="hidden sm:inline">CSV</span>
          </Button>
        </div>
      </div>

      {/* Severity quick chips */}
      <div className="flex items-center gap-1.5" role="tablist" aria-label="Quick severity filter">
        {(["all", "info", "warn", "error", "critical", "debug"] as const).map((l) => (
          <button
            key={l}
            type="button"
            role="tab"
            aria-selected={level === l}
            onClick={() => setLevel(l)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
              level === l
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : "border-border/60 bg-card text-muted-foreground hover:border-border hover:text-foreground"
            )}
          >
            {l !== "all" && (
              <span className={cn("size-1.5 rounded-full", SEVERITY[l].dot)} />
            )}
            {l === "error" ? "errors" : l}
          </button>
        ))}
      </div>

      {/* Event list with day separators */}
      <Card className="border-border/60">
        <CardContent className="p-3">
          <div className="scrollbar-thin max-h-[700px] space-y-1.5 overflow-y-auto pr-1">
            {isLoading && !live ? (
              Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full rounded-lg" />
              ))
            ) : events.length === 0 ? (
              <div className="empty-state">
                <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                  <ScrollText className="size-5 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium">No events match the current filters</p>
                <p className="max-w-md text-xs text-muted-foreground">
                  {live
                    ? "Waiting for new events… the stream is open and entries will appear here as the agent works."
                    : "Try changing the severity or agent filter, or click Go Live to stream events in real time."}
                </p>
              </div>
            ) : (
              (() => {
                const rows: React.ReactNode[] = [];
                let lastDay = "";
                for (const e of events) {
                  const day = dayLabel(e.createdAt);
                  if (day !== lastDay) {
                    lastDay = day;
                    rows.push(<DaySeparator key={`day-${day}-${e.id}`} label={day} />);
                  }
                  rows.push(<EventRow key={e.id} event={e} />);
                }
                return rows;
              })()
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DaySeparator({ label }: { label: string }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 bg-background/95 px-1 py-1.5 backdrop-blur-sm">
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}

function EventRow({ event }: { event: AgentEventLog }) {
  const [open, setOpen] = React.useState(false);
  const sev = SEVERITY[event.level] ?? SEVERITY.info;
  const payloadKeys = Object.keys(event.payload ?? {});
  const hasPayload = payloadKeys.length > 0;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "row-hover rounded-lg border border-border/50 border-l-2 bg-card/60",
        sev.border
      )}
    >
      <div className="flex items-start gap-2.5 p-2.5">
        <span className={cn("mt-1 size-2 shrink-0 rounded-full", sev.dot)} aria-label={event.level} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate font-mono text-xs font-semibold">
              {event.event}
            </span>
            <span className={cn("shrink-0 text-[9px] font-bold uppercase tracking-wider", sev.label)}>
              {event.level}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
            <span className="font-mono">{event.agent}</span>
            <span className="tabular-nums">{formatRelativeTime(event.createdAt)}</span>
            {event.taskId ? (
              <span className="font-mono opacity-70">task {event.taskId.slice(0, 8)}</span>
            ) : null}
            {event.opportunityId ? (
              <span className="font-mono opacity-70">opp {event.opportunityId.slice(0, 8)}</span>
            ) : null}
            {hasPayload && (
              <span className="opacity-70">{payloadKeys.length} fields</span>
            )}
          </div>
        </div>
        {hasPayload ? (
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-label="Toggle payload"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <ChevronDown
                className={cn(
                  "size-3 transition-transform",
                  open && "rotate-180"
                )}
              />
            </button>
          </CollapsibleTrigger>
        ) : null}
      </div>
      {hasPayload ? (
        <CollapsibleContent>
          <pre className="scrollbar-thin max-h-64 overflow-auto border-t border-border/50 bg-muted/30 p-2 text-[10px] leading-tight">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
