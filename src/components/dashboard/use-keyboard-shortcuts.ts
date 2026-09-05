"use client";

// useKeyboardShortcuts — a React hook for global dashboard keyboard shortcuts.
//
// Phase-2 polish: power-user keyboard shortcuts for the dashboard.
//
// Shortcuts (only active when not typing in an input/textarea/select):
//   1-9       → switch to tab N (1=Overview, 2=Opportunities, ... 9=Architecture)
//   0         → switch to the 10th tab (Memory)
//   L         → toggle Live mode on the current Events/Tasks tab
//   P         → open the public read-only dashboard in a new tab
//   R         → run one cycle (same as the Run Cycle button)
//   ?         → show/hide the shortcuts help dialog
//   Escape    → close any open dialog

import * as React from "react";

export interface KeyboardShortcut {
  key: string;
  description: string;
  action: () => void;
}

export interface UseKeyboardShortcutsOpts {
  onTabSelect?: (index: number) => void;
  onToggleLive?: () => void;
  onOpenPublic?: () => void;
  onRunCycle?: () => void;
  onToggleHelp?: () => void;
  onToggleFocus?: () => void;
  /** Phase-3 DEV-REVIEW-7 (#5): bulk-action shortcuts. Only fired when
   *  the Approvals tab is active + at least 1 row is selected. */
  onBulkApprove?: () => void;
  onBulkReject?: () => void;
  onBulkSkip?: () => void;
  enabled?: boolean;
}

export function useKeyboardShortcuts(opts: UseKeyboardShortcutsOpts) {
  const {
    onTabSelect,
    onToggleLive,
    onOpenPublic,
    onRunCycle,
    onToggleHelp,
    onToggleFocus,
    onBulkApprove,
    onBulkReject,
    onBulkSkip,
    enabled = true,
  } = opts;

  React.useEffect(() => {
    if (!enabled) return;

    const handler = (e: KeyboardEvent) => {
      // Don't intercept when the user is typing in an input/textarea/select.
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }

      // Phase-3 DEV-REVIEW-7 (#5): bulk-action shortcuts.
      // Ctrl+Enter → approve all selected (Approvals tab).
      // Ctrl+Backspace → reject all selected (Approvals tab).
      // Ctrl+Shift+S → skip all selected (Approvals tab).
      // These fire BEFORE the modifier-key bail below because they
      // require Ctrl/Cmd.
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key === "Enter" && onBulkApprove) {
          e.preventDefault();
          onBulkApprove();
          return;
        }
        if (e.key === "Backspace" && onBulkReject) {
          e.preventDefault();
          onBulkReject();
          return;
        }
        if (e.key.toLowerCase() === "s" && e.shiftKey && onBulkSkip) {
          e.preventDefault();
          onBulkSkip();
          return;
        }
      }

      // Don't intercept other modifier-key combos (Ctrl+C, Cmd+R, etc.).
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const key = e.key.toLowerCase();

      // Tab selection: 1-9, 0.
      if (/^[0-9]$/.test(key)) {
        const index = key === "0" ? 9 : parseInt(key, 10) - 1;
        if (onTabSelect && index >= 0 && index < 11) {
          e.preventDefault();
          onTabSelect(index);
        }
        return;
      }

      switch (key) {
        case "l":
          if (onToggleLive) {
            e.preventDefault();
            onToggleLive();
          }
          break;
        case "p":
          if (onOpenPublic) {
            e.preventDefault();
            onOpenPublic();
          }
          break;
        case "f":
          if (onToggleFocus) {
            e.preventDefault();
            onToggleFocus();
          }
          break;
        case "r":
          if (onRunCycle) {
            e.preventDefault();
            onRunCycle();
          }
          break;
        case "?":
          if (onToggleHelp) {
            e.preventDefault();
            onToggleHelp();
          }
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, onTabSelect, onToggleLive, onOpenPublic, onRunCycle, onToggleHelp, onToggleFocus, onBulkApprove, onBulkReject, onBulkSkip]);
}

// The list of shortcuts for the help dialog.
export const SHORTCUTS_HELP: Array<{ key: string; description: string }> = [
  { key: "1-9, 0", description: "Switch to tab N (1=Overview … 0=Memory)" },
  { key: "L", description: "Toggle Live mode (Events/Tasks tabs)" },
  { key: "P", description: "Open public read-only dashboard" },
  { key: "F", description: "Toggle focus mode (hide header/footer)" },
  { key: "R", description: "Run one autonomous cycle" },
  { key: "?", description: "Show/hide this help dialog" },
  // Phase-3 DEV-REVIEW-7 (#5): bulk-action shortcuts.
  { key: "Ctrl+Enter", description: "Approve all selected approvals (Approvals tab)" },
  { key: "Ctrl+Backspace", description: "Reject all selected approvals (Approvals tab)" },
  { key: "Ctrl+Shift+S", description: "Skip all selected approvals (Approvals tab)" },
];
