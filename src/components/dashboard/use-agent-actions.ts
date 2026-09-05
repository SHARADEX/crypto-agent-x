"use client";

// useAgentActions — shared mutations for agent control (run cycle, pause,
// resume, emergency stop, autonomy mode).
//
// Phase-2 CRON-REVIEW-6: lifted these mutations out of the Header component
// into a shared hook so the keyboard shortcut `R` (Run Cycle) can trigger
// the same mutation without duplicating the logic. Both the Header and the
// PageClient's keyboard-shortcut handler use this hook.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "./lib/api";
import type { AutonomyMode } from "@/lib/agent/types";

export interface AgentActions {
  runCycle: () => void;
  runCyclePending: boolean;
  pause: () => void;
  pausePending: boolean;
  resume: () => void;
  resumePending: boolean;
  emergencyStop: (reason?: string) => void;
  emergencyStopPending: boolean;
  emergencyReset: () => void;
  emergencyResetPending: boolean;
  setAutonomy: (mode: AutonomyMode) => void;
  setAutonomyPending: boolean;
}

export function useAgentActions(): AgentActions {
  const qc = useQueryClient();

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
    onError: (e: Error) => toast.error(`Run cycle failed: ${e.message}`),
  });

  const pauseMut = useMutation({
    mutationFn: () => api.agent.pause("operator pause"),
    onSuccess: () => {
      toast.info("Agent paused.");
      qc.invalidateQueries({ queryKey: ["agent-status"] });
    },
    onError: (e: Error) => toast.error(`Pause failed: ${e.message}`),
  });

  const resumeMut = useMutation({
    mutationFn: () => api.agent.resume(),
    onSuccess: () => {
      toast.info("Agent resumed.");
      qc.invalidateQueries({ queryKey: ["agent-status"] });
    },
    onError: (e: Error) => toast.error(`Resume failed: ${e.message}`),
  });

  const emergencyStopMut = useMutation({
    mutationFn: (reason?: string) =>
      api.agent.emergencyStop(reason ?? "operator emergency stop"),
    onSuccess: () => {
      toast.error("Emergency stop engaged.");
      qc.invalidateQueries({ queryKey: ["agent-status"] });
    },
    onError: (e: Error) => toast.error(`Emergency stop failed: ${e.message}`),
  });

  const emergencyResetMut = useMutation({
    mutationFn: () => api.agent.emergencyReset(),
    onSuccess: () => {
      toast.success("Emergency stop cleared — agent can run again.");
      qc.invalidateQueries({ queryKey: ["agent-status"] });
    },
    onError: (e: Error) => toast.error(`Reset failed: ${e.message}`),
  });

  const autonomyMut = useMutation({
    mutationFn: (mode: AutonomyMode) => api.agent.autonomy(mode),
    onSuccess: () => {
      toast.info("Autonomy mode updated.");
      qc.invalidateQueries({ queryKey: ["agent-status"] });
    },
    onError: (e: Error) => toast.error(`Autonomy change failed: ${e.message}`),
  });

  return {
    runCycle: () => runCycleMut.mutate(),
    runCyclePending: runCycleMut.isPending,
    pause: () => pauseMut.mutate(),
    pausePending: pauseMut.isPending,
    resume: () => resumeMut.mutate(),
    resumePending: resumeMut.isPending,
    emergencyStop: (reason?: string) => emergencyStopMut.mutate(reason),
    emergencyStopPending: emergencyStopMut.isPending,
    emergencyReset: () => emergencyResetMut.mutate(),
    emergencyResetPending: emergencyResetMut.isPending,
    setAutonomy: (mode: AutonomyMode) => autonomyMut.mutate(mode),
    setAutonomyPending: autonomyMut.isPending,
  };
}
