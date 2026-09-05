"use client";

// CommandPalette — a Cmd+K command palette for quick navigation + actions.
//
// Phase-2 CRON-REVIEW-10: power-user feature inspired by Linear / Raycast.
// Opens with Cmd+K (Mac) or Ctrl+K (Windows/Linux). Provides fuzzy search
// over:
//   - Tab navigation (Overview, Opportunities, Wallets, ...)
//   - Agent actions (Run Cycle, Pause, Resume, Emergency Stop, Public View)
//   - Toggle actions (Focus Mode, Theme, Help)
//   - Data export (Ledger CSV/JSON, Opportunities CSV/JSON)
//
// Uses the `cmdk` library (already installed) + the shadcn/ui Command component.

import * as React from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Activity,
  Pause,
  Play,
  Square,
  ExternalLink,
  Maximize2,
  Keyboard,
  Download,
  FileJson,
  FileSpreadsheet,
  LayoutDashboard,
  Target,
  Wallet,
  Server,
  Trophy,
  BookOpen,
  CheckSquare,
  ListChecks,
  ScrollText,
  Brain,
  Network,
  CheckCircle2,
  XCircle,
  SkipForward,
  KeyRound,
  Terminal as TerminalIcon,
} from "lucide-react";
import type { AutonomyMode } from "@/lib/agent/types";
import { useAgentActions } from "./use-agent-actions";
import { useFocusMode } from "./focus-mode";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTabSelect: (tab: string) => void;
  onToggleHelp: () => void;
  onOpenPublic: () => void;
  /** v0.4.6: toggle the docked operator terminal drawer. */
  onToggleTerminal?: () => void;
  /** v0.4.6: open the terminal with the GITHUB_TOKEN connect flow
   *  (pre-filled echo command) — the top operator-blocked priority. */
  onConnectGithub?: () => void;
  /** Phase-3 DEV-REVIEW-8 (#4): bulk-action callbacks. When provided,
   *  the palette shows "Approve/Reject/Skip all selected" commands.
   *  Null when no approvals are selected (commands hidden). */
  onBulkApprove?: (() => void) | null;
  onBulkReject?: (() => void) | null;
  onBulkSkip?: (() => void) | null;
}

const TAB_ITEMS = [
  { value: "overview", label: "Overview", icon: LayoutDashboard, description: "KPIs + charts + top opportunities" },
  { value: "opportunities", label: "Opportunities", icon: Target, description: "Discovery pipeline" },
  { value: "wallets", label: "Wallets", icon: Wallet, description: "5 monitored chains" },
  { value: "models", label: "Model Routing", icon: Server, description: "9 providers + circuit breakers" },
  { value: "strategies", label: "Strategies", icon: Trophy, description: "Learning statistics" },
  { value: "ledger", label: "Ledger", icon: BookOpen, description: "Verified vs expected earnings" },
  { value: "approvals", label: "Approvals", icon: CheckSquare, description: "Pending human approvals" },
  { value: "tasks", label: "Tasks", icon: ListChecks, description: "Specialist handoffs" },
  { value: "events", label: "Events", icon: ScrollText, description: "Live audit log" },
  { value: "memory", label: "Memory", icon: Brain, description: "Cross-cycle lessons" },
  { value: "architecture", label: "Architecture", icon: Network, description: "System design" },
];

const EXPORT_ITEMS = [
  { label: "Export Ledger as CSV", icon: FileSpreadsheet, url: "/api/ledger?limit=1000&format=csv", description: "Download verified + expected earnings" },
  { label: "Export Ledger as JSON", icon: FileJson, url: "/api/ledger?limit=1000", description: "Raw JSON format" },
  { label: "Export Opportunities as CSV", icon: FileSpreadsheet, url: "/api/opportunities?limit=1000&format=csv", description: "All discovered opportunities" },
  { label: "Export Opportunities as JSON", icon: FileJson, url: "/api/opportunities?limit=1000", description: "Raw JSON format" },
  { label: "Export Events as JSON", icon: FileJson, url: "/api/events?limit=1000", description: "Recent agent events" },
  { label: "Export Memory as JSON", icon: FileJson, url: "/api/memory?limit=200", description: "All agent memories" },
];

export function CommandPalette({
  open,
  onOpenChange,
  onTabSelect,
  onToggleHelp,
  onOpenPublic,
  onToggleTerminal,
  onConnectGithub,
  onBulkApprove,
  onBulkReject,
  onBulkSkip,
}: CommandPaletteProps) {
  const actions = useAgentActions();
  const { toggle: toggleFocus } = useFocusMode();

  const handleTabSelect = (tab: string) => {
    onTabSelect(tab);
    onOpenChange(false);
  };

  const handleAction = (action: () => void) => {
    action();
    onOpenChange(false);
  };

  const handleExport = (url: string) => {
    // Open the export URL in a new tab — the API returns JSON which the
    // browser will download or display. For CSV, we'd need a dedicated
    // endpoint; for now, JSON exports work + the user can convert.
    window.open(url, "_blank");
    onOpenChange(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {/* Tab navigation */}
        <CommandGroup heading="Navigate">
          {TAB_ITEMS.map((item) => (
            <CommandItem
              key={item.value}
              value={`navigate ${item.label} ${item.description}`}
              onSelect={() => handleTabSelect(item.value)}
              className="cursor-pointer"
            >
              <item.icon className="mr-2 size-4 text-muted-foreground" />
              <div className="flex flex-1 items-center justify-between">
                <span>{item.label}</span>
                <span className="text-[10px] text-muted-foreground">{item.description}</span>
              </div>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        {/* Agent actions */}
        <CommandGroup heading="Actions">
          <CommandItem
            value="run cycle trigger autonomous"
            onSelect={() => handleAction(actions.runCycle)}
            className="cursor-pointer"
          >
            <Play className="mr-2 size-4 text-emerald-500" />
            <span>Run One Cycle</span>
            <kbd className="ml-auto text-[10px] text-muted-foreground">R</kbd>
          </CommandItem>
          <CommandItem
            value="pause agent halt"
            onSelect={() => handleAction(actions.pause)}
            className="cursor-pointer"
          >
            <Pause className="mr-2 size-4 text-amber-500" />
            <span>Pause Agent</span>
          </CommandItem>
          <CommandItem
            value="resume agent continue"
            onSelect={() => handleAction(actions.resume)}
            className="cursor-pointer"
          >
            <Play className="mr-2 size-4 text-emerald-500" />
            <span>Resume Agent</span>
          </CommandItem>
          <CommandItem
            value="emergency stop kill halt"
            onSelect={() => handleAction(() => actions.emergencyStop("command palette"))}
            className="cursor-pointer"
          >
            <Square className="mr-2 size-4 text-red-500" />
            <span>Emergency Stop</span>
          </CommandItem>
          <CommandItem
            value="focus mode distraction free fullscreen"
            onSelect={() => handleAction(toggleFocus)}
            className="cursor-pointer"
          >
            <Maximize2 className="mr-2 size-4 text-sky-500" />
            <span>Toggle Focus Mode</span>
            <kbd className="ml-auto text-[10px] text-muted-foreground">F</kbd>
          </CommandItem>
          {onToggleTerminal ? (
            <CommandItem
              value="terminal console operator commands shell"
              onSelect={() => handleAction(onToggleTerminal)}
              className="cursor-pointer"
            >
              <TerminalIcon className="mr-2 size-4 text-emerald-500" />
              <span>Toggle Operator Terminal</span>
              <kbd className="ml-auto text-[10px] text-muted-foreground">Ctrl+Shift+T</kbd>
            </CommandItem>
          ) : null}
          {onConnectGithub ? (
            <CommandItem
              value="connect github token pr submission unlock approve"
              onSelect={() => handleAction(onConnectGithub)}
              className="cursor-pointer"
            >
              <KeyRound className="mr-2 size-4 text-amber-500" />
              <div className="flex flex-1 items-center justify-between">
                <span>Connect GitHub</span>
                <span className="text-[10px] text-muted-foreground">Set GITHUB_TOKEN · unlock PR submission</span>
              </div>
            </CommandItem>
          ) : null}
          <CommandItem
            value="public view read only share"
            onSelect={() => handleAction(onOpenPublic)}
            className="cursor-pointer"
          >
            <ExternalLink className="mr-2 size-4 text-teal-500" />
            <span>Open Public Dashboard</span>
            <kbd className="ml-auto text-[10px] text-muted-foreground">P</kbd>
          </CommandItem>
          <CommandItem
            value="keyboard shortcuts help"
            onSelect={() => handleAction(onToggleHelp)}
            className="cursor-pointer"
          >
            <Keyboard className="mr-2 size-4 text-purple-500" />
            <span>Keyboard Shortcuts Help</span>
            <kbd className="ml-auto text-[10px] text-muted-foreground">?</kbd>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* Phase-3 DEV-REVIEW-8 (#4): bulk-approval actions. Only shown
            when at least one approval is selected (the callbacks are
            non-null). Lets the operator type "approve all" in the palette. */}
        {(onBulkApprove || onBulkReject || onBulkSkip) ? (
          <CommandGroup heading="Bulk Approvals">
            {onBulkApprove ? (
              <CommandItem
                value="approve all selected approvals bulk"
                onSelect={() => handleAction(onBulkApprove)}
                className="cursor-pointer"
              >
                <CheckCircle2 className="mr-2 size-4 text-emerald-500" />
                <span>Approve All Selected</span>
                <kbd className="ml-auto text-[10px] text-muted-foreground">Ctrl+Enter</kbd>
              </CommandItem>
            ) : null}
            {onBulkReject ? (
              <CommandItem
                value="reject all selected approvals bulk"
                onSelect={() => handleAction(onBulkReject)}
                className="cursor-pointer"
              >
                <XCircle className="mr-2 size-4 text-red-500" />
                <span>Reject All Selected</span>
                <kbd className="ml-auto text-[10px] text-muted-foreground">Ctrl+Backspace</kbd>
              </CommandItem>
            ) : null}
            {onBulkSkip ? (
              <CommandItem
                value="skip all selected approvals bulk"
                onSelect={() => handleAction(onBulkSkip)}
                className="cursor-pointer"
              >
                <SkipForward className="mr-2 size-4 text-amber-500" />
                <span>Skip All Selected</span>
                <kbd className="ml-auto text-[10px] text-muted-foreground">Ctrl+Shift+S</kbd>
              </CommandItem>
            ) : null}
          </CommandGroup>
        ) : null}

        <CommandSeparator />

        {/* Data export */}
        <CommandGroup heading="Export Data">
          {EXPORT_ITEMS.map((item) => (
            <CommandItem
              key={item.label}
              value={`export download ${item.label.toLowerCase()} ${item.description.toLowerCase()}`}
              onSelect={() => handleExport(item.url)}
              className="cursor-pointer"
            >
              <item.icon className="mr-2 size-4 text-muted-foreground" />
              <div className="flex flex-1 items-center justify-between">
                <span>{item.label}</span>
                <span className="text-[10px] text-muted-foreground">{item.description}</span>
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
