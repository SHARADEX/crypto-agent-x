"use client";

// TasksTab v2 — recent task handoffs as responsive card rows (v0.4.4,
// replaces the raw 9-column table). Clicking a row opens a dialog with the
// input/output JSON pretty-printed in a <pre>.
//
// Row anatomy (matches Opportunities cards / Event Log entries):
//   [objective title .......] [status pill + metrics + time]
//   [from→to agent pills · model · risk]
//
// Phase-2 P3-3: a "Live" toggle switches from polling (every 15s) to a
// persistent SSE connection (real-time push via /api/tasks/sse).

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Gauge,
  ListChecks,
  Pause,
  Play,
  Radio,
  XCircle,
} from "lucide-react";
import {
  api,
  agentColor,
  formatRelativeTime,
  statusColor,
  truncateText,
} from "./lib/api";
import { cn } from "@/lib/utils";
import type { TaskStatus, AgentName } from "@/lib/agent/types";
import { useEventSource } from "./use-event-source";
import { TaskIterationHistory } from "./task-iteration-history";

const STATUS_OPTIONS: (TaskStatus | "all")[] = [
  "all",
  "pending",
  "running",
  "success",
  "failed",
  "skipped",
  "cancelled",
];

export function TasksTab() {
  const [status, setStatus] = React.useState<TaskStatus | "all">("all");
  const [limit, setLimit] = React.useState<number>(100);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [live, setLive] = React.useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["tasks", { status, limit }],
    queryFn: () =>
      api.tasks.list({
        status: status === "all" ? undefined : status,
        limit,
      }),
    refetchInterval: live ? false : 15_000,
  });

  // SSE live stream (Phase-2 P3-3).
  const sseUrl = React.useMemo(() => {
    if (!live) return null;
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    return `/api/tasks/sse?${params.toString()}`;
  }, [live, status]);

  const { events: sseTasks, status: sseStatus } = useEventSource(sseUrl, {
    enabled: live,
    maxEvents: limit,
  });

  // Map SSE events to the TaskRow shape.
  const liveTasks = React.useMemo(
    () =>
      sseTasks.map((sse) => {
        const d = sse.data;
        return {
          id: sse.id,
          opportunityId: (d.opportunityId as string) ?? undefined,
          fromAgent: ((d.fromAgent as string) ?? "orchestrator") as AgentName,
          toAgent: ((d.toAgent as string) ?? "orchestrator") as AgentName,
          objective: (d.objective as string) ?? "",
          input: "", // SSE events don't carry the full input/output JSON
          output: undefined,
          constraints: "",
          status: ((d.status as string) ?? "pending") as TaskStatus,
          riskLevel: (d.riskLevel as string) ?? "low",
          executionLevel: (d.executionLevel as number) ?? 0,
          modelId: (d.modelId as string) ?? undefined,
          tokensUsed: (d.tokensUsed as number) ?? 0,
          latencyMs: (d.latencyMs as number) ?? 0,
          qualityScore: (d.qualityScore as number) ?? undefined,
          error: undefined,
          createdAt: (d.createdAt as string) ?? new Date().toISOString(),
          startedAt: (d.startedAt as string) ?? undefined,
          completedAt: (d.completedAt as string) ?? undefined,
          updatedAt: (d.createdAt as string) ?? new Date().toISOString(),
        };
      }),
    [sseTasks]
  );

  const polledTasks = data?.tasks ?? [];
  const tasks = live ? [...liveTasks].reverse() : polledTasks;
  const selectedTask = tasks.find((t) => t.id === selected);

  // v0.4.4: status tally for the stat strip. Plain computation (no useMemo —
  // the React Compiler can't preserve memoization over the mutable SSE
  // mapping; the loop is over ≤ limit rows and runs once per render).
  const tally = new Map<TaskStatus, number>();
  for (const t of tasks) tally.set(t.status, (tally.get(t.status) ?? 0) + 1);

  if (error && !live) {
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
        Failed to load tasks: {String(error)}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <CardTitle className="text-sm flex items-center gap-2">
            <ListChecks className="size-4 text-emerald-500" />
            Tasks
            {live && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                <Radio className="size-2.5 animate-pulse" />
                LIVE
              </span>
            )}
          </CardTitle>
          <CardDescription>
            {tasks.length} task handoffs{live ? ` (streaming via SSE — ${sseStatus})` : ""}
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={live ? "default" : "outline"}
            onClick={() => setLive(!live)}
            className={cn(
              "focus-ring",
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
            value={status}
            onValueChange={(v) => setStatus(v as TaskStatus | "all")}
          >
            <SelectTrigger size="sm" className="w-[140px]" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">
                  {s === "all" ? "All statuses" : s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(limit)}
            onValueChange={(v) => setLimit(Number(v))}
          >
            <SelectTrigger size="sm" className="w-[110px]" aria-label="Limit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[25, 50, 100, 200].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  Last {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {/* Stat strip — status tally (v0.4.4) */}
        {tasks.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            {(["success", "failed", "running", "pending", "skipped", "cancelled"] as TaskStatus[])
              .filter((s) => tally.get(s))
              .map((s) => {
                const c = statusColor(s);
                const n = tally.get(s) ?? 0;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatus(status === s ? "all" : s)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
                      status === s
                        ? cn(c.bg, c.text, c.border)
                        : "border-border/60 bg-card text-muted-foreground hover:text-foreground"
                    )}
                    aria-pressed={status === s}
                  >
                    {s === "success" && <CheckCircle2 className="mr-1 inline size-3" aria-hidden />}
                    {s === "failed" && <XCircle className="mr-1 inline size-3" aria-hidden />}
                    {s.replace(/_/g, " ")}
                    <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                      {n}
                    </span>
                  </button>
                );
              })}
            <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
              {tasks.length} total
            </span>
          </div>
        )}

        {/* Task rows — card list (v0.4.4, was a 9-column table) */}
        <div className="max-h-[600px] space-y-2 overflow-y-auto scrollbar-thin pr-0.5">
          {isLoading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))
          ) : tasks.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/60">
              <div className="flex size-11 items-center justify-center rounded-full border border-dashed border-emerald-500/40 bg-emerald-500/10">
                <ListChecks className="size-5 text-emerald-500/80" aria-hidden />
              </div>
              <div className="space-y-1 text-center">
                <p className="text-sm font-medium">No tasks match the current filters</p>
                <p className="mx-auto max-w-xs text-xs leading-relaxed text-muted-foreground">
                  {live
                    ? "Waiting for new tasks… (the stream is open)"
                    : "Try changing the status filter, or click Go Live for real-time updates."}
                </p>
              </div>
            </div>
          ) : (
            tasks.map((t) => (
              <TaskRow key={t.id} task={t} onOpen={() => setSelected(t.id)} />
            ))
          )}
        </div>
      </CardContent>

      {/* Task detail dialog */}
      <Dialog
        open={!!selected}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {selectedTask ? truncateText(selectedTask.objective, 80) : "Task"}
            </DialogTitle>
            <DialogDescription>
              {selectedTask
                ? `${selectedTask.fromAgent} → ${selectedTask.toAgent} · ${formatRelativeTime(selectedTask.createdAt)}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {selectedTask ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric label="Status" value={selectedTask.status} />
                <Metric label="Risk" value={selectedTask.riskLevel} />
                <Metric label="Tokens" value={String(selectedTask.tokensUsed)} />
                <Metric
                  label="Latency"
                  value={selectedTask.latencyMs > 0 ? `${selectedTask.latencyMs}ms` : "—"}
                />
              </div>
              {selectedTask.error ? (
                <div className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300">
                  {selectedTask.error}
                </div>
              ) : null}
              {selectedTask.constraints ? (
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Constraints</div>
                  <pre className="mt-1 max-h-32 overflow-auto scrollbar-thin rounded-md bg-muted/40 p-2 text-[11px]">
                    {prettyJson(selectedTask.constraints)}
                  </pre>
                </div>
              ) : null}
              <div>
                <div className="text-xs font-medium text-muted-foreground">Input</div>
                <pre className="mt-1 max-h-48 overflow-auto scrollbar-thin rounded-md bg-muted/40 p-2 text-[11px]">
                  {prettyJson(selectedTask.input)}
                </pre>
              </div>
              {selectedTask.output ? (
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Output</div>
                  <pre className="mt-1 max-h-64 overflow-auto scrollbar-thin rounded-md bg-muted/40 p-2 text-[11px]">
                    {prettyJson(selectedTask.output)}
                  </pre>
                </div>
              ) : null}
              <TaskIterationHistory taskId={selectedTask.id} />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-card/40 p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xs font-medium capitalize">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TaskRow (v0.4.4) — one task as a responsive card row. Was a 9-column
// table row; now mirrors Opportunities cards / Event Log entries.
// ---------------------------------------------------------------------------

interface TaskRowData {
  id: string;
  fromAgent: AgentName;
  toAgent: AgentName;
  objective: string;
  status: TaskStatus;
  riskLevel: string;
  modelId?: string;
  tokensUsed: number;
  latencyMs: number;
  qualityScore?: number;
  createdAt: string;
}

function TaskRow({ task, onOpen }: { task: TaskRowData; onOpen: () => void }) {
  const sc = statusColor(task.status);
  const fc = agentColor(task.fromAgent);
  const tc = agentColor(task.toAgent);
  const failed = task.status === "failed";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "card-hover-lift row-hover group cursor-pointer rounded-lg border bg-card p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500/60",
        failed ? "border-red-500/25" : "border-border/50"
      )}
      aria-label={`Open task: ${task.objective}`}
    >
      <div className="flex items-start justify-between gap-3">
        {/* Main block */}
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-[13px] font-semibold leading-snug transition-colors group-hover:text-emerald-700 dark:group-hover:text-emerald-300"
            title={task.objective}
          >
            {truncateText(task.objective, 100)}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <Badge
              variant="outline"
              className={cn("capitalize", sc.bg, sc.text, sc.border)}
            >
              {sc.label}
            </Badge>
            <Badge
              variant="outline"
              className={cn("px-1.5 py-0 text-[10px]", fc.bg, fc.text, fc.border)}
            >
              {task.fromAgent}
            </Badge>
            <ArrowRight className="size-2.5 text-muted-foreground/60" aria-hidden />
            <Badge
              variant="outline"
              className={cn("px-1.5 py-0 text-[10px]", tc.bg, tc.text, tc.border)}
            >
              {task.toAgent}
            </Badge>
            <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-px font-medium capitalize">
              {task.riskLevel} risk
            </span>
            {task.modelId && (
              <span className="font-mono text-[10px] text-muted-foreground/80">
                · {task.modelId}
              </span>
            )}
          </div>
        </div>

        {/* Right block — compact mono metrics */}
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="flex items-center gap-2 text-[10px] tabular-nums text-muted-foreground">
            <span title="Tokens used" className="flex items-center gap-0.5">
              <Gauge className="size-3 text-muted-foreground/70" aria-hidden />
              {task.tokensUsed.toLocaleString()}
            </span>
            {task.latencyMs > 0 && (
              <span title="Latency">{task.latencyMs}ms</span>
            )}
            {task.qualityScore != null && (
              <span
                title="Quality score"
                className={cn(
                  "font-medium",
                  task.qualityScore >= 0.8
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-amber-600 dark:text-amber-400"
                )}
              >
                {Math.round(task.qualityScore * 100)}%
              </span>
            )}
          </div>
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <Clock className="size-3 text-muted-foreground/70" aria-hidden />
            {formatRelativeTime(task.createdAt)}
          </span>
        </div>
      </div>
    </div>
  );
}

function prettyJson(s: string | undefined | null): string {
  if (!s) return "(empty)";
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
