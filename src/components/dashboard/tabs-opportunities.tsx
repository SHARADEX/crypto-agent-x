"use client";

// OpportunitiesTab v2 — card-list design.
//
// Replaces the raw 11-column table (VLM 3/10) with a responsive card list:
//   1. Header + actions (Seed New / Export CSV)
//   2. Quick status chips with live counts (one tap filtering)
//   3. Compact filter bar (status / category / source / sort / search)
//   4. Stat strip — shown / active / avg reward / avg risk
//   5. Opportunity cards: title + reward, muted metadata pills, score meters
//   6. Designed empty state with CTAs (no more bare "no match" row)
//
// The counts query shares the Daily Briefing cache (same queryKey) so no
// extra network request is made when navigating between tabs.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BadgeCheck,
  Clock,
  ExternalLink,
  Loader2,
  Plus,
  Radar,
  Search,
  Sparkles,
  Star,
  Download,
  FilterX,
  X,
} from "lucide-react";
import { WatchStar } from "./watch-star";
import { daysUntil, deadlineUrgency, DEADLINE_ACTIVE_STATUSES } from "./lib/deadline";
import {
  api,
  formatRelativeTime,
  formatUsd,
  statusColor,
} from "./lib/api";
import { ScoreBar } from "./score-bar";
import { cn } from "@/lib/utils";
import type {
  Opportunity,
  OpportunityCategory,
  OpportunityStatus,
} from "@/lib/agent/types";

const STATUS_OPTIONS: OpportunityStatus[] = [
  "discovered",
  "researching",
  "verified",
  "queued",
  "planning",
  "approved",
  "executing",
  "executed",
  "submitted", // Phase-3 fix (Issue 10): PR opened, awaiting review/merge.
  "awaiting_payment",
  "needs_improvement",
  "paid",
  "rejected",
  "failed",
];

const CATEGORY_OPTIONS: OpportunityCategory[] = [
  "bounty",
  "github_bounty",
  "bug_bounty",
  "hackathon",
  "docs",
  "developer_task",
  "coding_task",
  "data_task",
  "freelance",
  "grant",
  "ecosystem",
  "referral",
  "content",
  "oss_contribution",
];

const SORT_OPTIONS = [
  { value: "score", label: "Best Score" },
  { value: "reward", label: "Highest Reward" },
  { value: "newest", label: "Newest" },
  { value: "deadline", label: "Soonest Deadline" },
] as const;

// Pipeline order for the quick status chips (matching the briefing funnel).
const CHIP_ORDER: OpportunityStatus[] = [
  "discovered",
  "verified",
  "queued",
  "approved",
  "executing",
  "executed",
  "submitted",
  "awaiting_payment",
  "paid",
  "needs_improvement",
  "rejected",
  "failed",
];

export function OpportunitiesTab({
  onOpenOpportunity,
  initialStatus,
  initialClosingSoon,
  initialWatchlist,
  initialSearch,
  onFiltersChange,
}: {
  onOpenOpportunity: (id: string) => void;
  /**
   * Optional initial status filter — set by the Lifecycle tab when the user
   * clicks a status node. The value is applied on mount + whenever it
   * changes (so navigating from Lifecycle → Opportunities with a different
   * status updates the filter even when OpportunitiesTab is already
   * mounted, which is the case inside the dashboard's tab switcher).
   */
  initialStatus?: OpportunityStatus;
  /**
   * v0.4.3: initial closing-soon filter — set by the briefing Action Center
   * "Triage" CTA. Applied once on mount (sentinel-guarded so re-navigations
   * with the same value still re-apply).
   */
  initialClosingSoon?: boolean;
  /**
   * v0.4.5: initial watchlist-only filter — set by the `?watchlist=1`
   * deep-link param (read once by the page client on mount).
   */
  initialWatchlist?: boolean;
  /**
   * v0.4.6: initial search text — set by the `?q=` deep-link param (read
   * once by the page client on mount), e.g. bookmarking a keyword search.
   */
  initialSearch?: string;
  /**
   * v0.4.5: reports local filter changes back to the page client so the
   * URL deep-link params and remount behavior always honor the operator's
   * last choice instead of a stale navigation intent.
   * v0.4.6: `search` added so typed keywords become a `?q=` deep-link.
   */
  onFiltersChange?: (filters: {
    status: string | null;
    closingSoon: boolean;
    watchlist: boolean;
    search: string;
  }) => void;
}) {
  const qc = useQueryClient();
  const [status, setStatus] = React.useState<OpportunityStatus | "all">(
    initialStatus ?? "all"
  );
  const [category, setCategory] = React.useState<OpportunityCategory | "all">("all");
  const [source, setSource] = React.useState<string>("all");
  const [sort, setSort] = React.useState<(typeof SORT_OPTIONS)[number]["value"]>("score");
  // v0.4.6: seeded from the `?q=` deep-link param.
  const [search, setSearch] = React.useState(initialSearch ?? "");
  // v0.4.1: watchlist-only filter (star toggle lives on each card).
  // v0.4.5: seeded from the `?watchlist=1` deep-link param.
  const [watchlistOnly, setWatchlistOnly] = React.useState(
    initialWatchlist ?? false
  );
  // v0.4.2: deadline-urgency filter — active opportunities whose deadline
  // lands within 7 days (overdue included). Client-side over the list cache.
  const [closingSoonOnly, setClosingSoonOnly] = React.useState(
    initialClosingSoon ?? false
  );
  // Sentinel: consume initialClosingSoon once (avoids re-activating the
  // filter after the operator clears it while staying on this tab).
  const consumedInitialClosingSoon = React.useRef(false);
  const searchRef = React.useRef<HTMLInputElement>(null);

  // "/" focuses search — matches the command-palette keyboard convention.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Sync `initialStatus` → `status` whenever it changes (so navigating from
  // the Lifecycle tab to Opportunities with a different status updates the
  // filter even when OpportunitiesTab is already mounted).
  React.useEffect(() => {
    if (initialStatus) setStatus(initialStatus);
  }, [initialStatus]);

  // v0.4.3: apply the briefing's closing-soon intent once per navigation.
  React.useEffect(() => {
    if (initialClosingSoon && !consumedInitialClosingSoon.current) {
      consumedInitialClosingSoon.current = true;
      setClosingSoonOnly(true);
    }
    if (!initialClosingSoon) {
      consumedInitialClosingSoon.current = false;
    }
  }, [initialClosingSoon]);

  // v0.4.5: report local filter changes upward so the page client can sync
  // the deep-link URL params (and remounts honor the operator's last choice).
  // Fires on mount with the prop-derived state — the parent's setState then
  // becomes a same-value no-op, so no render loop.
  React.useEffect(() => {
    onFiltersChange?.({
      status: status === "all" ? null : status,
      closingSoon: closingSoonOnly,
      watchlist: watchlistOnly,
      search,
    });
  }, [status, closingSoonOnly, watchlistOnly, search, onFiltersChange]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["opportunities", { status, category, source, sort, watchlistOnly }],
    queryFn: () =>
      api.opportunities.list({
        status: status === "all" ? undefined : status,
        category: category === "all" ? undefined : category,
        source: source === "all" ? undefined : source,
        watched: watchlistOnly ? true : undefined,
        sort,
        limit: 200,
      }),
    refetchInterval: 15_000,
  });

  // Share the Daily Briefing's full-list cache for chip counts (no extra fetch).
  const { data: all } = useQuery({
    queryKey: ["opportunities", "briefing"],
    queryFn: () =>
      api.opportunities.list({ limit: 500 } as Parameters<typeof api.opportunities.list>[0]),
    refetchInterval: 60_000,
  });

  const seedMut = useMutation({
    mutationFn: () => api.opportunities.seed(),
    onSuccess: (res) => {
      const summary = (res.summary as { new?: number; discovered?: number } | undefined) ?? {};
      toast.success(
        `Discovery complete — ${summary.new ?? 0} new / ${summary.discovered ?? 0} total.`
      );
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["analytics"] });
    },
    onError: (e) => toast.error(`Seed failed: ${e.message}`),
  });

  const filtered = React.useMemo(() => {
    let rows = data?.opportunities ?? [];
    if (closingSoonOnly) {
      rows = rows.filter(
        (o) =>
          DEADLINE_ACTIVE_STATUSES.has(o.status) &&
          o.deadline &&
          Date.parse(o.deadline) <= Date.now() + 7 * 86_400_000
      );
    }
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.organization.toLowerCase().includes(q) ||
        r.sourceUrl.toLowerCase().includes(q)
    );
  }, [data, search, closingSoonOnly]);

  const sources = React.useMemo(() => {
    const s = new Set<string>();
    (data?.opportunities ?? []).forEach((r) => s.add(r.source));
    return Array.from(s).sort();
  }, [data]);

  // Status chips with counts (from the unfiltered briefing cache).
  const chips = React.useMemo(() => {
    const counts = new Map<OpportunityStatus, number>();
    (all?.opportunities ?? []).forEach((o) => {
      counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
    });
    return CHIP_ORDER.filter((s) => counts.get(s)).map((s) => ({
      status: s,
      count: counts.get(s) ?? 0,
    }));
  }, [all]);

  // Watchlist count (from the briefing cache — no extra fetch).
  const watchedCount = React.useMemo(
    () => (all?.opportunities ?? []).filter((o) => o.watched).length,
    [all]
  );

  // v0.4.2: closing-soon count — active + deadline ≤ 7d out (overdue
  // included). Powers the ⏰ chip so the operator can triage time pressure.
  const closingSoonCount = React.useMemo(
    () =>
      (all?.opportunities ?? []).filter(
        (o) =>
          DEADLINE_ACTIVE_STATUSES.has(o.status) &&
          o.deadline &&
          Date.parse(o.deadline) <= Date.now() + 7 * 86_400_000
      ).length,
    [all]
  );

  const filtersActive =
    status !== "all" ||
    category !== "all" ||
    source !== "all" ||
    watchlistOnly ||
    closingSoonOnly ||
    !!search.trim();

  const clearFilters = () => {
    setStatus("all");
    setCategory("all");
    setSource("all");
    setSearch("");
    setWatchlistOnly(false);
    setClosingSoonOnly(false);
  };

  // Stat strip aggregates.
  const stats = React.useMemo(() => {
    if (filtered.length === 0) return null;
    const active = filtered.filter((o) =>
      ["queued", "approved", "executing", "executed", "submitted", "awaiting_payment"].includes(o.status)
    ).length;
    const avgReward =
      filtered.reduce((s, o) => s + (o.reward.estimated_usd ?? 0), 0) / filtered.length;
    const avgRisk = filtered.reduce((s, o) => s + (o.riskScore ?? 0), 0) / filtered.length;
    return { active, avgReward, avgRisk };
  }, [filtered]);

  if (error) {
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
        Failed to load opportunities: {String(error)}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header + actions */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold tracking-tight">
            <Radar className="size-4 text-emerald-500" />
            Opportunities
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {isLoading ? "…" : filtered.length} shown of {data?.total ?? all?.total ?? 0} discovered ·
            click a card for the full brief
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => seedMut.mutate()}
            disabled={seedMut.isPending}
          >
            {seedMut.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            Seed New
          </Button>
          {/* Phase-3 DEV-REVIEW-4 (priority #4): operator data export. */}
          <Button
            size="sm"
            variant="ghost"
            className="gap-1 text-muted-foreground"
            title="Export the current filtered set as CSV (download)"
            onClick={() => {
              const params = new URLSearchParams({ format: "csv" });
              if (status !== "all") params.set("status", status);
              if (category !== "all") params.set("category", category);
              if (source !== "all") params.set("source", source);
              // Open in a new tab so the browser downloads the file
              // without navigating away from the dashboard.
              window.open(`/api/export/opportunities?${params.toString()}`, "_blank");
            }}
          >
            <Download className="size-3.5" />
            CSV
          </Button>
        </div>
      </div>

      {/* Quick status chips — one-tap pipeline filtering */}
      {chips.length > 0 && (
        <div
          className="scrollbar-thin flex items-center gap-1.5 overflow-x-auto pb-0.5"
          role="tablist"
          aria-label="Quick status filter"
        >
          <StatusChip
            active={status === "all" && !watchlistOnly}
            label="All"
            count={all?.total ?? 0}
            onClick={() => {
              setStatus("all");
              setWatchlistOnly(false);
            }}
          />
          {chips.map((c) => (
            <StatusChip
              key={c.status}
              active={status === c.status && !watchlistOnly}
              label={c.status.replace(/_/g, " ")}
              count={c.count}
              onClick={() => {
                setStatus(c.status);
                setWatchlistOnly(false);
              }}
            />
          ))}
          {/* v0.4.1: watchlist chip — starred opportunities only */}
          {watchedCount > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={watchlistOnly}
              onClick={() => setWatchlistOnly((v) => !v)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                watchlistOnly
                  ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                  : "border-border/60 bg-card text-muted-foreground hover:border-amber-500/40 hover:text-amber-600 dark:hover:text-amber-400"
              )}
            >
              <Star className="size-3 fill-current" aria-hidden />
              Watchlist
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] tabular-nums",
                  watchlistOnly
                    ? "bg-amber-500/20 text-amber-700 dark:text-amber-300"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {watchedCount}
              </span>
            </button>
          )}
          {/* v0.4.2: closing-soon chip — deadline within 7d (overdue incl.) */}
          {closingSoonCount > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={closingSoonOnly}
              onClick={() => setClosingSoonOnly((v) => !v)}
              title="Active opportunities with a deadline in the next 7 days (past-deadline included)"
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                closingSoonOnly
                  ? "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300"
                  : "border-border/60 bg-card text-muted-foreground hover:border-red-500/40 hover:text-red-600 dark:hover:text-red-400"
              )}
            >
              <Clock className="size-3" aria-hidden />
              Closing soon
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] tabular-nums",
                  closingSoonOnly
                    ? "bg-red-500/20 text-red-700 dark:text-red-300"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {closingSoonCount}
              </span>
            </button>
          )}
        </div>
      )}

      {/* Filter bar */}
      <Card className="border-border/60">
        <CardContent className="p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <Select value={status} onValueChange={(v) => setStatus(v as OpportunityStatus | "all")}>
              <SelectTrigger size="sm" aria-label="Filter by status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={category} onValueChange={(v) => setCategory(v as OpportunityCategory | "all")}>
              <SelectTrigger size="sm" aria-label="Filter by category">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {CATEGORY_OPTIONS.map((c) => (
                  <SelectItem key={c} value={c} className="capitalize">
                    {c.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={source} onValueChange={(v) => setSource(v)}>
              <SelectTrigger size="sm" aria-label="Filter by source">
                <SelectValue placeholder="Source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                {sources.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
              <SelectTrigger size="sm" aria-label="Sort by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="relative col-span-2 sm:col-span-1">
              <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                placeholder="Search title/org/url…  ( / )"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-7 text-xs"
              />
              {search && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          </div>

          {/* Active filters + stat strip */}
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {filtersActive ? (
                <>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Filters
                  </span>
                  {status !== "all" && (
                    <FilterChip onClear={() => setStatus("all")}>
                      {status.replace(/_/g, " ")}
                    </FilterChip>
                  )}
                  {category !== "all" && (
                    <FilterChip onClear={() => setCategory("all")}>
                      {category.replace(/_/g, " ")}
                    </FilterChip>
                  )}
                  {source !== "all" && (
                    <FilterChip onClear={() => setSource("all")}>{source}</FilterChip>
                  )}
                  {watchlistOnly && (
                    <FilterChip onClear={() => setWatchlistOnly(false)}>
                      ★ watchlist
                    </FilterChip>
                  )}
                  {closingSoonOnly && (
                    <FilterChip onClear={() => setClosingSoonOnly(false)}>
                      ⏰ closing soon
                    </FilterChip>
                  )}
                  {search.trim() && (
                    <FilterChip onClear={() => setSearch("")}>“{search.trim()}”</FilterChip>
                  )}
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <FilterX className="size-3" />
                    Clear all
                  </button>
                </>
              ) : (
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  No filters
                </span>
              )}
            </div>
            {stats && (
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="tabular-nums">
                  <span className="font-semibold text-foreground tabular-nums">
                    {filtered.length}
                  </span>{" "}
                  shown
                </span>
                <span className="hidden items-center gap-1 sm:flex">
                  <span className="size-1.5 rounded-full bg-teal-500" />
                  {stats.active} active
                </span>
                <span className="hidden items-center gap-1 md:flex">
                  avg reward
                  <span className="font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                    {formatUsd(stats.avgReward, { compact: true })}
                  </span>
                </span>
                <span className="hidden items-center gap-1 md:flex">
                  avg risk
                  <span className="font-semibold tabular-nums">
                    {stats.avgRisk.toFixed(0)}
                  </span>
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Card list */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="border-border/60">
          <CardContent>
            <div className="empty-state">
              <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                <Radar className="size-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">No opportunities match</p>
              <p className="max-w-md text-xs text-muted-foreground">
                {filtersActive
                  ? "Nothing in the current filter. Loosen the filters or run a fresh discovery cycle."
                  : "The pipeline is empty. Seed a discovery cycle and the scout agents will scan sources for bounties, tasks and grants."}
              </p>
              <div className="mt-3 flex items-center gap-2">
                {filtersActive && (
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={clearFilters}>
                    <FilterX className="size-3.5" />
                    Clear filters
                  </Button>
                )}
                <Button
                  size="sm"
                  className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-600/90"
                  onClick={() => seedMut.mutate()}
                  disabled={seedMut.isPending}
                >
                  {seedMut.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="size-3.5" />
                  )}
                  Run discovery
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="scrollbar-thin max-h-[600px] space-y-2 overflow-y-auto pr-1">
          {filtered.map((op) => (
            <OpportunityCard key={op.id} op={op} onOpen={onOpenOpportunity} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusChip — quick one-tap pipeline filter chip
// ---------------------------------------------------------------------------

function StatusChip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
        active
          ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
          : "border-border/60 bg-card text-muted-foreground hover:border-border hover:text-foreground"
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 text-[10px] tabular-nums",
          active
            ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
            : "bg-muted text-muted-foreground"
        )}
      >
        {count}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// FilterChip — removable active-filter chip
// ---------------------------------------------------------------------------

function FilterChip({
  children,
  onClear,
}: {
  children: React.ReactNode;
  onClear: () => void;
}) {
  return (
    <span className="flex items-center gap-1 rounded-full border border-border/60 bg-muted/50 py-0.5 pl-2 pr-1 text-[10px] font-medium capitalize">
      {children}
      <button
        type="button"
        onClick={onClear}
        aria-label="Remove filter"
        className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      >
        <X className="size-2.5" />
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// OpportunityCard — responsive card row
// ---------------------------------------------------------------------------

function OpportunityCard({
  op,
  onOpen,
}: {
  op: Opportunity;
  onOpen: (id: string) => void;
}) {
  const sc = statusColor(op.status);
  const reward = op.reward.estimated_usd ?? 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(op.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(op.id);
        }
      }}
      className="card-hover-lift row-hover group cursor-pointer rounded-lg border border-border/50 bg-card p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500/60"
      aria-label={`Open ${op.title}`}
    >
      <div className="flex items-start justify-between gap-3">
        {/* Main block */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {op.paymentVerified && (
              <span title="Payment verified by the source" className="shrink-0">
                <BadgeCheck className="size-3.5 text-emerald-500" aria-label="Payment verified" />
              </span>
            )}
            <p
              className="truncate text-[13px] font-semibold leading-snug transition-colors group-hover:text-emerald-700 dark:group-hover:text-emerald-300"
              title={op.title}
            >
              {op.title}
            </p>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <span
              className={cn(
                "rounded-full border px-1.5 py-px font-medium capitalize",
                sc.bg,
                sc.text,
                sc.border
              )}
            >
              {sc.label.replace(/_/g, " ")}
            </span>
            <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-px font-medium capitalize">
              {op.category.replace(/_/g, " ")}
            </span>
            <span className="font-mono">{op.source}</span>
            <span className="hidden max-w-[10rem] truncate sm:inline" title={op.organization}>
              · {op.organization}
            </span>
            {op.deadline && (
              <span
                className={cn(
                  "flex items-center gap-0.5 rounded-full border px-1.5 py-px font-semibold tabular-nums",
                  deadlineUrgency(daysUntil(op.deadline)).className
                )}
                title={`Deadline: ${new Date(op.deadline).toLocaleString()}`}
              >
                <Clock className="size-2.5" aria-hidden />
                {deadlineUrgency(daysUntil(op.deadline)).label}
              </span>
            )}
            {/* Mobile-only compact risk indicator */}
            <span className="font-medium tabular-nums md:hidden">· risk {Math.round(op.riskScore)}</span>
          </div>
        </div>

        {/* Right block — reward + actions */}
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="flex items-center gap-1">
            <span
              className={cn(
                "font-mono text-[13px] font-semibold tabular-nums",
                reward > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground/70"
              )}
              title="Estimated reward"
            >
              {formatUsd(reward)}
            </span>
            {/* v0.4.1: watchlist star — pin for later review */}
            <WatchStar id={op.id} watched={!!op.watched} />
          </div>
          <div className="flex items-center gap-2">
            <span
              className="text-[10px] tabular-nums text-muted-foreground"
              title="Risk-adjusted expected value per hour"
            >
              {formatUsd(op.riskAdjustedHourly)}/hr
            </span>
            {op.sourceUrl && (
              <a
                href={op.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Open source in a new tab"
                onClick={(e) => {
                  e.stopPropagation();
                }}
                className="text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
              >
                <ExternalLink className="size-3.5 hover:text-foreground" />
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Meters — md and up */}
      <div className="mt-2.5 hidden items-center gap-5 border-t border-border/40 pt-2.5 md:flex">
        <div className="flex w-32 items-center gap-2">
          <span className="w-10 shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground">
            Risk
          </span>
          <ScoreBar value={op.riskScore} kind="risk" />
        </div>
        <div className="flex w-32 items-center gap-2">
          <span className="w-11 shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground">
            Verify
          </span>
          <ScoreBar value={op.verificationScore} kind="verification" />
        </div>
        <div className="ml-auto flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="tabular-nums" title="Estimated effort">
            {op.estimatedHours > 0 ? `${op.estimatedHours.toFixed(1)}h est.` : "—"}
          </span>
          <span className="tabular-nums" title={`Difficulty ${op.difficulty}/10 · competition ${op.competition}/10`}>
            D{op.difficulty} · C{op.competition}
          </span>
        </div>
      </div>
    </div>
  );
}
