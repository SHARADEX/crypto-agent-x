"use client";

// MemoryTab — visualizes the agent's cross-cycle "lessons learned"
// (spec §17, Phase-2 P3-2).
//
// Shows:
//   1. Summary cards (total memories, active, superseded, avg confidence)
//   2. Category breakdown (strategy_insight, scam_pattern, execution_lesson, etc.)
//   3. Top-applied memories (the lessons the agent has referenced most)
//   4. Full memory list with filters (category, search) + pagination

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Brain, TrendingUp, AlertTriangle, Lightbulb, Shield } from "lucide-react";
import { api } from "./lib/api";
import { Skeleton, EmptyState, BadgePill } from "./ui-primitives";

// ---------------------------------------------------------------------------
// Types (mirror the backend AgentMemory shapes)
// ---------------------------------------------------------------------------

interface AgentMemoryEntry {
  id: string;
  category: string;
  title: string;
  body: string;
  payload?: Record<string, unknown> | null;
  tags: string[];
  confidence: number;
  timesApplied: number;
  superseded: boolean;
  opportunityId?: string | null;
  agent: string;
  createdAt: string;
  updatedAt: string;
}

interface MemorySummary {
  total: number;
  active: number;
  superseded: number;
  byCategory: Record<string, number>;
  avgConfidence: number;
  topApplied: AgentMemoryEntry[];
}

interface MemoryListResponse {
  memories: AgentMemoryEntry[];
  total: number;
}

const CATEGORIES = [
  { value: "all", label: "All categories" },
  { value: "strategy_insight", label: "Strategy insights" },
  { value: "model_performance", label: "Model performance" },
  { value: "source_reliability", label: "Source reliability" },
  { value: "scam_pattern", label: "Scam patterns" },
  { value: "execution_lesson", label: "Execution lessons" },
  { value: "general", label: "General" },
];

const CATEGORY_ICON: Record<string, React.ReactNode> = {
  strategy_insight: <TrendingUp className="size-3.5 text-emerald-500" />,
  model_performance: <Brain className="size-3.5 text-sky-500" />,
  source_reliability: <Shield className="size-3.5 text-teal-500" />,
  scam_pattern: <AlertTriangle className="size-3.5 text-amber-500" />,
  execution_lesson: <Lightbulb className="size-3.5 text-purple-500" />,
  general: <Brain className="size-3.5 text-slate-500" />,
};

const CATEGORY_COLOR: Record<
  string,
  "emerald" | "amber" | "red" | "slate" | "teal" | "blue" | "purple"
> = {
  strategy_insight: "emerald",
  model_performance: "blue",
  source_reliability: "teal",
  scam_pattern: "amber",
  execution_lesson: "purple",
  general: "slate",
};

// ---------------------------------------------------------------------------

export function MemoryTab() {
  const [category, setCategory] = React.useState("all");
  const [search, setSearch] = React.useState("");

  const { data: summary, isLoading: summaryLoading } = useQuery<MemorySummary>({
    queryKey: ["memory", "summary"],
    queryFn: () =>
      apiFetch<MemorySummary>("/api/memory?summary=true"),
    refetchInterval: 30_000,
  });

  const { data: listData, isLoading: listLoading } = useQuery<MemoryListResponse>({
    queryKey: ["memory", "list", category],
    queryFn: () =>
      apiFetch<MemoryListResponse>(
        `/api/memory?limit=100${category !== "all" ? `&category=${category}` : ""}`
      ),
    refetchInterval: 30_000,
  });

  const memories = listData?.memories ?? [];
  const filtered = React.useMemo(() => {
    if (!search.trim()) return memories;
    const q = search.toLowerCase();
    return memories.filter(
      (m) =>
        m.title.toLowerCase().includes(q) ||
        m.body.toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [memories, search]);

  return (
    <div className="space-y-6">
      {/* Summary KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryCard
          label="Total Memories"
          value={summaryLoading ? null : summary?.total}
          icon={<Brain className="size-4" />}
          accent="teal"
          isLoading={summaryLoading}
        />
        <SummaryCard
          label="Active"
          value={summaryLoading ? null : summary?.active}
          icon={<TrendingUp className="size-4" />}
          accent="emerald"
          isLoading={summaryLoading}
        />
        <SummaryCard
          label="Superseded"
          value={summaryLoading ? null : summary?.superseded}
          icon={<AlertTriangle className="size-4" />}
          accent="amber"
          isLoading={summaryLoading}
        />
        <SummaryCard
          label="Avg Confidence"
          value={
            summaryLoading
              ? null
              : summary?.avgConfidence != null
              ? `${(summary.avgConfidence * 100).toFixed(0)}%`
              : null
          }
          icon={<Shield className="size-4" />}
          accent="teal"
          isLoading={summaryLoading}
        />
      </div>

      {/* Category breakdown */}
      {summary && Object.keys(summary.byCategory).length > 0 && (
        <Card className="card-hover-lift border-border/60">
          <CardHeader>
            <CardTitle className="text-sm">Memories by Category</CardTitle>
            <CardDescription>
              Distribution of lessons learned across the agent's memory
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {Object.entries(summary.byCategory).map(([cat, count]) => (
                <BadgePill key={cat} color={CATEGORY_COLOR[cat] ?? "slate"}>
                  {CATEGORY_ICON[cat]} {cat.replace(/_/g, " ")}: {count}
                </BadgePill>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top-applied memories */}
      {summary && summary.topApplied.length > 0 && (
        <Card className="card-hover-lift border-border/60">
          <CardHeader>
            <CardTitle className="text-sm">Most-Referenced Lessons</CardTitle>
            <CardDescription>
              The memories the agent has applied most often during decision-making
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {summary.topApplied.map((m, i) => (
                <div
                  key={m.id}
                  className="row-hover flex items-start gap-3 rounded-md border border-border/40 p-3"
                >
                  <span className="flex size-6 flex-shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {m.title}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {m.timesApplied}× applied
                      </Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {m.body}
                    </p>
                  </div>
                  <BadgePill
                    color={CATEGORY_COLOR[m.category] ?? "slate"}
                    className="flex-shrink-0"
                  >
                    {m.category.replace(/_/g, " ")}
                  </BadgePill>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-full sm:w-56">
            <SelectValue placeholder="Filter by category" />
          </SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Search memories by title, body, or tag…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1"
        />
        <Badge variant="outline" className="text-xs">
          {filtered.length} of {memories.length}
        </Badge>
      </div>

      {/* Full memory list */}
      <Card className="border-border/60">
        <CardHeader>
          <CardTitle className="text-sm">All Memories</CardTitle>
          <CardDescription>
            Chronological list of lessons learned. Superseded memories are
            struck through.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {listLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Brain className="size-5 text-emerald-500/80" />}
              title="No memories recorded yet"
              description="The agent records lessons learned after each opportunity reaches a terminal state (paid, failed, or rejected). Run a few cycles to populate the memory."
            />
          ) : (
            <div className="max-h-[600px] space-y-2 overflow-y-auto scrollbar-thin">
              {filtered.map((m) => (
                <div
                  key={m.id}
                  className={`row-hover rounded-md border border-border/40 p-3 ${
                    m.superseded ? "opacity-60" : ""
                  }`}
                >
                  <div className="mb-1 flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {CATEGORY_ICON[m.category]}
                      <span
                        className={`text-sm font-medium ${
                          m.superseded ? "line-through" : ""
                        }`}
                      >
                        {m.title}
                      </span>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-1.5">
                      <BadgePill
                        color={CATEGORY_COLOR[m.category] ?? "slate"}
                      >
                        {m.category.replace(/_/g, " ")}
                      </BadgePill>
                      {m.superseded && (
                        <Badge variant="outline" className="text-[10px]">
                          superseded
                        </Badge>
                      )}
                    </div>
                  </div>
                  <p className="line-clamp-3 text-xs text-muted-foreground">
                    {m.body}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                    {m.tags.length > 0 && (
                      <span className="font-mono">
                        tags: {m.tags.join(", ")}
                      </span>
                    )}
                    <span>·</span>
                    <span>confidence: {(m.confidence * 100).toFixed(0)}%</span>
                    <span>·</span>
                    <span>{m.timesApplied}× applied</span>
                    <span>·</span>
                    <span>by {m.agent}</span>
                    <span>·</span>
                    <span>{new Date(m.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiFetch<T>(url: string): Promise<T> {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<T>;
  });
}

function SummaryCard({
  label,
  value,
  icon,
  accent,
  isLoading,
}: {
  label: string;
  value: number | string | null | undefined;
  icon: React.ReactNode;
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

  return (
    <Card className="card-hover-lift border-border/60">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          <span
            className={`flex size-7 items-center justify-center rounded-md ${ACCENT_BG[accent]}`}
          >
            {icon}
          </span>
        </div>
        <div
          className={`number-tick mt-2 font-mono text-2xl font-semibold tabular-nums ${ACCENT_TEXT[accent]}`}
          key={String(value)}
        >
          {isLoading ? <Skeleton className="h-7 w-16" /> : (value ?? "—")}
        </div>
      </CardContent>
    </Card>
  );
}
