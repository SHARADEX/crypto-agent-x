"use client";

// ScoreBar — colored progress bar for risk / verification / capability scores.
//
// The bar fills to `value / max` and is tinted by either an explicit kind
// (risk → red→amber→emerald reversed, verification → emerald→red) or a
// literal color class for generic capability bars.

import { cn } from "@/lib/utils";
import { riskColor, verificationColor } from "./lib/api";

type Kind = "risk" | "verification" | "emerald" | "amber" | "red" | "teal";

export function ScoreBar({
  value,
  max = 100,
  kind = "emerald",
  showValue = false,
  className,
}: {
  value: number;
  max?: number;
  kind?: Kind;
  showValue?: boolean;
  className?: string;
}) {
  const safe = Number.isFinite(value) ? value : 0;
  const pct = Math.max(0, Math.min(100, (safe / (max || 1)) * 100));
  const color = colorFor(kind, safe);
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-500/15">
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full transition-all", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showValue && (
        <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
          {Math.round(safe)}
        </span>
      )}
    </div>
  );
}

function colorFor(kind: Kind, value: number): string {
  if (kind === "risk") return riskColor(value);
  if (kind === "verification") return verificationColor(value);
  if (kind === "emerald") return "bg-emerald-500";
  if (kind === "amber") return "bg-amber-500";
  if (kind === "red") return "bg-red-500";
  if (kind === "teal") return "bg-teal-500";
  return "bg-emerald-500";
}
