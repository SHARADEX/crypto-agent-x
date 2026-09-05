"use client";

// TaskIterationHistory — version history for a Task (Phase 3 §7, §8, §9).
//
// Renders the list of TaskIteration rows attached to a Task, with:
//   - Iteration number + version label (v0, v1, v2, …)
//   - Created date + quality score + test result summary
//   - The feedback that triggered the iteration (text + type + priority)
//   - "View" button → opens the artifact JSON for that version
//   - "Compare" button → opens a diff dialog between two versions
//   - "Restore" button → re-creates this version as a new current iteration
//
// Also surfaces the iteration-economics recommendation (Phase 3 §10) and the
// configurable `maxIterations` cap.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Badge,
} from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
  History,
  GitCompareArrows,
  Eye,
  RotateCcw,
  Loader2,
  ChevronRight,
} from "lucide-react";
import {
  api,
  formatRelativeTime,
  type IterationRow,
  type CompareIterationsResult,
  type IterationEconomics,
} from "./lib/api";
import { cn } from "@/lib/utils";

export function TaskIterationHistory({ taskId }: { taskId: string }) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["iterations", "task", taskId],
    queryFn: () => api.iterations.listForTask(taskId),
    refetchInterval: 30_000,
  });

  const { data: econData } = useQuery({
    queryKey: ["iterations", "economics", taskId],
    queryFn: () => api.iterations.economics(taskId),
    refetchInterval: 60_000,
  });

  const restoreMut = useMutation({
    mutationFn: (iterationId: string) => api.iterations.restore(iterationId),
    onSuccess: (res) => {
      toast.success(
        `Restored ${res.restoredFromVersion} → new ${res.iteration.version}.`
      );
      qc.invalidateQueries({ queryKey: ["iterations", "task", taskId] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (e) => toast.error(`Restore failed: ${e.message}`),
  });

  const [viewIteration, setViewIteration] = React.useState<IterationRow | null>(
    null
  );
  const [compareOpen, setCompareOpen] = React.useState(false);
  const [versionA, setVersionA] = React.useState<string>("");
  const [versionB, setVersionB] = React.useState<string>("");
  const [compareResult, setCompareResult] = React.useState<CompareIterationsResult | null>(
    null
  );
  const [showLineDiffs, setShowLineDiffs] = React.useState(false);
  const [lineDiffsLoading, setLineDiffsLoading] = React.useState(false);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const iterations = data?.iterations ?? [];
  const currentIterationId = data?.currentIterationId ?? null;
  const maxIterations = data?.maxIterations ?? 6;
  const iterationCount = data?.iterationCount ?? 0;
  const remaining = Math.max(0, maxIterations - iterationCount);
  const economics = econData?.economics;

  if (iterations.length === 0) {
    return (
      <div>
        <div className="text-xs font-medium text-muted-foreground">
          Iteration history
        </div>
        <p className="mt-1 text-xs text-muted-foreground italic">
          No iterations recorded for this task.
        </p>
      </div>
    );
  }

  const handleCompare = async () => {
    if (!versionA || !versionB || versionA === versionB) {
      toast.error("Pick two different versions to compare.");
      return;
    }
    try {
      // Phase-3 dev-review #2: when showLineDiffs is on, request the
      // line-level diff from the API. Otherwise, fetch the lightweight
      // summary only (faster + smaller payload).
      const res = await api.iterations.compare(taskId, versionA, versionB, {
        includeLineDiffs: showLineDiffs,
      });
      setCompareResult(res.comparison);
    } catch (err) {
      toast.error(
        `Compare failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  // Toggle the line-diff view: when turning ON, re-fetch the comparison
  // with includeLineDiffs=true (the existing compareResult doesn't have
  // the fileDiffs field). When turning OFF, just clear the fileDiffs field
  // client-side (no re-fetch needed).
  const toggleLineDiffs = async () => {
    if (!showLineDiffs) {
      // Turning ON — need to fetch line diffs.
      if (!versionA || !versionB || versionA === versionB) {
        toast.error("Pick two versions first.");
        return;
      }
      setLineDiffsLoading(true);
      try {
        const res = await api.iterations.compare(taskId, versionA, versionB, {
          includeLineDiffs: true,
        });
        setCompareResult(res.comparison);
        setShowLineDiffs(true);
      } catch (err) {
        toast.error(
          `Line diff failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setLineDiffsLoading(false);
      }
    } else {
      // Turning OFF — clear the fileDiffs field client-side.
      setShowLineDiffs(false);
      if (compareResult) {
        setCompareResult({
          ...compareResult,
          fileDiffs: undefined,
        });
      }
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground">
          Iteration history
        </div>
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">
            {iterationCount}/{maxIterations} used
          </Badge>
          <Badge
            variant="outline"
            className={cn(
              "text-[10px]",
              remaining > 0
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
            )}
          >
            {remaining > 0 ? `${remaining} left` : "cap reached"}
          </Badge>
          {economics ? (
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] capitalize",
                economicsRecommendationClass(economics.recommendation)
              )}
              title={economics.reason}
            >
              Next: {economics.recommendation.replace(/_/g, " ")}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="mt-2 space-y-1.5">
        {iterations.map((it) => {
          const isCurrent = it.id === currentIterationId;
          return (
            <div
              key={it.id}
              className={cn(
                "rounded-md border p-2",
                isCurrent
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : it.status === "superseded"
                  ? "border-border/40 bg-muted/20 opacity-70"
                  : "border-border/60 bg-card/40"
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px] font-mono",
                    isCurrent
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : ""
                  )}
                >
                  <History className="size-2.5" />
                  {it.version}
                </Badge>
                {isCurrent ? (
                  <Badge
                    variant="outline"
                    className="text-[9px] border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  >
                    CURRENT
                  </Badge>
                ) : null}
                {it.status !== "reviewed" && it.status !== "superseded" ? (
                  <Badge variant="outline" className="text-[9px] capitalize">
                    {it.status}
                  </Badge>
                ) : null}
                <span className="text-[10px] text-muted-foreground">
                  {formatRelativeTime(it.createdAt)}
                </span>
                {it.qualityScore != null ? (
                  <Badge variant="outline" className="text-[9px]">
                    Q: {it.qualityScore.toFixed(1)}
                  </Badge>
                ) : null}
                {it.modelId ? (
                  <Badge
                    variant="outline"
                    className="text-[9px] font-mono"
                  >
                    {it.modelId}
                  </Badge>
                ) : null}
                {it.agentName ? (
                  <Badge variant="outline" className="text-[9px] capitalize">
                    {it.agentName}
                  </Badge>
                ) : null}
              </div>

              {it.feedbackText ? (
                <div className="mt-1.5 rounded border border-amber-500/20 bg-amber-500/5 p-1.5 text-[11px]">
                  <div className="flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">
                    <ChevronRight className="size-2.5" />
                    Feedback:
                    {it.feedbackType ? (
                      <span className="ml-1 text-[9px] uppercase">
                        {it.feedbackType}
                      </span>
                    ) : null}
                    {it.feedbackPriority ? (
                      <span className="ml-1 text-[9px] uppercase">
                        / {it.feedbackPriority}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-muted-foreground">
                    {truncate(it.feedbackText, 240)}
                  </p>
                </div>
              ) : (
                <p className="mt-1 text-[10px] text-muted-foreground italic">
                  Initial iteration (no prior feedback).
                </p>
              )}

              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => setViewIteration(it)}
                >
                  <Eye className="size-3" />
                  View
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => {
                    if (!versionA) {
                      setVersionA(it.version);
                      toast.info(`Selected ${it.version} as version A.`);
                    } else if (!versionB && it.version !== versionA) {
                      setVersionB(it.version);
                      toast.info(
                        `Selected ${it.version} as version B. Click Compare to view the diff.`
                      );
                      setCompareOpen(true);
                    } else {
                      setVersionA(it.version);
                      setVersionB("");
                      setCompareResult(null);
                      toast.info(`Reset selection — picked ${it.version} as version A.`);
                    }
                  }}
                >
                  <GitCompareArrows className="size-3" />
                  Compare
                </Button>
                {!isCurrent ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    disabled={restoreMut.isPending}
                    onClick={() => restoreMut.mutate(it.id)}
                  >
                    {restoreMut.isPending &&
                    restoreMut.variables === it.id ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <RotateCcw className="size-3" />
                    )}
                    Restore
                  </Button>
                ) : null}
                {versionA === it.version ? (
                  <Badge
                    variant="outline"
                    className="text-[9px] border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
                  >
                    A
                  </Badge>
                ) : null}
                {versionB === it.version ? (
                  <Badge
                    variant="outline"
                    className="text-[9px] border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
                  >
                    B
                  </Badge>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Artifact viewer dialog */}
      <Dialog
        open={!!viewIteration}
        onOpenChange={(o) => {
          if (!o) setViewIteration(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <History className="size-4 text-muted-foreground" />
              {viewIteration?.version} artifact
            </DialogTitle>
            <DialogDescription>
              {viewIteration
                ? `Created ${formatRelativeTime(viewIteration.createdAt)} · Q=${viewIteration.qualityScore?.toFixed(1) ?? "—"} · ${viewIteration.tokensUsed} tokens`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {viewIteration ? (
            <div className="max-h-[60vh] overflow-auto scrollbar-thin rounded-md bg-muted/40 p-2">
              <pre className="text-[11px] whitespace-pre-wrap">
                {prettyJson(viewIteration.artifactJson)}
              </pre>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Compare dialog */}
      <Dialog
        open={compareOpen}
        onOpenChange={(o) => {
          setCompareOpen(o);
          if (!o) {
            setCompareResult(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <GitCompareArrows className="size-4 text-muted-foreground" />
              Compare iterations
            </DialogTitle>
            <DialogDescription>
              Pick two versions to see the diff (files added/removed/changed,
              quality delta, test results delta, safety delta).
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Select
              value={versionA}
              onValueChange={(v) => {
                setVersionA(v);
                setCompareResult(null);
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Version A" />
              </SelectTrigger>
              <SelectContent>
                {iterations.map((it) => (
                  <SelectItem key={it.id} value={it.version}>
                    {it.version}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">vs</span>
            <Select
              value={versionB}
              onValueChange={(v) => {
                setVersionB(v);
                setCompareResult(null);
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Version B" />
              </SelectTrigger>
              <SelectContent>
                {iterations.map((it) => (
                  <SelectItem key={it.id} value={it.version}>
                    {it.version}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={handleCompare}
              disabled={!versionA || !versionB || versionA === versionB}
            >
              Compare
            </Button>
          </div>
          {compareResult ? (
            <div className="space-y-2 text-xs">
              <div className="grid grid-cols-3 gap-2">
                <Stat
                  label="Files added"
                  value={String(compareResult.filesAdded.length)}
                  tone="emerald"
                />
                <Stat
                  label="Files removed"
                  value={String(compareResult.filesRemoved.length)}
                  tone="red"
                />
                <Stat
                  label="Files changed"
                  value={String(compareResult.filesChanged.length)}
                  tone="amber"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Stat
                  label="Quality Δ"
                  value={
                    compareResult.qualityDelta >= 0
                      ? `+${compareResult.qualityDelta.toFixed(1)}`
                      : compareResult.qualityDelta.toFixed(1)
                  }
                  tone={
                    compareResult.qualityDelta > 0
                      ? "emerald"
                      : compareResult.qualityDelta < 0
                      ? "red"
                      : "slate"
                  }
                />
                <Stat
                  label="Tests Δ"
                  value={`${compareResult.testResultsDelta.passedDelta > 0 ? "+" : ""}${compareResult.testResultsDelta.passedDelta} pass / ${compareResult.testResultsDelta.failedDelta > 0 ? "+" : ""}${compareResult.testResultsDelta.failedDelta} fail`}
                  tone="slate"
                />
                <Stat
                  label="Safety risk Δ"
                  value={
                    compareResult.safetyDelta <= 0
                      ? `${compareResult.safetyDelta} (lower = safer)`
                      : `+${compareResult.safetyDelta} (higher = riskier)`
                  }
                  tone={
                    compareResult.safetyDelta < 0
                      ? "emerald"
                      : compareResult.safetyDelta > 0
                      ? "red"
                      : "slate"
                  }
                />
              </div>
              {compareResult.notes.length > 0 ? (
                <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
                  {compareResult.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              ) : null}
              {compareResult.filesChanged.length > 0 ? (
                <div>
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] font-medium uppercase text-muted-foreground">
                      Changed files
                    </div>
                    {/* Phase-3 dev-review #2: "Show line diff" toggle. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-2 text-[10px]"
                      onClick={toggleLineDiffs}
                      disabled={lineDiffsLoading}
                    >
                      {lineDiffsLoading ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <GitCompareArrows className="size-3" />
                      )}
                      {showLineDiffs ? "Hide line diff" : "Show line diff"}
                    </Button>
                  </div>
                  <ul className="mt-0.5 space-y-0.5 text-[11px] font-mono">
                    {compareResult.filesChanged.map((f) => (
                      <li key={f.path}>
                        {f.path}{" "}
                        <span className="text-muted-foreground">
                          ({f.beforeLines} → {f.afterLines} lines)
                        </span>
                      </li>
                    ))}
                  </ul>
                  {/* Line-level diff view (Phase-3 dev-review #2). */}
                  {showLineDiffs && compareResult.fileDiffs ? (
                    <div className="mt-2 space-y-2">
                      {compareResult.fileDiffs.map((fd) => (
                        <div
                          key={fd.path}
                          className="overflow-hidden rounded border border-border/60 bg-muted/30"
                        >
                          <div className="border-b border-border/60 bg-muted/60 px-2 py-1 text-[10px] font-mono">
                            {fd.path}
                          </div>
                          <div className="max-h-64 overflow-auto scrollbar-thin">
                            <pre className="text-[10px] leading-tight">
                              {fd.hunks.map((h, i) => (
                                <div
                                  key={i}
                                  className={cn(
                                    "flex px-2 py-px font-mono",
                                    h.type === "added" &&
                                      "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
                                    h.type === "removed" &&
                                      "bg-red-500/15 text-red-800 dark:text-red-200",
                                    h.type === "context" &&
                                      "text-muted-foreground"
                                  )}
                                >
                                  <span className="w-8 shrink-0 select-none text-right opacity-50">
                                    {h.lineNo}
                                  </span>
                                  <span className="ml-2 w-3 shrink-0 select-none opacity-70">
                                    {h.type === "added"
                                      ? "+"
                                      : h.type === "removed"
                                      ? "-"
                                      : " "}
                                  </span>
                                  <span className="ml-2 whitespace-pre-wrap break-all">
                                    {h.text || " "}
                                  </span>
                                </div>
                              ))}
                            </pre>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              Pick two versions and click Compare to view the diff.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "emerald" | "red" | "amber" | "slate";
}) {
  const toneClass = {
    emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    red: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    amber: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    slate: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  }[tone];
  return (
    <div className={cn("rounded border p-2", toneClass)}>
      <div className="text-[9px] uppercase tracking-wide opacity-80">
        {label}
      </div>
      <div className="mt-0.5 text-xs font-semibold">{value}</div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function prettyJson(s: string | undefined | null): string {
  if (!s) return "(empty)";
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function economicsRecommendationClass(recommendation: string): string {
  switch (recommendation) {
    case "worth_it":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "marginal":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "not_worth_it":
    default:
      return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  }
}

export type { IterationEconomics };
