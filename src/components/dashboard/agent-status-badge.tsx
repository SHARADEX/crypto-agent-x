"use client";

// AgentStatusBadge — the reusable colored pill shown in the header.
//
// Maps the kill switch + running state to one of four visible states:
//   RUNNING        (running=true, paused=false, emergencyStop=false)
//   PAUSED         (paused=true)
//   STOPPED        (emergencyStop=true)
//   IDLE           (running=false but no kill switch engaged — between cycles)
//
// The RUNNING state uses the `pulse-dot` CSS class so the dot has an
// expanding ring animation — draws the eye to "the agent is alive".

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AgentStatusResponse } from "./lib/api";

export function AgentStatusBadge({
  status,
  className,
}: {
  status: AgentStatusResponse | undefined;
  className?: string;
}) {
  const { label, dot, bg, text, border, pulse } = compute(status);
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 px-2.5 py-1 text-xs font-medium",
        bg,
        text,
        border,
        className
      )}
      aria-label={`Agent status: ${label}`}
    >
      <span className="relative flex size-1.5">
        {pulse && (
          <span
            className={cn(
              "pulse-dot size-1.5 rounded-full",
              dot
            )}
          />
        )}
        <span className={cn("size-1.5 rounded-full", dot)} />
      </span>
      {label}
    </Badge>
  );
}

function compute(status: AgentStatusResponse | undefined) {
  if (!status) {
    return {
      label: "BOOTING",
      dot: "bg-slate-400",
      bg: "bg-slate-500/15",
      text: "text-slate-700 dark:text-slate-300",
      border: "border-slate-500/30",
      pulse: false,
    };
  }
  if (status.emergencyStop) {
    return {
      label: "STOPPED",
      dot: "bg-red-500",
      bg: "bg-red-500/20",
      text: "text-red-700 dark:text-red-300",
      border: "border-red-500/40",
      pulse: false,
    };
  }
  if (status.paused) {
    return {
      label: "PAUSED",
      dot: "bg-amber-500",
      bg: "bg-amber-500/15",
      text: "text-amber-700 dark:text-amber-300",
      border: "border-amber-500/30",
      pulse: false,
    };
  }
  if (status.running) {
    return {
      label: "RUNNING",
      dot: "bg-emerald-500",
      bg: "bg-emerald-500/15",
      text: "text-emerald-700 dark:text-emerald-300",
      border: "border-emerald-500/30",
      pulse: true,
    };
  }
  return {
    label: "IDLE",
    dot: "bg-slate-400",
    bg: "bg-slate-500/15",
    text: "text-slate-700 dark:text-slate-300",
    border: "border-slate-500/30",
    pulse: false,
  };
}
