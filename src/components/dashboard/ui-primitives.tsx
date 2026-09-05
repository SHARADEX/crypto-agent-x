// Reusable dashboard UI primitives — skeleton loaders, empty states, KPI cards
// with count-up animation, and a mobile-friendly section card.
//
// These are used across every tab to give the dashboard a consistent,
// polished feel: loading skeletons instead of blank spaces, friendly empty
// states with icons + CTAs, and KPI numbers that animate in on mount.

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

// ---------------------------------------------------------------------------
// Skeleton — shimmer placeholder
// ---------------------------------------------------------------------------

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("skeleton-shimmer rounded-md", className)}
      aria-hidden="true"
      {...props}
    />
  );
}

/** A row of skeleton lines for table loading states. */
export function SkeletonRow({ cols = 4 }: { cols?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 px-3 py-2 md:grid-cols-4 xl:grid-cols-12">
      {Array.from({ length: cols }).map((_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </div>
  );
}

/** A full skeleton card for the KPI grid. */
export function SkeletonKpiCard() {
  return (
    <Card className="border-border/60">
      <CardContent className="p-4">
        <Skeleton className="mb-2 h-3 w-20" />
        <Skeleton className="h-7 w-24" />
        <Skeleton className="mt-2 h-3 w-16" />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// EmptyState — friendly centered empty state with icon + CTA
// ---------------------------------------------------------------------------

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn("empty-state", className)} role="status">
      {icon && (
        <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium">{title}</p>
      {description && (
        <p className="max-w-md text-xs text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KpiCard — KPI with count-up animation on mount
// ---------------------------------------------------------------------------

interface KpiCardProps {
  label: string;
  value: number | string | null | undefined;
  format?: (v: number) => string;
  accent?: "emerald" | "amber" | "red" | "slate" | "teal" | "blue";
  icon?: React.ReactNode;
  hint?: string;
  delta?: { value: number; positive?: boolean };
  isLoading?: boolean;
}

const ACCENT_CLASSES: Record<string, string> = {
  emerald: "text-emerald-600 dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  red: "text-red-600 dark:text-red-400",
  slate: "text-slate-600 dark:text-slate-300",
  teal: "text-teal-600 dark:text-teal-400",
  blue: "text-sky-600 dark:text-sky-400",
};

const ACCENT_BG: Record<string, string> = {
  emerald: "bg-emerald-500/10",
  amber: "bg-amber-500/10",
  red: "bg-red-500/10",
  slate: "bg-slate-500/10",
  teal: "bg-teal-500/10",
  blue: "bg-sky-500/10",
};

export function KpiCard({
  label,
  value,
  format,
  accent = "emerald",
  icon,
  hint,
  delta,
  isLoading,
}: KpiCardProps) {
  const displayValue = React.useMemo(() => {
    if (value === null || value === undefined) return "—";
    if (typeof value === "string") return value;
    if (format) return format(value);
    return value.toLocaleString();
  }, [value, format]);

  return (
    <Card className="card-hover-lift border-border/60">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          {icon && (
            <span
              className={cn(
                "flex size-7 items-center justify-center rounded-md",
                ACCENT_BG[accent]
              )}
            >
              {icon}
            </span>
          )}
        </div>
        <div
          className={cn(
            "number-tick mt-2 font-mono text-2xl font-semibold tabular-nums",
            ACCENT_CLASSES[accent]
          )}
          key={String(value)}
        >
          {isLoading ? <Skeleton className="h-7 w-20" /> : displayValue}
        </div>
        <div className="mt-1 flex items-center gap-2">
          {hint && (
            <span className="text-[10px] text-muted-foreground">{hint}</span>
          )}
          {delta && (
            <span
              className={cn(
                "text-[10px] font-medium tabular-nums",
                delta.positive ? "text-emerald-600" : "text-red-600"
              )}
            >
              {delta.positive ? "▲" : "▼"} {Math.abs(delta.value).toFixed(1)}%
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SectionCard — a titled section with optional action + loading state
// ---------------------------------------------------------------------------

interface SectionCardProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  isLoading?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function SectionCard({
  title,
  description,
  action,
  isLoading,
  children,
  className,
}: SectionCardProps) {
  return (
    <Card className={cn("border-border/60", className)}>
      <CardContent className="p-4 md:p-5">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">{title}</h3>
            {description && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {action && <div className="flex-shrink-0">{action}</div>}
        </div>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// BadgePill — a small colored pill with optional dot
// ---------------------------------------------------------------------------

interface BadgePillProps {
  children: React.ReactNode;
  color?: "emerald" | "amber" | "red" | "slate" | "teal" | "blue" | "purple";
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}

const PILL_CLASSES: Record<string, string> = {
  emerald:
    "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20",
  amber:
    "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20",
  red: "bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/20",
  slate: "bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/20",
  teal: "bg-teal-500/10 text-teal-700 dark:text-teal-300 border-teal-500/20",
  blue: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20",
  purple:
    "bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/20",
};

const DOT_CLASSES: Record<string, string> = {
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  slate: "bg-slate-500",
  teal: "bg-teal-500",
  blue: "bg-sky-500",
  purple: "bg-purple-500",
};

export function BadgePill({
  children,
  color = "slate",
  dot,
  pulse,
  className,
}: BadgePillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        PILL_CLASSES[color],
        className
      )}
    >
      {dot && (
        <span className="relative flex size-1.5">
          {pulse && <span className={cn("pulse-dot size-1.5 rounded-full", DOT_CLASSES[color])} />}
          <span className={cn("size-1.5 rounded-full", DOT_CLASSES[color])} />
        </span>
      )}
      {children}
    </span>
  );
}
