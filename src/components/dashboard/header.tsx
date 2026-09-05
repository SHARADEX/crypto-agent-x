"use client";

// Header — sticky top of the dashboard. Carries:
//   - logo + title + subtitle
//   - agent status pill (RUNNING / PAUSED / STOPPED / IDLE)
//   - autonomy mode dropdown (observe / assist / semi / full)
//   - action buttons: Run Cycle, Pause/Resume, Emergency Stop
//   - theme toggle

import * as React from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Play,
  Pause,
  Square,
  RotateCcw,
  Loader2,
  ChevronDown,
  Activity,
  ShieldAlert,
  ExternalLink,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AutonomyMode } from "@/lib/agent/types";
import { api } from "./lib/api";
import { cn } from "@/lib/utils";
import { AgentStatusBadge } from "./agent-status-badge";
import { ThemeToggle } from "./theme-provider";

const AUTONOMY_OPTIONS: { value: AutonomyMode; label: string; hint: string }[] = [
  { value: "observe", label: "Observe", hint: "Discover + verify only" },
  { value: "assist", label: "Assist", hint: "Low-risk execution (L1)" },
  { value: "semi", label: "Semi-Autonomous", hint: "Moderate-risk (L2)" },
  { value: "full", label: "Full Autonomous", hint: "Everything except L3" },
];

export function Header() {
  const qc = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["agent-status"],
    queryFn: () => api.agent.status(),
    refetchInterval: 5_000,
  });

  const runCycleMut = useMutation({
    mutationFn: () => api.agent.runCycle(1, 500),
    onSuccess: (res) => {
      toast.success(`Cycle ${res.count} completed.`);
      qc.invalidateQueries({ queryKey: ["agent-status"] });
      qc.invalidateQueries({ queryKey: ["analytics"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
    },
    onError: (e) => toast.error(`Run cycle failed: ${e.message}`),
  });

  const pauseMut = useMutation({
    mutationFn: () => api.agent.pause("operator pause"),
    onSuccess: () => {
      toast.info("Agent paused.");
      qc.invalidateQueries({ queryKey: ["agent-status"] });
    },
    onError: (e) => toast.error(`Pause failed: ${e.message}`),
  });

  const resumeMut = useMutation({
    mutationFn: () => api.agent.resume(),
    onSuccess: () => {
      toast.success("Agent resumed.");
      qc.invalidateQueries({ queryKey: ["agent-status"] });
    },
    onError: (e) => toast.error(`Resume failed: ${e.message}`),
  });

  const emergencyStopMut = useMutation({
    mutationFn: () => api.agent.emergencyStop("operator emergency stop"),
    onSuccess: () => {
      toast.error("Emergency stop engaged.");
      qc.invalidateQueries({ queryKey: ["agent-status"] });
    },
    onError: (e) => toast.error(`Emergency stop failed: ${e.message}`),
  });

  const emergencyResetMut = useMutation({
    mutationFn: () => api.agent.emergencyReset(),
    onSuccess: () => {
      toast.success("Kill switches cleared. Agent is now runnable.");
      qc.invalidateQueries({ queryKey: ["agent-status"] });
    },
    onError: (e) => toast.error(`Reset failed: ${e.message}`),
  });

  const autonomyMut = useMutation({
    mutationFn: (mode: AutonomyMode) => api.agent.autonomy(mode),
    onSuccess: (_res, mode) => {
      toast.success(`Autonomy set to ${mode}.`);
      qc.invalidateQueries({ queryKey: ["agent-status"] });
    },
    onError: (e) => toast.error(`Autonomy change failed: ${e.message}`),
  });

  const isPaused = !!status?.paused;
  const isStopped = !!status?.emergencyStop;
  const canRun = !!(status?.canRun?.canRun ?? status?.canRun?.allowed);
  const autonomyMode = status?.autonomyMode ?? "observe";

  return (
    <header
      className={cn(
        "sticky top-0 z-40 w-full border-b border-border/60 bg-background/95 backdrop-blur",
        "supports-[backdrop-filter]:bg-background/80"
      )}
    >
      <div className="mx-auto flex max-w-[1600px] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
        {/* Brand */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="relative size-10 shrink-0 overflow-hidden rounded-lg bg-emerald-500/10 ring-1 ring-emerald-500/30">
            <Image
              src="/agent-logo.png"
              alt="CryptoEarn Agent logo"
              fill
              priority
              sizes="40px"
              className="object-cover"
            />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold leading-none sm:text-lg">
                CryptoEarn Agent
              </h1>
              <AgentStatusBadge status={status} />
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              Autonomous Zero-Cost Crypto Earning Agent
            </p>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={autonomyMode}
            onValueChange={(v) => autonomyMut.mutate(v as AutonomyMode)}
            disabled={autonomyMut.isPending}
          >
            <SelectTrigger
              size="sm"
              className="w-[150px] sm:w-[180px]"
              aria-label="Autonomy mode"
            >
              <SelectValue placeholder="Autonomy" />
            </SelectTrigger>
            <SelectContent>
              {AUTONOMY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">{opt.label}</span>
                    <span className="text-[10px] text-muted-foreground">{opt.hint}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            size="sm"
            className="bg-emerald-600 text-white hover:bg-emerald-600/90"
            onClick={() => runCycleMut.mutate()}
            disabled={runCycleMut.isPending || !canRun}
            aria-label="Run one cycle now"
          >
            {runCycleMut.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Play className="size-3" />
            )}
            <span className="hidden sm:inline">Run Cycle</span>
          </Button>

          {isPaused ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => resumeMut.mutate()}
              disabled={resumeMut.isPending}
              aria-label="Resume the agent"
            >
              <Activity className="size-3" />
              <span className="hidden sm:inline">Resume</span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => pauseMut.mutate()}
              disabled={pauseMut.isPending || isStopped}
              aria-label="Pause the agent"
            >
              <Pause className="size-3" />
              <span className="hidden sm:inline">Pause</span>
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant={isStopped ? "destructive" : "outline"}
                aria-label="Emergency controls"
              >
                {isStopped ? <ShieldAlert className="size-3" /> : <Square className="size-3" />}
                <span className="hidden sm:inline">{isStopped ? "Stopped" : "Emergency"}</span>
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Kill Switch</DropdownMenuLabel>
              <DropdownMenuItem
                onClick={() => emergencyStopMut.mutate()}
                className="text-red-600 focus:text-red-700"
              >
                <Square className="size-3" /> Emergency Stop
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => emergencyResetMut.mutate()}
              >
                <RotateCcw className="size-3" /> Reset (clear stop + pause)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <ThemeToggle />

          {/* Public read-only view — opens the shareable dashboard in a new tab */}
          <Button
            size="sm"
            variant="ghost"
            className="focus-ring"
            aria-label="Open public read-only dashboard"
            title="Open the public read-only dashboard (safe to share)"
            onClick={() => {
              if (typeof window !== "undefined") {
                window.open("?view=public", "_blank");
              }
            }}
          >
            <ExternalLink className="size-3" />
            <span className="hidden md:inline">Public View</span>
          </Button>
        </div>
      </div>

      {/* Reason strip — shows the kill switch reason when engaged */}
      {status?.killSwitch?.reason ? (
        <div className="border-t border-red-500/30 bg-red-500/10 px-4 py-1.5 text-xs text-red-700 dark:text-red-300">
          <span className="font-medium">Kill switch engaged:</span>{" "}
          {status.killSwitch.reason}
          {status.killSwitch.fetchedAt
            ? ` · updated ${new Date(status.killSwitch.fetchedAt).toLocaleTimeString()}`
            : null}
        </div>
      ) : null}

      {/* Budget pill — shows daily LLM token usage */}
      {status?.budget ? (
        <div className="hidden border-t border-border/40 bg-muted/30 px-4 py-1.5 text-[11px] text-muted-foreground sm:flex sm:items-center sm:gap-3">
          <span className="font-medium">Budget</span>
          <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
            {(status.budget.day.llmTokens / 1000).toFixed(1)}k / {(status.budget.limits.dailyLlmTokens / 1000).toFixed(0)}k daily tokens
          </Badge>
          <Badge variant="outline" className="border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
            {status.budget.hour.llmTokens} / {status.budget.limits.hourlyLlmTokens} hourly
          </Badge>
          <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
            {status.budget.day.webRequests} web req · {status.budget.day.rpcRequests} RPC
          </Badge>
        </div>
      ) : null}
    </header>
  );
}
