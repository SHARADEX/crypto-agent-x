"use client";

// Topbar — v2 compact header. ONE bar instead of three stacked ones.
//
//   [hamburger (mobile)] [page title] ... [status pill] [autonomy] [Run] [Pause] [Emergency] [bell]
//
// The old design stacked brand + controls + budget + three banners. The new
// design moves brand to the sidebar, budget to the sidebar health card, and
// consolidates the banners into the Daily Briefing action center.

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Menu,
  Play,
  Pause,
  ShieldAlert,
  Square,
  RotateCcw,
  Loader2,
  ChevronDown,
  Bell,
  Keyboard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import type { AutonomyMode } from "@/lib/agent/types";
import { api, type AgentStatusResponse } from "../lib/api";
import { cn } from "@/lib/utils";

const AUTONOMY_OPTIONS: { value: AutonomyMode; label: string; hint: string }[] = [
  { value: "observe", label: "Observe", hint: "Discover + verify only" },
  { value: "assist", label: "Assist", hint: "Low-risk execution (L1)" },
  { value: "semi", label: "Semi", hint: "Moderate-risk (L2)" },
  { value: "full", label: "Full", hint: "Everything except L3" },
];

const TAB_TITLES: Record<string, { title: string; sub: string }> = {
  overview: { title: "Daily Briefing", sub: "Your check-in for today" },
  daily: { title: "Daily Report", sub: "AI-generated status + recommendations" },
  lifecycle: { title: "Pipeline", sub: "Opportunity lifecycle flow" },
  events: { title: "Event Log", sub: "Append-only agent activity" },
  opportunities: { title: "Opportunities", sub: "Discovered earning opportunities" },
  approvals: { title: "Approvals", sub: "Actions awaiting your decision" },
  tasks: { title: "Tasks", sub: "Agent work units" },
  ledger: { title: "Earnings Ledger", sub: "Verified vs expected earnings" },
  wallets: { title: "Wallets", sub: "Read-only on-chain monitor" },
  strategies: { title: "Strategies", sub: "Learning + allocation" },
  memory: { title: "Agent Memory", sub: "Lessons learned across cycles" },
  models: { title: "Model Routing", sub: "LLM providers + health" },
  architecture: { title: "Architecture", sub: "System map" },
};

export function Topbar({
  activeTab,
  status,
  onOpenSidebar,
  onOpenNotifications,
  onOpenHelp,
  pendingNotifications,
}: {
  activeTab: string;
  status?: AgentStatusResponse;
  onOpenSidebar: () => void;
  onOpenNotifications: () => void;
  onOpenHelp: () => void;
  pendingNotifications: number;
}) {
  const qc = useQueryClient();

  const runCycleMut = useMutation({
    mutationFn: () => api.agent.runCycle(1, 500),
    onSuccess: (res) => {
      toast.success(`Cycle ${res.count} completed.`);
      qc.invalidateQueries();
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
  const autonomyMode = status?.autonomyMode ?? "observe";
  const running = status?.running && !isPaused && !isStopped;
  const meta = TAB_TITLES[activeTab] ?? { title: "Dashboard", sub: "" };

  return (
    <header
      className={cn(
        "sticky top-0 z-30 w-full border-b border-border/60 bg-background/85 backdrop-blur-lg",
        "supports-[backdrop-filter]:bg-background/70"
      )}
    >
      <div className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-5">
        {/* Mobile hamburger */}
        <Button
          variant="ghost"
          size="icon"
          className="size-9 lg:hidden"
          onClick={onOpenSidebar}
          aria-label="Open navigation menu"
        >
          <Menu className="size-4" />
        </Button>

        {/* Page title */}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold leading-tight tracking-tight sm:text-[15px]">
            {meta.title}
          </h1>
          <p className="hidden truncate text-[11px] text-muted-foreground sm:block">
            {meta.sub}
          </p>
        </div>

        {/* Agent status pill */}
        <button
          type="button"
          onClick={onOpenHelp}
          className={cn(
            "hidden items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-semibold sm:flex",
            isStopped
              ? "border-red-500/40 bg-red-500/10 text-red-400"
              : running
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                : "border-amber-500/40 bg-amber-500/10 text-amber-500"
          )}
          title={status?.canRun?.reason ?? "Agent status"}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              isStopped ? "bg-red-400" : running ? "pulse-dot bg-emerald-400" : "bg-amber-400"
            )}
          />
          {isStopped ? "STOPPED" : running ? "RUNNING" : isPaused ? "PAUSED" : "IDLE"}
        </button>

        {/* Autonomy selector */}
        <Select
          value={autonomyMode}
          onValueChange={(v) => autonomyMut.mutate(v as AutonomyMode)}
          disabled={autonomyMut.isPending}
        >
          <SelectTrigger
            size="sm"
            className="hidden h-8 w-[104px] text-[11px] md:flex"
            aria-label="Autonomy mode"
            title="Agent autonomy level"
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

        {/* Primary actions — the run-cycle API works in one-shot mode even
            when the background loop is not "running" (CI/GitHub-Actions uses
            exactly this path), so the button must stay enabled whenever the
            kill switch is NOT engaged. Only a hard stop blocks a cycle. */}
        <Button
          size="sm"
          className="h-8 bg-emerald-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-emerald-600/90"
          onClick={() => runCycleMut.mutate()}
          disabled={runCycleMut.isPending || isStopped}
          aria-label="Run one autonomous cycle now"
          title={isStopped ? "Kill switch engaged — reset first" : "Run one cycle now"}
        >
          {runCycleMut.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Play className="size-3.5" />
          )}
          <span className="hidden sm:inline">Run Cycle</span>
        </Button>

        {isPaused ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2.5"
            onClick={() => resumeMut.mutate()}
            disabled={resumeMut.isPending}
            aria-label="Resume the agent"
            title="Resume"
          >
            <Play className="size-3.5" />
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2.5"
            onClick={() => pauseMut.mutate()}
            disabled={pauseMut.isPending || isStopped}
            aria-label="Pause the agent"
            title="Pause"
          >
            <Pause className="size-3.5" />
          </Button>
        )}

        {/* Emergency dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant={isStopped ? "destructive" : "outline"}
              className="h-8 px-2.5"
              aria-label="Emergency controls"
              title="Kill switch controls"
            >
              {isStopped ? (
                <ShieldAlert className="size-3.5" />
              ) : (
                <Square className="size-3.5" />
              )}
              <ChevronDown className="hidden size-3 opacity-60 sm:inline" />
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
            <DropdownMenuItem onClick={() => emergencyResetMut.mutate()}>
              <RotateCcw className="size-3" /> Reset (clear stop + pause)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Notification history */}
        <Button
          size="sm"
          variant="outline"
          className="relative h-8 px-2.5"
          onClick={onOpenNotifications}
          aria-label={`Notification history${pendingNotifications > 0 ? `, ${pendingNotifications} unread` : ""}`}
          title="Notification history"
        >
          <Bell className="size-3.5" />
          {pendingNotifications > 0 && (
            <span className="nav-badge absolute -right-1 -top-1 !h-4 !min-w-4 !text-[8px]">
              {pendingNotifications > 9 ? "9+" : pendingNotifications}
            </span>
          )}
        </Button>

        {/* Keyboard help */}
        <Button
          size="sm"
          variant="ghost"
          className="hidden h-8 px-2.5 md:flex"
          onClick={onOpenHelp}
          aria-label="Keyboard shortcuts help"
          title="Keyboard shortcuts (?)"
        >
          <Keyboard className="size-3.5" />
        </Button>
      </div>

      {/* Kill-switch reason strip — only when engaged */}
      {status?.killSwitch?.reason ? (
        <div className="border-t border-red-500/30 bg-red-500/10 px-4 py-1.5 text-xs text-red-700 dark:text-red-300">
          <span className="font-medium">Kill switch engaged:</span>{" "}
          {status.killSwitch.reason}
          {status.killSwitch.fetchedAt
            ? ` · updated ${new Date(status.killSwitch.fetchedAt).toLocaleTimeString()}`
            : null}
        </div>
      ) : null}
    </header>
  );
}
