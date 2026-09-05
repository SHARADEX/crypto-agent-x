"use client";

// MobileQuickActions — a floating action button (FAB) visible only on mobile
// (md:hidden). Provides quick access to Run Cycle, Pause/Resume, Emergency
// Stop, and Public View when the header buttons are hidden on small screens.
//
// Phase-2 CRON-REVIEW-6: the header's action buttons hide their labels on
// mobile (`hidden sm:inline`), and on very small screens the header can
// feel cramped. This FAB gives mobile users a clean, always-accessible
// menu of the most important actions.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus,
  Play,
  Pause,
  ExternalLink,
  X,
  Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";
import { useAgentActions } from "./use-agent-actions";
import { cn } from "@/lib/utils";

export function MobileQuickActions() {
  const [open, setOpen] = React.useState(false);
  const actions = useAgentActions();

  const { data: status } = useQuery({
    queryKey: ["agent-status"],
    queryFn: () => api.agent.status(),
    refetchInterval: 5_000,
  });

  const isPaused = !!status?.paused;
  const isStopped = !!status?.emergencyStop;
  const canRun = !!(status?.canRun?.canRun ?? status?.canRun?.allowed);

  const handleRunCycle = () => {
    actions.runCycle();
    setOpen(false);
  };

  const handlePauseResume = () => {
    if (isPaused) {
      actions.resume();
    } else {
      actions.pause();
    }
    setOpen(false);
  };

  const handlePublicView = () => {
    if (typeof window !== "undefined") {
      window.open("?view=public", "_blank");
    }
    setOpen(false);
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            size="lg"
            className="h-12 w-12 rounded-full bg-emerald-600 p-0 shadow-lg shadow-emerald-600/30 hover:bg-emerald-600/90 focus-ring"
            aria-label="Quick actions"
          >
            <motion.div
              animate={{ rotate: open ? 45 : 0 }}
              transition={{ duration: 0.2 }}
            >
              <Plus className="size-5" />
            </motion.div>
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Activity className="size-4 text-emerald-500" />
              Quick Actions
            </SheetTitle>
          </SheetHeader>
          <div className="grid grid-cols-2 gap-3 p-4 pb-8">
            <ActionButton
              icon={<Play className="size-5" />}
              label="Run Cycle"
              description="Trigger one autonomous cycle"
              onClick={handleRunCycle}
              disabled={actions.runCyclePending || !canRun}
              accent="emerald"
            />
            <ActionButton
              icon={isPaused ? <Play className="size-5" /> : <Pause className="size-5" />}
              label={isPaused ? "Resume" : "Pause"}
              description={isPaused ? "Resume the agent" : "Pause the agent"}
              onClick={handlePauseResume}
              disabled={
                isPaused
                  ? actions.resumePending
                  : actions.pausePending || isStopped
              }
              accent={isPaused ? "emerald" : "amber"}
            />
            <ActionButton
              icon={<ExternalLink className="size-5" />}
              label="Public View"
              description="Open read-only dashboard"
              onClick={handlePublicView}
              accent="teal"
            />
            <ActionButton
              icon={<X className="size-5" />}
              label={isStopped ? "Reset" : "Emergency Stop"}
              description={
                isStopped
                  ? "Clear emergency stop"
                  : "Halt all execution immediately"
              }
              onClick={() => {
                if (isStopped) {
                  actions.emergencyReset();
                } else {
                  actions.emergencyStop("mobile quick action");
                }
                setOpen(false);
              }}
              disabled={
                isStopped
                  ? actions.emergencyResetPending
                  : actions.emergencyStopPending
              }
              accent="red"
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

interface ActionButtonProps {
  icon: React.ReactNode;
  label: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
  accent: "emerald" | "amber" | "red" | "teal";
}

function ActionButton({
  icon,
  label,
  description,
  onClick,
  disabled,
  accent,
}: ActionButtonProps) {
  const ACCENT_BG: Record<string, string> = {
    emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    red: "bg-red-500/10 text-red-600 dark:text-red-400",
    teal: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "focus-ring flex flex-col items-center gap-2 rounded-xl border border-border/60 bg-card p-4 text-center transition-all",
        "hover:border-emerald-500/40 hover:shadow-md",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "active:scale-95"
      )}
    >
      <span
        className={cn(
          "flex size-10 items-center justify-center rounded-full",
          ACCENT_BG[accent]
        )}
      >
        {icon}
      </span>
      <span className="text-sm font-medium">{label}</span>
      <span className="text-[10px] text-muted-foreground">{description}</span>
    </button>
  );
}
