"use client";

// PageClient v2 — the shell orchestrator.
//
// Layout: fixed sidebar rail (desktop) / drawer (narrow) + compact topbar +
// scrollable content area + docked terminal drawer + sticky footer.
//
// What changed vs v1 (driven by the operator's dissatisfaction + VLM audit):
//   - 13 horizontal tabs → grouped sidebar navigation (intent-based groups)
//   - 3 stacked banners → ONE action center inside the Daily Briefing
//   - Brand + controls + budget "3-headers-in-1" → brand in sidebar, controls
//     in topbar, budget in sidebar health card
//   - Floating stats bar / floating bell FAB / floating terminal FAB →
//     integrated into topbar + sidebar + docked terminal drawer
//   - The chat-side-panel use case (narrow viewport) gets a real drawer nav

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Keyboard, RotateCcw, Bell, Sparkles } from "lucide-react";
import { Header as LegacyHeader } from "./header"; // kept for focus mode
import { Footer } from "./footer";
import { ThemeProvider } from "./theme-provider";
import { QueryProvider } from "./query-provider";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { OverviewTab } from "./tabs-overview";
import { OpportunitiesTab } from "./tabs-opportunities";
import { LifecycleTab } from "./tabs-lifecycle";
import { WalletsTab } from "./tabs-wallets";
import { ModelRoutingTab } from "./tabs-model-routing";
import { StrategiesTab } from "./tabs-strategies";
import { LedgerTab } from "./tabs-ledger";
import { ApprovalsTab } from "./tabs-approvals";
import { TasksTab } from "./tabs-tasks";
import { EventsTab } from "./tabs-events";
import { ArchitectureTab } from "./tabs-architecture";
import { OpportunityDetailSheet } from "./opportunity-detail-sheet";
import { PublicDashboard } from "./public-dashboard";
import { MemoryTab } from "./tabs-memory";
import { AppSidebar, MobileSidebarDrawer, type TabId } from "./shell/sidebar";
import { Topbar } from "./shell/topbar";
import { TerminalDrawer } from "./shell/terminal-drawer";
import {
  useKeyboardShortcuts,
  SHORTCUTS_HELP,
} from "./use-keyboard-shortcuts";
import { useAgentActions } from "./use-agent-actions";
import { MobileQuickActions } from "./mobile-quick-actions";
import { OnboardingTour } from "./onboarding-tour";
import {
  FocusModeProvider,
  useFocusMode,
  FocusModeExitButton,
} from "./focus-mode";
import { useBrowserNotifications } from "./use-browser-notifications";
import { QuickStatsWidget } from "./quick-stats-widget";
import { NotificationHistory } from "./notification-history";
import { CommandPalette } from "./command-palette";
import { DailyReportSection } from "./daily-report";
import { api } from "./lib/api";
import type { OpportunityStatus } from "@/lib/agent/types";

// The ordered tab list — indexed by keyboard shortcuts (1-9, 0, -).
export const TABS = [
  { value: "overview", label: "Daily Briefing" },
  { value: "opportunities", label: "Opportunities" },
  { value: "lifecycle", label: "Pipeline" },
  { value: "wallets", label: "Wallets" },
  { value: "models", label: "Model Routing" },
  { value: "strategies", label: "Strategies" },
  { value: "ledger", label: "Earnings Ledger" },
  { value: "approvals", label: "Approvals" },
  { value: "tasks", label: "Tasks" },
  { value: "events", label: "Event Log" },
  { value: "daily", label: "Daily Report" },
  { value: "memory", label: "Agent Memory" },
  { value: "architecture", label: "Architecture" },
] as const;

type TabValue = TabId;

export default function PageClient() {
  // Public read-only view toggle — driven by `?view=public` URL param.
  const [publicView, setPublicView] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    setPublicView(params.get("view") === "public");
  }, []);

  const exitToOperator = React.useCallback(() => {
    setPublicView(false);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("view");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  // Public read-only view — render the shareable summary + skip the operator UI.
  if (publicView) {
    return (
      <ThemeProvider>
        <QueryProvider>
          <div className="flex min-h-screen flex-col bg-background text-foreground" suppressHydrationWarning>
            <main
              className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-4 sm:py-6"
              aria-label="Public dashboard"
            >
              <PublicDashboard onExitToOperator={exitToOperator} />
            </main>
            <SonnerToaster richColors position="bottom-right" />
          </div>
        </QueryProvider>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <QueryProvider>
        <FocusModeProvider>
          <OperatorDashboard />
        </FocusModeProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}

/**
 * OperatorDashboard — owns the tab state, keyboard shortcuts, agent actions,
 * + all the dialog/sheet state. Lives INSIDE ThemeProvider + QueryProvider.
 */
function OperatorDashboard() {
  const [tab, setTab] = React.useState<TabValue>("overview");
  const [opportunityId, setOpportunityId] = React.useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);

  // Bulk-action handlers ref (ApprovalsTab populates; shortcuts + palette read).
  const bulkActionHandlersRef = React.useRef<{
    approve: (() => void) | null;
    reject: (() => void) | null;
    skip: (() => void) | null;
  }>({ approve: null, reject: null, skip: null });

  // Lifecycle → Opportunities pre-filter status.
  const [pendingStatusFilter, setPendingStatusFilter] = React.useState<
    OpportunityStatus | null
  >(null);

  // v0.4.3: briefing Action Center → Opportunities closing-soon filter.
  const [pendingClosingSoon, setPendingClosingSoon] =
    React.useState(false);

  // v0.4.5: deep-link state — `?tab=` / `?status=` / `?closingSoon=1` /
  // `?watchlist=1` make any filter view bookmarkable (e.g. the operator's
  // morning triage link). Read once on mount, then kept in sync below.
  const [pendingWatchlist, setPendingWatchlist] = React.useState(false);

  // v0.4.6: `?q=` keyword search deep-link (null = no intent yet — the tab
  // owns the empty default until it reports a filter change upward).
  const [pendingSearch, setPendingSearch] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get("tab");
    if (tabParam && TABS.some((t) => t.value === tabParam)) {
      setTab(tabParam as TabValue);
    }
    const statusParam = params.get("status");
    if (statusParam) setPendingStatusFilter(statusParam as OpportunityStatus);
    setPendingClosingSoon(params.get("closingSoon") === "1");
    setPendingWatchlist(params.get("watchlist") === "1");
    const qParam = params.get("q");
    if (qParam) setPendingSearch(qParam);
  }, []);

  // v0.4.5: URL sync — replaceState (no history spam) whenever the
  // deep-linkable state changes. Params describe opportunity-filter intent
  // and persist across tab switches, mirroring the internal state.
  // The first run is skipped so the mount-read effect above can settle the
  // state from the URL before we rewrite it (avoids a params flash).
  const urlSyncedOnce = React.useRef(false);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (!urlSyncedOnce.current) {
      urlSyncedOnce.current = true;
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("tab");
    url.searchParams.delete("status");
    url.searchParams.delete("closingSoon");
    url.searchParams.delete("watchlist");
    url.searchParams.delete("q");
    if (tab !== "overview") url.searchParams.set("tab", tab);
    if (pendingStatusFilter) url.searchParams.set("status", pendingStatusFilter);
    if (pendingClosingSoon) url.searchParams.set("closingSoon", "1");
    if (pendingWatchlist) url.searchParams.set("watchlist", "1");
    if (pendingSearch) url.searchParams.set("q", pendingSearch);
    window.history.replaceState({}, "", url.toString());
  }, [tab, pendingStatusFilter, pendingClosingSoon, pendingWatchlist, pendingSearch]);

  // v0.4.5: OpportunitiesTab reports local filter changes back here so the
  // URL (and remounts after tab switches) always honor the operator's last
  // choice instead of a stale navigation intent.
  // v0.4.6: search keywords are debounced into `pendingSearch` (400ms) so
  // per-keystroke reports don't thrash replaceState; clearing applies on the
  // same debounced schedule.
  const searchDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);
  const handleFiltersChange = React.useCallback(
    (filters: {
      status: string | null;
      closingSoon: boolean;
      watchlist: boolean;
      search: string;
    }) => {
      setPendingStatusFilter((filters.status as OpportunityStatus | null) ?? null);
      setPendingClosingSoon(filters.closingSoon);
      setPendingWatchlist(filters.watchlist);
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      const q = filters.search.trim();
      searchDebounceRef.current = setTimeout(() => {
        setPendingSearch((prev) => (q ? q : prev === null ? null : ""));
      }, 400);
    },
    []
  );

  const openOpportunity = React.useCallback((id: string) => {
    setOpportunityId(id);
    setSheetOpen(true);
  }, []);

  // Keyboard shortcuts help dialog.
  const [helpOpen, setHelpOpen] = React.useState(false);

  // Notification history panel.
  const [notifHistoryOpen, setNotifHistoryOpen] = React.useState(false);

  // Command palette (Cmd+K / Ctrl+K).
  const [commandPaletteOpen, setCommandPaletteOpen] = React.useState(false);

  // Terminal drawer (Ctrl+Shift+T).
  const [terminalOpen, setTerminalOpen] = React.useState(false);

  // v0.4.6: terminal "connect GitHub" intent — set when the operator opens
  // the drawer from the Action Center / command palette Connect CTA. The
  // terminal pre-fills the token echo command + focuses the input; the intent
  // is cleared when the drawer closes.
  const [terminalTokenFocus, setTerminalTokenFocus] = React.useState(false);
  const toggleTerminal = React.useCallback(() => {
    setTerminalTokenFocus(false);
    setTerminalOpen((v) => !v);
  }, []);
  const openTerminalWithTokenFlow = React.useCallback(() => {
    setTerminalTokenFocus(true);
    setTerminalOpen(true);
  }, []);

  // Mobile sidebar drawer.
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  const handleTabSelect = React.useCallback((index: number) => {
    if (index >= 0 && index < TABS.length) {
      setTab(TABS[index].value as TabValue);
    }
  }, []);

  const handleOpenPublic = React.useCallback(() => {
    if (typeof window !== "undefined") {
      window.open("?view=public", "_blank");
    }
  }, []);

  const handleNavigate = React.useCallback(
    (
      target: string,
      statusFilter?: string,
      opts?: { closingSoon?: boolean }
    ) => {
      if (statusFilter) {
        setPendingStatusFilter(statusFilter as OpportunityStatus);
      } else {
        setPendingStatusFilter(null);
      }
      if (opts?.closingSoon) {
        setPendingClosingSoon(true);
      } else {
        setPendingClosingSoon(false);
      }
      setTab(target as TabValue);
    },
    []
  );

  // Shared agent actions — used by the shortcut `R` + briefing CTA.
  const actions = useAgentActions();
  const qc = useQueryClient();

  const runCycle = React.useCallback(() => {
    api.agent
      .runCycle(1, 500)
      .then((res) => {
        toast.success(`Cycle ${res.count} completed.`);
        qc.invalidateQueries();
      })
      .catch((e) => toast.error(`Run cycle failed: ${e.message}`));
  }, [qc]);

  // Focus mode — hides header/footer for distraction-free monitoring.
  const { isFocusMode, toggle: toggleFocus } = useFocusMode();

  // Browser notifications — watches for terminal-state events.
  useBrowserNotifications();

  // Sidebar data — status + indicator counts.
  const { data: status } = useQuery({
    queryKey: ["agent-status"],
    queryFn: () => api.agent.status(),
    refetchInterval: 10_000,
  });

  const { data: pendingApprovals } = useQuery({
    queryKey: ["approvals", "pending-count"],
    queryFn: () => api.approvals.list({ status: "pending", limit: 1 }),
    refetchInterval: 15_000,
  });
  const pendingApprovalsCount =
    pendingApprovals?.count ?? pendingApprovals?.approvals?.length ?? 0;

  const { data: runningTasks } = useQuery({
    queryKey: ["tasks", "running-count"],
    queryFn: () => api.tasks.list({ status: "running", limit: 1 }),
    refetchInterval: 15_000,
  });
  const runningTasksCount = runningTasks?.count ?? runningTasks?.tasks?.length ?? 0;

  // Unread notifications count for the topbar bell.
  const [unreadNotifs, setUnreadNotifs] = React.useState(0);
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem("cryptoearn-notifications");
      if (raw) {
        const list = JSON.parse(raw) as Array<{ read?: boolean }>;
        setUnreadNotifs(list.filter((n) => !n.read).length);
      }
    } catch {
      // ignore
    }
  }, [notifHistoryOpen]);

  useKeyboardShortcuts({
    onTabSelect: handleTabSelect,
    onOpenPublic: handleOpenPublic,
    onRunCycle: actions.runCycle,
    onToggleHelp: () => setHelpOpen((v) => !v),
    onToggleFocus: toggleFocus,
    onBulkApprove:
      tab === "approvals"
        ? () => bulkActionHandlersRef.current.approve?.()
        : undefined,
    onBulkReject:
      tab === "approvals"
        ? () => bulkActionHandlersRef.current.reject?.()
        : undefined,
    onBulkSkip:
      tab === "approvals"
        ? () => bulkActionHandlersRef.current.skip?.()
        : undefined,
    enabled: true,
  });

  // Cmd+K / Ctrl+K → command palette. Ctrl+Shift+T → terminal drawer.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        toggleTerminal();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleTerminal]);

  const sidebarProps = {
    activeTab: tab,
    onTabChange: (t: TabId) => setTab(t),
    pendingApprovals: pendingApprovalsCount,
    runningTasks: runningTasksCount,
    status,
    onOpenPublic: handleOpenPublic,
    onToggleTerminal: toggleTerminal,
  };

  return (
    <div
      className="flex min-h-screen flex-col bg-background text-foreground"
      suppressHydrationWarning
    >
      {/* Desktop sidebar rail */}
      {!isFocusMode && <AppSidebar {...sidebarProps} />}

      {/* Mobile drawer nav */}
      {!isFocusMode && (
        <MobileSidebarDrawer
          {...sidebarProps}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
      )}

      {/* Main column — offset by the sidebar width on desktop */}
      <div className="flex min-h-screen flex-col lg:ml-[232px]">
        {!isFocusMode && (
          <Topbar
            activeTab={tab}
            status={status}
            onOpenSidebar={() => setSidebarOpen(true)}
            onOpenNotifications={() => setNotifHistoryOpen(true)}
            onOpenHelp={() => setHelpOpen(true)}
            pendingNotifications={unreadNotifs}
          />
        )}

        {isFocusMode && <LegacyHeader />}

        <main
          className="mx-auto w-full max-w-[1200px] flex-1 px-3 pb-24 pt-4 sm:px-5 md:pb-5"
          aria-label="Dashboard main"
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              {tab === "overview" && (
                <OverviewTab
                  onOpenOpportunity={openOpportunity}
                  onNavigate={handleNavigate}
                  onRunCycle={runCycle}
                  onOpenTerminal={openTerminalWithTokenFlow}
                />
              )}
              {tab === "opportunities" && (
                <OpportunitiesTab
                  onOpenOpportunity={openOpportunity}
                  initialStatus={pendingStatusFilter ?? undefined}
                  initialClosingSoon={pendingClosingSoon || undefined}
                  initialWatchlist={pendingWatchlist || undefined}
                  initialSearch={pendingSearch ?? undefined}
                  onFiltersChange={handleFiltersChange}
                />
              )}
              {tab === "lifecycle" && (
                <LifecycleTab
                  onSelectStatus={(s) => handleNavigate("opportunities", s)}
                />
              )}
              {tab === "wallets" && <WalletsTab />}
              {tab === "models" && <ModelRoutingTab />}
              {tab === "strategies" && <StrategiesTab />}
              {tab === "ledger" && <LedgerTab />}
              {tab === "approvals" && (
                <ApprovalsTab bulkActionHandlersRef={bulkActionHandlersRef} />
              )}
              {tab === "tasks" && <TasksTab />}
              {tab === "events" && <EventsTab />}
              {tab === "memory" && <MemoryTab />}
              {tab === "daily" && <DailyReportSection />}
              {tab === "architecture" && <ArchitectureTab />}
            </motion.div>
          </AnimatePresence>
        </main>

        <Footer />
      </div>

      {/* Shared opportunity detail sheet */}
      <OpportunityDetailSheet
        opportunityId={opportunityId}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />

      {/* Keyboard shortcuts help dialog */}
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Keyboard className="size-4 text-emerald-500" />
              Keyboard Shortcuts
            </DialogTitle>
            <DialogDescription>
              Power-user shortcuts. Disabled when typing in inputs.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {SHORTCUTS_HELP.map((s) => (
              <div
                key={s.key}
                className="flex items-center justify-between rounded-md border border-border/40 px-3 py-2"
              >
                <span className="text-sm text-muted-foreground">
                  {s.description}
                </span>
                <kbd className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-xs font-medium">
                  {s.key}
                </kbd>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
            <Badge variant="outline" className="text-[10px]">
              Tip
            </Badge>
            <span>
              Press <kbd className="font-mono">?</kbd> anywhere to toggle
              this dialog.
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-[11px] text-muted-foreground"
              onClick={() => {
                try {
                  localStorage.removeItem("cryptoearn-skip-bulk-confirmation");
                } catch {
                  // ignore
                }
                setHelpOpen(false);
                toast.success("Bulk-action confirmations re-enabled.");
              }}
              title="Re-enable the confirmation dialog for bulk reject / pause actions"
            >
              <RotateCcw className="size-3" />
              Reset bulk confirmations
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-[11px] text-muted-foreground"
              onClick={() => {
                try {
                  const current = localStorage.getItem("cryptoearn-notification-sound");
                  const next = current === "false" ? "true" : "false";
                  localStorage.setItem("cryptoearn-notification-sound", next);
                  toast.success(
                    next === "false"
                      ? "Notification sounds muted."
                      : "Notification sounds enabled."
                  );
                } catch {
                  // ignore
                }
                setHelpOpen(false);
              }}
              title="Toggle the notification sound for terminal-state events"
            >
              <Bell className="size-3" />
              Toggle sound
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="focus-ring"
              onClick={() => {
                setHelpOpen(false);
                const w = window as unknown as {
                  __restartOnboarding?: () => void;
                };
                if (w.__restartOnboarding) {
                  w.__restartOnboarding();
                }
              }}
            >
              <Sparkles className="size-3" />
              Restart tour
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <SonnerToaster richColors position="bottom-right" />

      {/* Mobile Quick Actions FAB */}
      <MobileQuickActions />

      {/* Focus mode utilities */}
      <FocusModeExitButton />
      {isFocusMode && <QuickStatsWidget />}

      {/* Notification history panel */}
      <NotificationHistory
        visible={notifHistoryOpen}
        onClose={() => setNotifHistoryOpen(false)}
      />

      {/* Onboarding tour — first-time users */}
      <OnboardingTour />

      {/* Command palette (Cmd+K) */}
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        onTabSelect={(t) => setTab(t as TabValue)}
        onToggleHelp={() => setHelpOpen(true)}
        onOpenPublic={handleOpenPublic}
        onToggleTerminal={toggleTerminal}
        onConnectGithub={openTerminalWithTokenFlow}
        onBulkApprove={
          tab === "approvals"
            ? () => bulkActionHandlersRef.current.approve?.()
            : null
        }
        onBulkReject={
          tab === "approvals"
            ? () => bulkActionHandlersRef.current.reject?.()
            : null
        }
        onBulkSkip={
          tab === "approvals"
            ? () => bulkActionHandlersRef.current.skip?.()
            : null
        }
      />

      {/* Terminal drawer — docked to the bottom */}
      <TerminalDrawer
        open={terminalOpen}
        autoFocusToken={terminalTokenFocus}
        onClose={() => {
          setTerminalOpen(false);
          setTerminalTokenFocus(false);
        }}
      />
    </div>
  );
}
