"use client";

// Footer — sticky bottom. Shows cycle count, last cycle time + result,
// and a public view link. Per project UI rules this sticks to the viewport
// bottom (mt-auto on the wrapper) and pushes down when content overflows.
// Budget details live in the sidebar health card (v2).

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { api, formatRelativeTime } from "./lib/api";

export function Footer() {
  const { data: status } = useQuery({
    queryKey: ["agent-status"],
    queryFn: () => api.agent.status(),
    refetchInterval: 5_000,
  });

  const cycleCount = status?.cycleCount ?? 0;
  const lastCycle = status?.lastCycleAt ?? null;
  const lastResult = status?.lastCycleResult ?? null;

  return (
    <footer
      className="mt-auto w-full border-t border-border/60 bg-background/95 px-4 py-2 backdrop-blur"
      aria-label="Dashboard footer"
    >
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            <span className="font-medium text-foreground">{cycleCount.toLocaleString()}</span>{" "}
            cycles
          </span>
          <span aria-hidden>·</span>
          <span>
            Last cycle:{" "}
            <span className="font-medium text-foreground">
              {formatRelativeTime(lastCycle)}
            </span>
          </span>
          {lastResult ? (
            <>
              <span aria-hidden>·</span>
              <span>
                Result:{" "}
                <span className="font-mono text-foreground">{lastResult}</span>
              </span>
            </>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* Public view link — opens the shareable read-only dashboard */}
          <a
            href="?view=public"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-emerald-600 transition-colors hover:text-emerald-500 dark:text-emerald-400"
            aria-label="Open public read-only dashboard in a new tab"
          >
            <ExternalLink className="size-3" />
            Public View
          </a>
          <span aria-hidden>·</span>
          <span className="font-mono">v0.4.0</span>
        </div>
      </div>
    </footer>
  );
}
