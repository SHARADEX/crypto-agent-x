"use client";

// TerminalDrawer — the operator terminal as a bottom drawer (v2).
//
// The old design used a floating draggable panel with two floating FAB
// buttons that cluttered the right edge of the screen. The new design docks
// the terminal to the bottom of the viewport as a full-width drawer — same
// terminal panel component, cleaner chrome.
//
// Toggled via: sidebar Tools > Terminal, Ctrl+Shift+T, command palette.

import * as React from "react";
import { X, ChevronDown, Maximize2, Minimize2 } from "lucide-react";
import { TerminalPanel } from "../terminal/terminal-panel";
import { cn } from "@/lib/utils";

export function TerminalDrawer({
  open,
  onClose,
  autoFocusToken,
}: {
  open: boolean;
  onClose: () => void;
  /** v0.4.6: when true, the terminal pre-fills the GITHUB_TOKEN echo
   *  command + focuses the input (the "Connect GitHub" guided flow). */
  autoFocusToken?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(false);

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
    <div
      className={cn(
        "terminal-drawer drawer-anim fixed inset-x-0 bottom-0 z-50",
        expanded ? "inset-y-14" : "bottom-0 h-[420px]"
      )}
      role="complementary"
      aria-label="Operator terminal"
    >
      {/* Handle bar */}
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="flex size-2 items-center justify-center">
            <span className="size-2 rounded-full bg-emerald-500/70" />
          </span>
          <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
            OPERATOR TERMINAL
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-ring"
            aria-label={expanded ? "Collapse terminal" : "Expand terminal"}
            title={expanded ? "Collapse" : "Expand to full height"}
          >
            {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-ring"
            aria-label="Close terminal"
            title="Close (Esc)"
          >
            {expanded ? <X className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
        </div>
      </div>

      {/* Terminal body */}
      <div className="h-[calc(100%-33px)] overflow-hidden">
        <TerminalPanel autoFocusToken={autoFocusToken} />
      </div>
    </div>
  );
}
