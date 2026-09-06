"use client";

// AppSidebar — the v2 navigation shell.
//
// Replaces the 13-item horizontal tab strip (navigation overload) with a
// grouped vertical sidebar. On desktop (lg+) it is a fixed 232px rail.
// On narrow viewports (chat side panels, phones) it becomes a slide-over
// drawer triggered from the topbar hamburger.
//
// Groups are organized by operator intent:
//   MONITOR  — "what's happening" (daily check-in surfaces)
//   EARN     — "the money path" (opportunities → approvals → tasks)
//   ANALYZE  — "results + learning"
//   SYSTEM   — "plumbing" (rarely needed)

import * as React from "react";
import Image from "next/image";
import {
  LayoutDashboard,
  Radar,
  Clock4,
  Wallet,
  GitBranch,
  BarChart3,
  Trophy,
  BookOpen,
  ScrollText,
  Cpu,
  BrainCircuit,
  Boxes,
  Network,
  Terminal as TerminalIcon,
  Sun,
  Moon,
  ExternalLink,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentStatusResponse } from "../lib/api";
import { useTheme } from "next-themes";

export type TabId =
  | "overview"
  | "opportunities"
  | "lifecycle"
  | "wallets"
  | "models"
  | "strategies"
  | "ledger"
  | "approvals"
  | "tasks"
  | "events"
  | "daily"
  | "memory"
  | "architecture";

interface NavItem {
  id: TabId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Monitor",
    items: [
      { id: "overview", label: "Daily Briefing", icon: LayoutDashboard },
      { id: "daily", label: "Daily Report", icon: BarChart3 },
      { id: "lifecycle", label: "Pipeline", icon: Clock4 },
      { id: "events", label: "Event Log", icon: ScrollText },
    ],
  },
  {
    label: "Earn",
    items: [
      { id: "opportunities", label: "Opportunities", icon: Radar },
      { id: "approvals", label: "Approvals", icon: GitBranch },
      { id: "tasks", label: "Tasks", icon: Boxes },
      { id: "ledger", label: "Earnings Ledger", icon: Trophy },
      { id: "wallets", label: "Wallets", icon: Wallet },
    ],
  },
  {
    label: "Analyze",
    items: [
      { id: "strategies", label: "Strategies", icon: BookOpen },
      { id: "memory", label: "Agent Memory", icon: BrainCircuit },
    ],
  },
  {
    label: "System",
    items: [
      { id: "models", label: "Model Routing", icon: Cpu },
      { id: "architecture", label: "Architecture", icon: Network },
    ],
  },
];

// ---------------------------------------------------------------------------
// Agent health mini-card — bottom of the sidebar.
// ---------------------------------------------------------------------------

function SidebarHealthCard({ status }: { status?: AgentStatusResponse }) {
  const budget = status?.budget;
  const pct =
    budget && budget.limits.dailyLlmTokens > 0
      ? Math.min(100, (budget.day.llmTokens / budget.limits.dailyLlmTokens) * 100)
      : 0;
  const killReason = status?.killSwitch?.reason;
  const running = status?.running && !status?.paused && !status?.emergencyStop;

  return (
    <div className="mx-3 mb-3 rounded-lg border border-border/60 bg-card/80 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          System Health
        </span>
        <span
          className={cn(
            "flex items-center gap-1.5 text-[10px] font-semibold",
            killReason
              ? "text-red-400"
              : running
                ? "text-emerald-400"
                : "text-amber-400"
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              killReason
                ? "bg-red-400"
                : running
                  ? "bg-emerald-400 pulse-dot"
                  : "bg-amber-400"
            )}
          />
          {killReason ? "HALTED" : running ? "ACTIVE" : "IDLE"}
        </span>
      </div>
      <div className="mt-2 space-y-1.5">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>LLM budget today</span>
          <span className="font-mono tabular-nums">
            {budget ? `${(budget.day.llmTokens / 1000).toFixed(1)}k / ${(budget.limits.dailyLlmTokens / 1000).toFixed(0)}k` : "—"}
          </span>
        </div>
        <div
          className="h-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Daily LLM budget usage"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={cn(
              "h-full rounded-full transition-all",
              pct > 85 ? "bg-red-400" : pct > 60 ? "bg-amber-400" : "bg-emerald-500"
            )}
            style={{ width: `${Math.max(pct, 2)}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>Cycles</span>
          <span className="font-mono tabular-nums">{status?.cycleCount ?? 0}</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The sidebar content (shared between fixed rail + mobile drawer)
// ---------------------------------------------------------------------------

interface SidebarContentProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  pendingApprovals: number;
  runningTasks: number;
  status?: AgentStatusResponse;
  onOpenPublic: () => void;
  onToggleTerminal: () => void;
}

export function SidebarContent({
  activeTab,
  onTabChange,
  pendingApprovals,
  runningTasks,
  status,
  onOpenPublic,
  onToggleTerminal,
}: SidebarContentProps) {
  const { theme, setTheme } = useTheme();

  const badgeFor = (id: TabId): number => {
    if (id === "approvals") return pendingApprovals;
    if (id === "tasks") return runningTasks;
    return 0;
  };

  return (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 pb-4 pt-5">
        <div className="relative size-8 shrink-0 overflow-hidden rounded-lg ring-1 ring-emerald-500/30">
          <Image
            src="/agent-logo.png"
            alt="CryptoEarn Agent logo"
            fill
            priority
            sizes="32px"
            className="object-cover"
          />
        </div>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-bold leading-tight tracking-tight">
            CryptoEarn
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            zero-cost earning agent
          </p>
        </div>
      </div>

      {/* Nav groups */}
      <nav
        className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-2.5 pb-2"
        aria-label="Dashboard sections"
      >
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="nav-group-label mb-1">{group.label}</p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const badge = badgeFor(item.id);
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="nav-item tap-target"
                      data-active={active}
                      onClick={() => onTabChange(item.id)}
                      aria-current={active ? "page" : undefined}
                    >
                      <Icon className="size-4 shrink-0 opacity-80" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {badge > 0 && (
                        <span
                          className={cn(
                            "nav-badge",
                            item.id === "approvals" && "nav-badge--attention"
                          )}
                          aria-label={`${badge} items need attention`}
                        >
                          {badge > 99 ? "99+" : badge}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        {/* Terminal — operator utility, always available */}
        <div>
          <p className="nav-group-label mb-1">Tools</p>
          <ul className="space-y-0.5">
            <li>
              <button
                type="button"
                className="nav-item tap-target"
                onClick={onToggleTerminal}
                aria-label="Open terminal"
                title="Open the operator terminal (Ctrl+Shift+T)"
              >
                <TerminalIcon className="size-4 shrink-0 opacity-80" />
                <span className="flex-1 truncate">Terminal</span>
                <kbd className="hidden rounded border border-border/60 bg-muted/60 px-1 py-px font-mono text-[9px] text-muted-foreground lg:inline">
                  ⇧T
                </kbd>
              </button>
            </li>
          </ul>
        </div>
      </nav>

      {/* Health + footer controls */}
      <SidebarHealthCard status={status} />

      <div className="flex items-center justify-between border-t border-border/50 px-3 py-2.5">
        <button
          type="button"
          onClick={onOpenPublic}
          className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-ring"
          aria-label="Open public read-only dashboard in a new tab"
          title="Shareable read-only view"
        >
          <ExternalLink className="size-3" />
          Public view
        </button>
        <button
          type="button"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-ring"
          aria-label="Toggle color theme"
        >
          <Sun className="size-3 dark:hidden" />
          <Moon className="hidden size-3 dark:block" />
          Theme
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop fixed rail
// ---------------------------------------------------------------------------

export function AppSidebar(props: SidebarContentProps) {
  return (
    <aside
      className="fixed inset-y-0 left-0 z-40 hidden w-[232px] flex-col border-r border-border/60 bg-sidebar lg:flex"
      aria-label="Sidebar navigation"
    >
      <SidebarContent {...props} />
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Mobile drawer (chat side panel / phone width)
// ---------------------------------------------------------------------------

export function MobileSidebarDrawer({
  open,
  onClose,
  ...props
}: SidebarContentProps & { open: boolean; onClose: () => void }) {
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation menu">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Panel */}
      <div className="drawer-anim absolute inset-y-0 left-0 w-[268px] max-w-[85vw] border-r border-border/60 bg-sidebar shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-2.5 top-3 flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring"
          aria-label="Close navigation menu"
        >
          <X className="size-4" />
        </button>
        <SidebarContent {...props} onTabChange={(t) => { props.onTabChange(t); onClose(); }} />
      </div>
    </div>
  );
}
