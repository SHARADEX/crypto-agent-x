"use client";

// WatchStar (v0.4.1) — the operator's opportunity watchlist.
//
// Starring is pure UI state (Opportunity.watched in the DB): it never
// influences agent scoring or lifecycle — it only lets the operator pin
// promising bounties for review during daily check-ins. The Daily Briefing
// surfaces starred items in a "Your Watchlist" section, and the
// Opportunities tab has a Watchlist filter chip.
//
// Optimistic updates: the star toggles instantly; a failed PATCH rolls the
// cache back and toasts the error. Queries ["opportunities"], ["briefing"]
// and ["opportunity-detail", id] are invalidated on success.

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api } from "./lib/api";
import type { Opportunity } from "@/lib/agent/types";

export function useToggleWatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, watched }: { id: string; watched: boolean }) =>
      api.opportunities.setWatched(id, watched),
    onMutate: async ({ id, watched }) => {
      // Optimistically patch every cached opportunities list.
      const keys = qc.getQueriesData<OpportunityListShape>({ queryKey: ["opportunities"] });
      const snapshots = keys.map(([key, data]) => ({
        key,
        data: data
          ? {
              ...data,
              opportunities: (data as OpportunityListShape).opportunities?.map?.(
                (o: Opportunity) => (o.id === id ? { ...o, watched } : o)
              ),
            }
          : data,
      }));
      for (const [key] of keys) {
        const entry = snapshots.find((s) => s.key === key);
        if (entry?.data) qc.setQueryData(key, entry.data);
      }
      return { snapshots };
    },
    onError: (err, _vars, ctx) => {
      // Roll back the optimistic cache updates.
      for (const s of ctx?.snapshots ?? []) {
        if (s.data !== undefined) qc.setQueryData(s.key, s.data);
      }
      toast.error(`Watchlist update failed: ${err.message}`);
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["briefing"] });
      qc.invalidateQueries({ queryKey: ["opportunity-detail", vars.id] });
      toast.success(
        vars.watched ? "Added to your watchlist." : "Removed from watchlist.",
        { duration: 1800 }
      );
    },
  });
}

interface OpportunityListShape {
  opportunities?: Opportunity[];
  count?: number;
}

export function WatchStar({
  id,
  watched,
  size = "sm",
  className,
  label,
}: {
  id: string;
  watched: boolean;
  size?: "sm" | "md";
  className?: string;
  label?: string;
}) {
  const toggle = useToggleWatch();
  const pending = toggle.isPending && toggle.variables?.id === id;
  const iconSize = size === "md" ? "size-4" : "size-3.5";

  return (
    <button
      type="button"
      aria-label={
        label ?? (watched ? "Remove from watchlist" : "Add to watchlist")
      }
      aria-pressed={watched}
      title={watched ? "Remove from watchlist" : "Star for later review"}
      disabled={pending}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        toggle.mutate({ id, watched: !watched });
      }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md p-1 transition-all",
        "hover:bg-amber-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50",
        watched
          ? "text-amber-500"
          : "text-muted-foreground/50 hover:text-amber-500",
        pending && "opacity-50",
        className
      )}
    >
      <Star
        className={cn(iconSize, watched && "fill-amber-500")}
        aria-hidden
      />
    </button>
  );
}
