"use client";

// OnboardingTour — a lightweight, dismissible onboarding overlay for
// first-time dashboard users.
//
// v0.4.1 rewrite: the old tour described the pre-v2 layout (tab strip,
// "Overview" tab, footer stats) which no longer exists. The v2 shell uses a
// grouped sidebar + Daily Briefing + terminal drawer, so every step now
// matches what the operator actually sees. Also adds Esc-to-dismiss and a
// click-anywhere hint so the tour can never trap a fresh side-panel session.
//
// The tour is shown only once per browser (stored in localStorage). The
// user can dismiss it at any time (backdrop click, Esc, or Skip) and
// re-trigger it from the keyboard shortcuts help dialog (press `?` then
// click "Restart tour").

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronRight,
  ChevronLeft,
  X,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "cryptoearn-onboarding-completed";

interface TourStep {
  title: string;
  description: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    title: "Welcome to CryptoEarn Agent",
    description:
      "This is the operator dashboard for your autonomous zero-cost crypto-earning agent. It discovers opportunities, verifies and scores them, executes the safe ones, and confirms payment on-chain. Your daily check-in takes about a minute — here's where everything lives.",
  },
  {
    title: "Daily Briefing & Action Center",
    description:
      "The landing tab greets you with what changed since your last visit. The Action Center at the top collects everything that needs a decision — pending approvals, an idle agent, or stuck items — each with a one-click jump button. Below it: earnings, pipeline value, and Top Picks ranked by risk-adjusted hourly value.",
  },
  {
    title: "Sidebar Navigation",
    description:
      "The sidebar groups the dashboard by workflow: MONITOR (briefing, report, pipeline, event log), EARN (opportunities, approvals, tasks, ledger, wallets), ANALYZE (strategies, agent memory) and SYSTEM (model routing). The health card at the bottom tracks daily LLM budget and cycle count. On narrow panels the sidebar collapses into a drawer.",
  },
  {
    title: "Approvals & Autonomy",
    description:
      "Nothing executes without you at first: the agent runs in 'observe' mode and queues work on the Approvals tab. When you're ready to earn, approve a low-risk bounty and raise the autonomy mode (topbar) to 'assist' — the agent then submits the PR and monitors it through merge and payment.",
  },
  {
    title: "Terminal & Token Setup",
    description:
      "Open the terminal from the sidebar TOOLS group. Add your GitHub token with: echo 'GITHUB_TOKEN=your_token' >> .env — then use the Set Token button to verify. That single step unlocks real PR submission. The bell in the topbar shows recent notifications, and '?' opens keyboard shortcuts at any time.",
  },
];

export function OnboardingTour() {
  const [visible, setVisible] = React.useState(false);
  const [step, setStep] = React.useState(0);

  // Check localStorage on mount — show the tour only if not completed.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const completed = localStorage.getItem(STORAGE_KEY);
      if (!completed) {
        // Small delay so the dashboard loads first.
        const t = setTimeout(() => setVisible(true), 1500);
        return () => clearTimeout(t);
      }
    } catch {
      // localStorage might be blocked — skip the tour.
    }
  }, []);

  const dismiss = React.useCallback(() => {
    setVisible(false);
    try {
      localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      // ignore
    }
  }, []);

  // Esc dismisses the tour from any step (v0.4.1 — the tour previously
  // trapped keyboard users; Esc now always provides an exit).
  React.useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        dismiss();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, dismiss]);

  const next = React.useCallback(() => {
    if (step < TOUR_STEPS.length - 1) {
      setStep((s) => s + 1);
    } else {
      dismiss();
    }
  }, [step, dismiss]);

  const prev = React.useCallback(() => {
    if (step > 0) setStep((s) => s - 1);
  }, [step]);

  const restart = React.useCallback(() => {
    setStep(0);
    setVisible(true);
  }, []);

  // Expose a global restart function so the keyboard help dialog can trigger it.
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      (window as unknown as { __restartOnboarding?: () => void }).__restartOnboarding = restart;
    }
    return () => {
      if (typeof window !== "undefined") {
        delete (window as unknown as { __restartOnboarding?: () => void }).__restartOnboarding;
      }
    };
  }, [restart]);

  const current = TOUR_STEPS[step];
  const isLast = step === TOUR_STEPS.length - 1;

  return (
    <AnimatePresence>
      {visible && (
        <>
          {/* Backdrop — click to dismiss */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm"
            onClick={dismiss}
            aria-hidden
          />

          {/* Tour card */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="fixed left-1/2 top-1/2 z-[61] w-[90vw] max-w-md -translate-x-1/2 -translate-y-1/2"
            role="dialog"
            aria-modal="true"
            aria-label="Dashboard tour"
          >
            <div className="rounded-xl border border-border bg-card p-6 shadow-2xl">
              {/* Header */}
              <div className="mb-4 flex items-start justify-between">
                <div className="flex items-center gap-2">
                  {step === 0 ? (
                    <Sparkles className="size-5 text-emerald-500" />
                  ) : isLast ? (
                    <CheckCircle2 className="size-5 text-emerald-500" />
                  ) : (
                    <span className="flex size-6 items-center justify-center rounded-full bg-emerald-500/10 font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                      {step}
                    </span>
                  )}
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Step {step + 1} of {TOUR_STEPS.length}
                  </span>
                </div>
                <button
                  onClick={dismiss}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="Dismiss tour"
                >
                  <X className="size-4" />
                </button>
              </div>

              {/* Content */}
              <h3 className="mb-2 text-lg font-semibold">{current.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {current.description}
              </p>

              {/* Progress dots */}
              <div className="mt-5 flex items-center justify-center gap-1.5">
                {TOUR_STEPS.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setStep(i)}
                    className={`h-1.5 rounded-full transition-all ${
                      i === step
                        ? "w-6 bg-emerald-500"
                        : i < step
                        ? "w-1.5 bg-emerald-500/40"
                        : "w-1.5 bg-muted"
                    }`}
                    aria-label={`Go to step ${i + 1}`}
                  />
                ))}
              </div>

              {/* Actions */}
              <div className="mt-5 flex items-center justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={prev}
                  disabled={step === 0}
                  className="focus-ring"
                >
                  <ChevronLeft className="size-4" />
                  Back
                </Button>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={dismiss}
                    className="focus-ring"
                  >
                    Skip tour
                  </Button>
                  <Button
                    size="sm"
                    onClick={next}
                    className="focus-ring bg-emerald-600 text-white hover:bg-emerald-600/90"
                  >
                    {isLast ? (
                      <>
                        <CheckCircle2 className="size-4" />
                        Got it
                      </>
                    ) : (
                      <>
                        Next
                        <ChevronRight className="size-4" />
                      </>
                    )}
                  </Button>
                </div>
              </div>

              {/* Dismiss hint (v0.4.1) */}
              <p className="mt-4 text-center text-[10px] text-muted-foreground/70">
                Click anywhere outside this card or press Esc to leave the tour
              </p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
