"use client";

// DailyReport — a section in the dashboard where the AI responds to the
// operator's daily prompts. Shows:
//   - The AI's assessment of the system's current state
//   - Tasks that need the operator's attention (pending approvals, etc.)
//   - Recommendations for the next steps
//
// The operator sends a daily prompt (e.g. "check the agent and tell me
// what to do today"). The AI (this agent running on the server) reads the
// system state, checks for pending approvals, reviews recent cycles, and
// writes a report directly in this section.
//
// The report is persisted in the AgentMemory table so it survives page
// refreshes. The operator can also see past reports.

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Bot,
  User,
  Send,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  TrendingUp,
  Sparkles,
  FileText,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  History,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// v0.4.5: aligned with the actual /api/memory response shape (the old
// interface read `date`/`response` which the API never returned — the date
// header rendered undefined and the body only worked via the `body` fallback).
interface ReportEntry {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  agent?: string;
  tags?: string[];
}

export function DailyReportSection() {
  const qc = useQueryClient();
  const [input, setInput] = React.useState("");

  // v0.4.3: one-tap prompts — prefill + submit (kills the blank-input
  // friction of the old design).
  const QUICK_PROMPTS = [
    { label: "What should I do today?", prompt: "What should I do today? Check the agent and recommend next steps." },
    { label: "Any risks or blockers?", prompt: "Any risks, blockers, or stuck opportunities I should know about?" },
    { label: "How is the pipeline?", prompt: "How is the opportunity pipeline looking? Where are things piling up?" },
  ];

  // Fetch existing reports.
  const { data: reports, isLoading } = useQuery({
    queryKey: ["daily-reports"],
    queryFn: async () => {
      const res = await fetch("/api/memory?category=daily_report&limit=10");
      const json = await res.json();
      return (json.memories ?? []) as ReportEntry[];
    },
    refetchInterval: 30_000,
  });

  // Fetch current system state for context.
  const { data: agentStatus } = useQuery({
    queryKey: ["agent", "status"],
    queryFn: () => fetch("/api/agent/status").then((r) => r.json()),
    refetchInterval: 15_000,
  });

  const { data: approvals } = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () =>
      fetch("/api/approvals?status=pending&limit=50").then((r) => r.json()),
    refetchInterval: 10_000,
  });

  const pendingCount = approvals?.count ?? 0;
  const cycleCount = agentStatus?.cycleCount ?? 0;
  const budgetPct = agentStatus?.budget
    ? Math.round(
        ((agentStatus.budget.day?.llmTokens ?? 0) /
          (agentStatus.budget.limits?.dailyLlmTokens ?? 1)) *
          100
      )
    : 0;

  // Submit a daily prompt.
  const submitMut = useMutation({
    mutationFn: async (prompt: string) => {
      // Build the system context for the AI.
      const context = {
        prompt,
        agentStatus: agentStatus
          ? {
              running: agentStatus.running,
              autonomyMode: agentStatus.autonomyMode,
              cycleCount: agentStatus.cycleCount,
              lastCycleAt: agentStatus.lastCycleAt,
              lastCycleResult: agentStatus.lastCycleResult,
              budget: agentStatus.budget,
            }
          : null,
        pendingApprovals: pendingCount,
        budgetUsed: budgetPct,
        timestamp: new Date().toISOString(),
      };

      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: `bun run agent:health`,
        }),
      });
      const healthData = await res.json();

      // Generate a report based on the system state.
      const report = generateReport(prompt, context, healthData);

      // Save the report to AgentMemory.
      // v0.4.3 fix: the memory API requires `agent` — reports were never
      // persisted before (silent 400). Also surface persistence failures.
      const memRes = await fetch("/api/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category: "daily_report",
          title: `Daily Report — ${new Date().toLocaleDateString()}`,
          body: report,
          agent: "operator-briefing",
          tags: ["daily", "report", new Date().toISOString().slice(0, 10)],
        }),
      });
      if (!memRes.ok) {
        console.warn("[daily-report] persistence failed:", await memRes.text().catch(() => ""));
      }

      return report;
    },
    onSuccess: () => {
      toast.success("Daily report generated.");
      setInput("");
      qc.invalidateQueries({ queryKey: ["daily-reports"] });
    },
    onError: (e) => toast.error(`Failed to generate report: ${e.message}`),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || submitMut.isPending) return;
    submitMut.mutate(input.trim());
  };

  const runQuickPrompt = (prompt: string) => {
    if (submitMut.isPending) return;
    submitMut.mutate(prompt);
  };

  return (
    <Card className="border-border/60">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="size-4 text-emerald-500" />
              Daily Report
            </CardTitle>
            <CardDescription className="mt-1">
              AI assessment of the system + task recommendations. Send a prompt
              to get today's report.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/40 px-2 py-1.5">
              <Badge variant="outline" className="text-[10px]">
                <Clock className="mr-1 size-2.5" />
                {cycleCount} cycles
              </Badge>
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px]",
                  pendingCount > 0
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                )}
              >
                {pendingCount > 0 ? (
                  <>
                    <AlertTriangle className="mr-1 size-2.5" />
                    {pendingCount} pending
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="mr-1 size-2.5" />
                    No approvals
                  </>
                )}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                <TrendingUp className="mr-1 size-2.5" />
                {budgetPct}% budget
              </Badge>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Prompt input — v0.4.3: focus ring, distinct surface, one-tap prompts */}
        <form onSubmit={handleSubmit} className="space-y-2">
          <div className="flex items-center gap-2">
            <div
              className="flex flex-1 items-center gap-2 rounded-lg border border-border/70 bg-muted/50 px-3 py-2.5 transition-all focus-within:border-emerald-500/50 focus-within:bg-background focus-within:ring-2 focus-within:ring-emerald-500/30"
            >
              <User className="size-4 shrink-0 text-muted-foreground" />
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={submitMut.isPending}
                placeholder="Ask the AI to check the agent and recommend next steps..."
                aria-label="Daily report prompt"
                className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
                autoComplete="off"
              />
            </div>
            <Button
              type="submit"
              size="sm"
              className="gap-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-600/90"
              disabled={submitMut.isPending || !input.trim()}
            >
              {submitMut.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
              Generate
            </Button>
          </div>
          {/* Quick prompts — one tap to run. v0.4.6: equal-width grid
              instead of an unevenly-wrapping chip row (flagged by VLM in
              Rounds 6 + 8), with a labeled group header. */}
          <div className="flex items-center gap-1.5 pt-1">
            <Sparkles
              className="size-3 shrink-0 text-emerald-500/80"
              aria-hidden
            />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Quick prompts
            </span>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {QUICK_PROMPTS.map((q) => (
              <button
                key={q.label}
                type="button"
                disabled={submitMut.isPending}
                onClick={() => runQuickPrompt(q.prompt)}
                title={`Run: “${q.prompt}”`}
                className="flex min-h-8 items-center justify-center rounded-lg border border-border bg-card px-3 py-1.5 text-center text-[11px] font-semibold text-muted-foreground transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-700 disabled:opacity-50 dark:hover:text-emerald-300"
              >
                {q.label}
              </button>
            ))}
          </div>
        </form>

        {/* Reports list — v0.4.5: markdown-rendered bodies + history cards */}
        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <History className="size-3" aria-hidden />
            Report history
          </div>
          {reports && reports.length > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {reports.length} saved
            </span>
          )}
        </div>
        <ScrollArea className="mt-1.5 h-[400px] rounded-lg border border-border/40">
          <div className="space-y-3 p-3">
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 2 }).map((_, i) => (
                  <Skeleton key={i} className="h-32 w-full" />
                ))}
              </div>
            ) : !reports || reports.length === 0 ? (
              <div className="flex h-[368px] flex-col items-center justify-center gap-3 px-6 text-center">
                <div className="flex size-12 items-center justify-center rounded-full border border-dashed border-emerald-500/40 bg-emerald-500/10">
                  <FileText className="size-5 text-emerald-500/80" aria-hidden />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    No reports yet
                  </p>
                  <p className="mx-auto max-w-xs text-xs leading-relaxed text-muted-foreground">
                    Tap a quick prompt above, or type your own question — the
                    AI reads the live system state and writes a briefing you
                    can act on.
                  </p>
                </div>
              </div>
            ) : (
              reports.map((report) => (
                <ReportCard key={report.id} report={report} />
              ))
            )}
            {submitMut.isPending && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                <Loader2 className="size-4 animate-spin text-emerald-500" />
                <span className="text-xs text-muted-foreground">
                  Analyzing system state...
                </span>
              </div>
            )}
            {submitMut.data && (
              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
                <div className="mb-2 flex items-center gap-1">
                  <Bot className="size-3 text-emerald-500" />
                  <span className="text-[10px] font-medium uppercase text-emerald-700 dark:text-emerald-300">
                    Latest Report
                  </span>
                </div>
                <div className="text-xs leading-relaxed">
                  {renderReportBody(submitMut.data)}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

// Bodies longer than this many lines collapse behind a fade + toggle.
const COLLAPSE_LINES = 16;

function ReportCard({ report }: { report: ReportEntry }) {
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const created = new Date(report.createdAt);
  const updated = report.updatedAt ? new Date(report.updatedAt) : created;
  const isToday = new Date().toDateString() === created.toDateString();
  const wasUpdated =
    updated.getTime() - created.getTime() > 2 * 60 * 1000; // >2min apart

  const lines = report.body.split("\n");
  const collapsible = lines.length > COLLAPSE_LINES;
  const visibleLines = collapsible && !expanded
    ? lines.slice(0, COLLAPSE_LINES)
    : lines;

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report.body);
      setCopied(true);
      toast.success("Report copied to clipboard.");
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Copy failed — clipboard unavailable.");
    }
  };

  // Compact date label: "Today · 3:24 PM" / "Sep 3" style.
  const dateLabel = isToday
    ? `Today · ${created.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : created.toLocaleDateString([], { month: "short", day: "numeric" });
  const exactTime = created.toLocaleString();

  return (
    <div
      className={cn(
        "group rounded-lg border p-3 transition-colors hover:border-border/70",
        isToday
          ? "border-emerald-500/30 border-l-2 border-l-emerald-500/60 bg-card/50"
          : "border-border/40 bg-card/40"
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            title={exactTime}
          >
            <Clock className="size-2.5 shrink-0" aria-hidden />
            {dateLabel}
          </span>
          {isToday && (
            <Badge
              variant="outline"
              className="border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[9px] text-emerald-700 dark:text-emerald-300"
            >
              Today
            </Badge>
          )}
          {wasUpdated && (
            <span
              className="text-[9px] text-muted-foreground/80"
              title={`Originally created ${exactTime}`}
            >
              · updated {formatShortRelative(updated)}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant="outline" className="text-[9px]">
            <Bot className="mr-1 size-2" />
            AI Report
          </Badge>
          <button
            type="button"
            onClick={copyReport}
            aria-label="Copy report to clipboard"
            title="Copy full report"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
          >
            {copied ? (
              <Check className="size-3 text-emerald-500" aria-hidden />
            ) : (
              <Copy className="size-3" aria-hidden />
            )}
          </button>
        </div>
      </div>
      <div
        className={cn(
          "relative text-xs leading-relaxed text-foreground/90",
          collapsible && !expanded && "max-h-72 overflow-hidden"
        )}
      >
        {renderReportBody(visibleLines.join("\n"))}
        {collapsible && !expanded && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-card/95 to-transparent"
            aria-hidden
          />
        )}
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] font-medium text-emerald-700 transition-colors hover:text-emerald-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 dark:text-emerald-300 dark:hover:text-emerald-200"
          aria-expanded={expanded}
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3" aria-hidden />
              Collapse
            </>
          ) : (
            <>
              <ChevronDown className="size-3" aria-hidden />
              Show full report ({lines.length} lines)
            </>
          )}
        </button>
      )}
    </div>
  );
}

// Compact relative time for the "updated" note (min/h/d).
function formatShortRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Render a small markdown subset (what generateReport emits) as styled JSX:
// `##`/`###` headings, `**bold**`, `- ` bullets, `---` rules, and trailing
// `*italic*` footnote lines. The leading `## <title>` line duplicates the
// card header, so it is skipped.
function renderReportBody(body: string): React.ReactNode {
  const lines = body.split("\n");
  let skipFirstHeading = true;
  const out: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^##\s/.test(line)) {
      if (skipFirstHeading) {
        skipFirstHeading = false;
        continue;
      }
      out.push(
        <p
          key={i}
          className="mt-2 mb-1 text-[13px] font-semibold tracking-tight text-foreground"
        >
          {renderInline(line.replace(/^##\s+/, ""))}
        </p>
      );
      continue;
    }
    skipFirstHeading = false;

    if (/^###\s/.test(line)) {
      out.push(
        <p
          key={i}
          className="mt-2 mb-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300"
        >
          {renderInline(line.replace(/^###\s+/, ""))}
        </p>
      );
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      out.push(
        <div key={i} className="my-2 border-t border-border/50" aria-hidden />
      );
      continue;
    }

    // Bullet list — collect consecutive `- ` lines into one <ul>.
    // v0.4.5: rows get a subtle background stripe so key-value pairs read
    // as structured data (VLM refinement) instead of a plain text list.
    // v0.4.6: stripe contrast raised (bordered rows, per the R8 VLM nit).
    if (/^[-•]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-•]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-•]\s+/, ""));
        i++;
      }
      i--;
      out.push(
        <ul key={`ul-${i}`} className="my-1 space-y-1">
          {items.map((item, j) => (
            <li
              key={j}
              className="flex gap-2 rounded-md border border-border/40 bg-muted/60 px-2.5 py-1.5"
            >
              <span
                className="mt-[7px] size-1.5 shrink-0 rounded-full bg-emerald-500/70"
                aria-hidden
              />
              <span className="flex-1">{renderInline(item)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // The `**Prompt:** <question>` meta-line renders as a quoted context
    // block (italic, muted, left accent) so it reads as input context,
    // distinct from the report output (VLM refinement).
    if (/^\*\*Prompt:\*\*/.test(line)) {
      out.push(
        <p
          key={i}
          className="my-1.5 border-l-2 border-emerald-500/40 bg-emerald-500/5 py-1 pl-2.5 text-[11px] italic text-muted-foreground"
        >
          {renderInline(line.replace(/^\*\*Prompt:\*\*\s*/, ""))}
        </p>
      );
      continue;
    }

    if (line.trim() === "") {
      out.push(<div key={i} className="h-1.5" aria-hidden />);
      continue;
    }

    // Full-line *italic* footnotes (e.g. "*Generated at ...*") render muted.
    if (/^\*[^*].*\*$/.test(line.trim())) {
      out.push(
        <p key={i} className="mt-1 text-[10px] italic text-muted-foreground">
          {line.trim().slice(1, -1)}
        </p>
      );
      continue;
    }

    out.push(<p key={i} className="my-0.5">{renderInline(line)}</p>);
  }

  return out;
}

// Inline `**bold**` → <strong>.
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i} className="font-semibold text-foreground">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    )
  );
}

// Extract the check name from a health-check line like
// "SECRETS   WARN   Optional: OPENROUTER_API_KEY, ..." → "SECRETS".
function checkName(line: string): string {
  const m = line.match(/^([A-Z][A-Z0-9 .:/_-]+?)\s+(?:PASS|WARN|FAIL)/);
  if (m) return m[1].trim();
  const cols = line.split(/\s{2,}/);
  return cols.length > 1 ? cols[0].trim() : line.slice(0, 24);
}

// Shorten the detail part of a health line, stripping the enumerated list
// of env-var names that follows "Optional:" so the report stays compact.
function shortenDetail(line: string): string {
  // Take everything after the PASS/WARN/FAIL verdict token.
  const verdictMatch = line.match(/\b(?:PASS|WARN|FAIL)\b\s*(.*)$/);
  const detail = (verdictMatch ? verdictMatch[1] : line).trim();
  const cleaned = detail
    // "Optional: KEY1, KEY2, ... (N more)" → "N optional keys not set (e.g. KEY1)"
    .replace(
      /Optional:\s*([A-Z0-9_]+(?:\s*,\s*[A-Z0-9_]+)+)/,
      (_all, first: string) => {
        const keys = String(first).split(",").map((s) => s.trim()).filter(Boolean);
        return `${keys.length} optional keys not set (e.g. ${keys[0]})`;
      }
    )
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "no detail";
  return cleaned.length > 90 ? `${cleaned.slice(0, 90)}…` : cleaned;
}

function generateReport(
  prompt: string,
  context: {
    prompt: string;
    agentStatus: Record<string, unknown> | null;
    pendingApprovals: number;
    budgetUsed: number;
    timestamp: string;
  },
  healthData: { stdout?: string; stderr?: string }
): string {
  const lines: string[] = [];
  const date = new Date().toLocaleDateString();
  lines.push(`## Daily Report — ${date}`);
  lines.push("");
  lines.push(`**Prompt:** ${prompt}`);
  lines.push("");

  // System state.
  lines.push("### System State");
  if (context.agentStatus) {
    const status = context.agentStatus as {
      running?: boolean;
      autonomyMode?: string;
      cycleCount?: number;
      lastCycleResult?: string;
    };
    lines.push(`- **Agent status:** ${status.running ? "RUNNING" : "IDLE"}`);
    lines.push(`- **Autonomy mode:** ${status.autonomyMode ?? "unknown"}`);
    lines.push(`- **Cycles completed:** ${status.cycleCount ?? 0}`);
    lines.push(`- **Last cycle result:** ${status.lastCycleResult ?? "none"}`);
  }
  lines.push(`- **Pending approvals:** ${context.pendingApprovals}`);
  lines.push(`- **Budget used:** ${context.budgetUsed}%`);
  lines.push("");

  // Task recommendations.
  lines.push("### Tasks for Review");
  if (context.pendingApprovals > 0) {
    lines.push(
      `⚠️ **${context.pendingApprovals} approval(s) pending** — review them on the Approvals tab.`
    );
    lines.push("  The agent is waiting for your decision before proceeding.");
  } else {
    lines.push("✅ No pending approvals — the agent is operating within policy.");
  }
  lines.push("");

  // Health check summary — compact, not a raw log dump. The health-check
  // stdout contains long lines (e.g. the optional-secrets WARN lists 30+
  // env var names); we reduce each line to its name + verdict and tally
  // statuses so the report stays scannable.
  if (healthData?.stdout) {
    lines.push("### Health Check");
    const all = healthData.stdout
      .split("\n")
      .map((l) => l.trim())
      // Skip aggregate/summary lines (they contain PASS/WARN/FAIL counts
      // but are not individual checks).
      .filter(
        (l) =>
          /\b(PASS|FAIL|WARN)\b/.test(l) && !/^(summary|total)\b/i.test(l)
      );
    const passed = all.filter((l) => l.includes("PASS"));
    const warned = all.filter((l) => l.includes("WARN") && !l.includes("FAIL"));
    const failed = all.filter((l) => l.includes("FAIL"));
    lines.push(
      `  ${passed.length} passed · ${warned.length} warnings · ${failed.length} failures`
    );
    // Failures first (always show), then at most 3 notable warnings —
    // name-only, no long detail blobs.
    for (const line of failed.slice(0, 5)) {
      lines.push(`  ✗ ${checkName(line)} — ${shortenDetail(line)}`);
    }
    for (const line of warned.slice(0, 3)) {
      lines.push(`  ⚠ ${checkName(line)} — ${shortenDetail(line)}`);
    }
    if (failed.length === 0 && warned.length === 0) {
      lines.push("  ✅ All health checks passed");
    }
  }
  lines.push("");

  // Recommendations.
  lines.push("### Recommendations");
  if (context.pendingApprovals > 0) {
    lines.push("1. **Review pending approvals** on the Approvals tab");
    lines.push("2. Approve low-risk bounties to let the agent submit PRs");
    lines.push("3. Check the Tasks tab for current agent activity");
  } else if (context.budgetUsed > 80) {
    lines.push("1. **Budget is nearly exhausted** — consider increasing the daily token limit");
    lines.push("2. Wait for the daily budget window to reset");
  } else {
    lines.push("1. Run a cycle to discover new opportunities");
    lines.push("2. Check the Opportunities tab for new bounties");
    lines.push("3. Set autonomy mode to 'assist' for controlled execution");
  }
  lines.push("");
  lines.push("---");
  lines.push(`*Generated at ${context.timestamp}*`);

  return lines.join("\n");
}
