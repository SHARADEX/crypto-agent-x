"use client";

// ArchitectureTab — visual diagram of the multi-agent system. Pure HTML/CSS,
// no images. Three sections:
//   1. Lifecycle flow (DISCOVER → NORMALIZE → VERIFY → SCORE → PLAN →
//      APPROVAL → EXECUTE → VERIFY RESULT → VERIFY PAYMENT → RECORD → LEARN)
//   2. Specialist agents grid (11 agents + their responsibilities)
//   3. Model Router diagram (4 levels)

import * as React from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Bot,
  Brain,
  Code2,
  Coins,
  FileText,
  Lock,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  ShoppingCart,
  Network,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const LIFECYCLE_STAGES = [
  { name: "DISCOVER", icon: Search, color: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  { name: "NORMALIZE", icon: Settings2, color: "bg-teal-500/15 text-teal-700 dark:text-teal-300" },
  { name: "VERIFY", icon: ShieldCheck, color: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  { name: "SCORE", icon: Brain, color: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300" },
  { name: "PLAN", icon: Settings2, color: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300" },
  { name: "APPROVAL", icon: Lock, color: "bg-rose-500/15 text-rose-700 dark:text-rose-300" },
  { name: "EXECUTE", icon: Send, color: "bg-orange-500/15 text-orange-700 dark:text-orange-300" },
  { name: "VERIFY RESULT", icon: CheckCircle2, color: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  { name: "VERIFY PAYMENT", icon: Coins, color: "bg-lime-500/15 text-lime-700 dark:text-lime-300" },
  { name: "RECORD", icon: FileText, color: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  { name: "LEARN", icon: Brain, color: "bg-purple-500/15 text-purple-700 dark:text-purple-300" },
];

const AGENTS = [
  { name: "Scout", icon: Search, responsibility: "Discovers opportunities from configured sources (GitHub, mock, RSS, API).", accent: "emerald" },
  { name: "Research", icon: Search, responsibility: "Deep-dives into opportunity context, requirements, and competing entries.", accent: "violet" },
  { name: "Verification", icon: ShieldCheck, responsibility: "8-point verification pipeline (HTTPS, trusted host, org authenticity, etc.).", accent: "amber" },
  { name: "Economics", icon: Brain, responsibility: "Computes expected value, hourly return, and the unified score.", accent: "yellow" },
  { name: "Coding", icon: Code2, responsibility: "Generates code deliverables (PRs, fix branches, snippets) for bounty-style tasks.", accent: "rose" },
  { name: "Web3", icon: Network, responsibility: "Handles smart-contract submissions, ABI verification, and on-chain interactions.", accent: "purple" },
  { name: "Writing", icon: FileText, responsibility: "Produces docs, blog posts, and proposal copy for content-style tasks.", accent: "pink" },
  { name: "Security", icon: Lock, responsibility: "Ambiguity resolver + prompt-injection + code-safety reviewer.", accent: "red" },
  { name: "Execution", icon: Send, responsibility: "Idempotent submission wrapper around every external write.", accent: "orange" },
  { name: "Payment", icon: Coins, responsibility: "On-chain payment matcher for the expected-reward amount + currency.", accent: "lime" },
  { name: "Review", icon: CheckCircle2, responsibility: "Quality gate — uses a DIFFERENT model from the executor.", accent: "fuchsia" },
];

const ROUTER_LEVELS = [
  {
    level: 1,
    name: "Deterministic",
    description:
      "Pattern-matched to a fixed model. Used for low-complexity, well-understood tasks (e.g. normalization, scam detection).",
    examples: ["normalize", "scam-detect", "verify-https"],
  },
  {
    level: 2,
    name: "Cheap Classifier",
    description:
      "A small, fast LLM classifies the task type + complexity so the router can pick the right specialist.",
    examples: ["task_classifier"],
  },
  {
    level: 3,
    name: "Specialist",
    description:
      "Routes to the agent whose declared capabilities best match the required capabilities for this task.",
    examples: ["coding → groq", "writing → gemini", "research → openrouter"],
  },
  {
    level: 4,
    name: "Multi-model Panel",
    description:
      "High-risk / high-complexity tasks go to a panel of 2+ models with the review agent as the tiebreaker.",
    examples: ["security ambiguity", "high-value bounty"],
  },
];

export function ArchitectureTab() {
  return (
    <div className="space-y-6">
      {/* Lifecycle flow */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Opportunity Lifecycle</CardTitle>
          <CardDescription>
            The 11-stage pipeline every opportunity walks through, from
            discovery to learned lesson.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-stretch gap-2">
            {LIFECYCLE_STAGES.map((stage, idx) => {
              const Icon = stage.icon;
              return (
                <React.Fragment key={stage.name}>
                  <div
                    className={cn(
                      "flex min-w-[110px] flex-1 flex-col items-center gap-1 rounded-md border border-border/60 p-2 text-center",
                      "bg-card/40"
                    )}
                  >
                    <span
                      className={cn(
                        "rounded-md p-1.5",
                        stage.color
                      )}
                    >
                      <Icon className="size-4" />
                    </span>
                    <span className="text-[10px] font-semibold tracking-wide">
                      {stage.name}
                    </span>
                    <span className="text-[9px] text-muted-foreground tabular-nums">
                      {idx + 1}/11
                    </span>
                  </div>
                  {idx < LIFECYCLE_STAGES.length - 1 ? (
                    <div className="flex items-center self-center">
                      <ArrowRight className="size-3 text-muted-foreground" />
                    </div>
                  ) : null}
                </React.Fragment>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Specialist agents grid */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Specialist Agents</CardTitle>
          <CardDescription>
            11 specialist agents — each owns one slice of the lifecycle.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {AGENTS.map((a) => {
              const Icon = a.icon;
              return (
                <div
                  key={a.name}
                  className="flex items-start gap-3 rounded-md border border-border/60 bg-card/40 p-3"
                >
                  <span
                    className={cn(
                      "shrink-0 rounded-md p-1.5",
                      accentBg(a.accent)
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium">{a.name}</span>
                      <Bot className="size-3 text-muted-foreground" />
                    </div>
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                      {a.responsibility}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Model Router */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Model Router</CardTitle>
          <CardDescription>
            4-level routing ladder — every task enters at level 1 and only
            escalates if the cheaper level can't handle it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {ROUTER_LEVELS.map((lvl) => (
              <div
                key={lvl.level}
                className="flex flex-col gap-3 rounded-md border border-border/60 bg-card/40 p-3 sm:flex-row sm:items-center"
              >
                <div className="flex items-center gap-3 sm:w-56">
                  <span className="inline-flex size-8 items-center justify-center rounded-full bg-emerald-500/15 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                    L{lvl.level}
                  </span>
                  <span className="text-sm font-medium">{lvl.name}</span>
                </div>
                <div className="flex-1">
                  <p className="text-xs text-muted-foreground">
                    {lvl.description}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {lvl.examples.map((e) => (
                      <Badge
                        key={e}
                        variant="outline"
                        className="bg-slate-500/10 text-slate-600 dark:text-slate-400 font-mono text-[10px]"
                      >
                        {e}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Security boundaries */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Lock className="size-4 text-red-500" />
            Security Boundaries
          </CardTitle>
          <CardDescription>
            The LLM is never given a path around any of these gates (spec §21).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <Boundary
              title="Kill Switch"
              description="DB flags + filesystem markers + env var — any one can halt the agent."
            />
            <Boundary
              title="Policy Engine"
              description="L0-L3 execution levels gated by autonomy mode + approvals."
            />
            <Boundary
              title="Scam Detection"
              description="riskScore ≥ 70 → opportunity auto-rejected, no LLM appeal."
            />
            <Boundary
              title="Idempotency"
              description="External writes keyed by SHA-256(task+opportunity+intent)."
            />
            <Boundary
              title="Budget Caps"
              description="Daily / hourly LLM tokens, web requests, RPC requests — hard caps."
            />
            <Boundary
              title="Read-Only Wallets"
              description="No private keys are ever stored — wallets are public read-only."
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function accentBg(accent: string): string {
  switch (accent) {
    case "emerald": return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "violet": return "bg-violet-500/15 text-violet-700 dark:text-violet-300";
    case "amber": return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "yellow": return "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300";
    case "rose": return "bg-rose-500/15 text-rose-700 dark:text-rose-300";
    case "purple": return "bg-purple-500/15 text-purple-700 dark:text-purple-300";
    case "pink": return "bg-pink-500/15 text-pink-700 dark:text-pink-300";
    case "red": return "bg-red-500/15 text-red-700 dark:text-red-300";
    case "orange": return "bg-orange-500/15 text-orange-700 dark:text-orange-300";
    case "lime": return "bg-lime-500/15 text-lime-700 dark:text-lime-300";
    case "fuchsia": return "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300";
    default: return "bg-slate-500/15 text-slate-700 dark:text-slate-300";
  }
}

function Boundary({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-md border border-red-500/20 bg-red-500/5 p-3">
      <div className="flex items-center gap-2">
        <Lock className="size-3 text-red-500" />
        <span className="text-xs font-semibold">{title}</span>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
