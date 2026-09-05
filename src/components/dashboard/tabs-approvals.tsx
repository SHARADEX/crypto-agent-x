"use client";

// ApprovalsTab — pending operator approvals queue + decided approvals
// history. Phase 3 §5, §6, §36:
//
// Each pending approval shows:
//   - What the opportunity asked for (title, description, requirements)
//   - What the agent created (the latest iteration's artifact — approach,
//     files, tests, diff)
//   - The quality gate results (PASS/WARN/FAIL for functionality, security,
//     requirements, economic — Phase 3 §12)
//   - Selected models + model confidence
//   - Reviewer feedback (from the Review Agent)
//
// Action buttons (Phase 3 §36): APPROVE, IMPROVE, REWORK, REQUEST CHANGES,
// REJECT, ABANDON, PAUSE, ASK AGENT.
//
// When IMPROVE / REWORK / REQUEST CHANGES is clicked, a structured feedback
// form opens (Phase 3 §6):
//   - Free-text feedback textarea
//   - Issue type dropdown (ui | functionality | bugs | performance | visuals
//     | gameplay | security | documentation | code_quality |
//     requirements_mismatch | missing_feature | other)
//   - Priority dropdown (low | medium | high | critical)
//   - Optional target areas input (comma-separated file/area paths)
//   - Submit button → POST /api/approvals/[id] with the decision + feedback

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CheckCircle2,
  Clock,
  ShieldCheck,
  ShieldAlert,
  XCircle,
  SkipForward,
  Loader2,
  RefreshCw,
  Wrench,
  AlertTriangle,
  Pause,
  HelpCircle,
  FileCode2,
  GitCompareArrows,
  History,
  CheckSquare,
  Square,
  Layers,
  MoreHorizontal,
  ChevronDown,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  api,
  formatRelativeTime,
  formatUsd,
  type ApprovalRow,
  type ApprovalDecision,
  type FeedbackType,
  type FeedbackPriority,
  type IterationRow,
  type QualityGateResult,
} from "./lib/api";
import { TaskIterationHistory } from "./task-iteration-history";
import { cn } from "@/lib/utils";

const HISTORY_STATUSES = [
  "approved",
  "rejected",
  "improve",
  "rework",
  "request_changes",
  "ask_agent",
  "skip",
  "pause",
] as const;

const FEEDBACK_TYPES: { value: FeedbackType; label: string }[] = [
  { value: "ui", label: "UI" },
  { value: "functionality", label: "Functionality" },
  { value: "bugs", label: "Bugs" },
  { value: "performance", label: "Performance" },
  { value: "visuals", label: "Visuals" },
  { value: "gameplay", label: "Gameplay" },
  { value: "security", label: "Security" },
  { value: "documentation", label: "Documentation" },
  { value: "code_quality", label: "Code quality" },
  { value: "requirements_mismatch", label: "Requirements mismatch" },
  { value: "missing_feature", label: "Missing feature" },
  { value: "other", label: "Other" },
];

const FEEDBACK_PRIORITIES: { value: FeedbackPriority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

const REJECT_REASONS = [
  { value: "scam", label: "Scam / fraudulent" },
  { value: "not_worth_it", label: "Not worth it (low $/hr)" },
  { value: "already_done", label: "Already done elsewhere" },
  { value: "duplicate", label: "Duplicate opportunity" },
  { value: "out_of_scope", label: "Out of scope" },
  { value: "insufficient_info", label: "Insufficient information" },
  { value: "other", label: "Other" },
];

const DECISIONS_REQUIRING_FEEDBACK: ApprovalDecision[] = [
  "improve",
  "rework",
  "request_changes",
];

// Phase-3 DEV-REVIEW-7 (#2): localStorage key for the "don't ask again"
// preference. Declared OUTSIDE the component to avoid Turbopack re-parsing
// issues with const-in-component-body.
const SKIP_CONFIRM_KEY = "cryptoearn-skip-bulk-confirmation";

// Phase-3 DEV-REVIEW-10 (#2 fix): read the env var at module level (not
// inside useMemo) to avoid hydration mismatches from process.env being
// server-only. Next.js inlines NEXT_PUBLIC_* at build time so this is
// consistent across server + client.
const STUCK_THRESHOLD_HOURS_VALUE = (() => {
  const envVal = process.env.NEXT_PUBLIC_PENDING_APPROVAL_STALE_HOURS;
  if (envVal) {
    const n = Number(envVal);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 6;
})();

export function ApprovalsTab({
  bulkActionHandlersRef,
}: {
  /** Phase-3 DEV-REVIEW-7 (#5): the page-client passes a ref that we
   *  populate with the current bulk-action handlers. The keyboard
   *  shortcuts hook reads from this ref so Ctrl+Enter etc. fire the
   *  right action even as the selection state changes. */
  bulkActionHandlersRef?: React.MutableRefObject<{
    approve: (() => void) | null;
    reject: (() => void) | null;
    skip: (() => void) | null;
  }>;
}) {
  const qc = useQueryClient();

  const { data: pendingData, isLoading: pendingLoading } = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => api.approvals.list({ status: "pending", limit: 50 }),
    refetchInterval: 10_000,
  });

  const historyQueries = useQueries({
    queries: HISTORY_STATUSES.map((status) => ({
      queryKey: ["approvals", "history", status],
      queryFn: () => api.approvals.list({ status, limit: 10 }),
      refetchInterval: 30_000,
    })),
  });

  const decideMut = useMutation({
    mutationFn: ({
      id,
      decision,
      options,
    }: {
      id: string;
      decision: ApprovalDecision;
      options?: {
        feedback?: string;
        feedbackType?: FeedbackType;
        feedbackPriority?: FeedbackPriority;
        feedbackTargetAreas?: string[];
        reasonCategory?: string;
      };
    }) => api.approvals.decide(id, decision, options ?? {}),
    onSuccess: (res, vars) => {
      const summary = decisionSummary(vars.decision, res);
      toast[summary.kind](summary.message);
      qc.invalidateQueries({ queryKey: ["approvals"] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["events"] });
    },
    onError: (e) => toast.error(`Decision failed: ${e.message}`),
  });

  // Phase-3 DEV-REVIEW-4 (priority #5 → DEV-REVIEW-5 #2): bulk-approve UI.
  // Selection state for the pending-approvals list. The sticky bulk-action
  // bar appears when ≥1 row is selected.
  const pendingApprovalsList = pendingData?.approvals ?? [];
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = React.useState(false);

  // Phase-3 DEV-REVIEW-6 (#5): "stuck approvals" filter. When enabled,
  // the pending list is narrowed to only approvals older than 6 hours.
  // Complements the PendingApprovalBanner (which shows at the top of the
  // dashboard) by letting the operator focus the queue on the stalest items.
  const [stuckOnly, setStuckOnly] = React.useState(false);
  // Phase-3 DEV-REVIEW-7 (#4): configurable threshold via the same env var
  // as the PendingApprovalBanner. Read at module level (not inside useMemo)
  // to avoid hydration mismatches from process.env being server-only.
  const STUCK_THRESHOLD_HOURS = STUCK_THRESHOLD_HOURS_VALUE;

  const visiblePending = React.useMemo(() => {
    if (!stuckOnly) return pendingApprovalsList;
    const now = Date.now();
    return pendingApprovalsList.filter((a) => {
      const ageMs = now - new Date(a.createdAt).getTime();
      return ageMs >= STUCK_THRESHOLD_HOURS * 60 * 60 * 1000;
    });
  }, [pendingApprovalsList, stuckOnly]);

  const stuckCount = React.useMemo(() => {
    const now = Date.now();
    return pendingApprovalsList.filter((a) => {
      const ageMs = now - new Date(a.createdAt).getTime();
      return ageMs >= STUCK_THRESHOLD_HOURS * 60 * 60 * 1000;
    }).length;
  }, [pendingApprovalsList]);

  const bulkMut = useMutation({
    mutationFn: ({
      ids,
      decision,
    }: {
      ids: string[];
      decision: "approve" | "reject" | "skip" | "pause";
    }) => api.approvals.bulkDecide(ids, decision),
    onMutate: () => setBulkRunning(true),
    onSuccess: (res, vars) => {
      const verb =
        vars.decision === "approve" ? "approved" : vars.decision === "reject" ? "rejected" : vars.decision + "d";
      const triggeredMsg =
        vars.decision === "approve" && res.triggered
          ? ` · ${res.triggered} queued for execution`
          : "";
      toast.success(
        `Bulk ${verb}: ${res.applied} applied, ${res.skipped} skipped${
          res.errors.length > 0 ? `, ${res.errors.length} errors` : ""
        }${triggeredMsg}`
      );
      setSelectedIds(new Set());
      qc.invalidateQueries({ queryKey: ["approvals"] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["events"] });
    },
    onError: (e) => toast.error(`Bulk decision failed: ${e.message}`),
    onSettled: () => setBulkRunning(false),
  });

  const toggleSelect = React.useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = React.useCallback(() => {
    setSelectedIds(new Set(pendingApprovalsList.map((a) => a.id)));
  }, [pendingApprovalsList]);

  const selectNone = React.useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const selectedCount = selectedIds.size;

  // Phase-3 DEV-REVIEW-6 (#2): confirmation dialog for destructive bulk
  // actions (reject-all, pause-all). Approve-all + skip-all execute
  // immediately (they're reversible — approve can be undone by rejecting
  // later, skip is non-destructive). Reject + pause are irreversible
  // (reject kills the opportunity's execution path, pause halts the
  // agent indefinitely) — we require explicit confirmation.
  const [confirmDialog, setConfirmDialog] = React.useState<{
    decision: "reject" | "pause";
    count: number;
  } | null>(null);

  // Phase-3 DEV-REVIEW-7 (#2): "don't ask again" checkbox state. When
  // checked, future bulk reject/pause actions skip the confirmation dialog
  // for the rest of the session (persisted to localStorage so it survives
  // page reloads). The operator can reset it via the keyboard shortcuts
  // help dialog or by clearing localStorage.
  const [skipConfirmation, setSkipConfirmation] = React.useState(false);

  // Local checkbox state — resets to false each time the dialog opens.
  const [dontAskAgain, setDontAskAgain] = React.useState(false);

  // Load the skip-confirmation flag from localStorage on mount.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const v = localStorage.getItem(SKIP_CONFIRM_KEY);
      if (v === "true") setSkipConfirmation(true);
    } catch {
      // ignore
    }
  }, []);

  // Reset the local checkbox when the dialog opens.
  React.useEffect(() => {
    if (confirmDialog) setDontAskAgain(false);
  }, [confirmDialog]);

  const persistSkipConfirmation = React.useCallback((v: boolean) => {
    setSkipConfirmation(v);
    if (typeof window === "undefined") return;
    try {
      if (v) localStorage.setItem(SKIP_CONFIRM_KEY, "true");
      else localStorage.removeItem(SKIP_CONFIRM_KEY);
    } catch {
      // ignore
    }
  }, []);

  const DESTRUCTIVE_DECISIONS = new Set<"reject" | "pause">(["reject", "pause"]);

  const executeBulk = React.useCallback(
    (decision: "approve" | "reject" | "skip" | "pause") => {
      bulkMut.mutate({ ids: Array.from(selectedIds), decision });
    },
    [bulkMut, selectedIds]
  );

  const handleBulkAction = React.useCallback(
    (decision: "approve" | "reject" | "skip" | "pause") => {
      if (
        DESTRUCTIVE_DECISIONS.has(decision as "reject" | "pause") &&
        !skipConfirmation
      ) {
        setConfirmDialog({ decision: decision as "reject" | "pause", count: selectedCount });
      } else {
        executeBulk(decision);
      }
    },
    [executeBulk, selectedCount, skipConfirmation]
  );

  // Phase-3 DEV-REVIEW-7 (#5): populate the ref with the current bulk-action
  // handlers so the keyboard shortcuts hook can fire them. Updates whenever
  // the selection changes.
  React.useEffect(() => {
    if (!bulkActionHandlersRef) return;
    if (selectedCount === 0) {
      bulkActionHandlersRef.current = { approve: null, reject: null, skip: null };
    } else {
      bulkActionHandlersRef.current = {
        approve: () => handleBulkAction("approve"),
        reject: () => handleBulkAction("reject"),
        skip: () => handleBulkAction("skip"),
      };
    }
  }, [bulkActionHandlersRef, selectedCount, handleBulkAction]);

  const history: ApprovalRow[] = React.useMemo(() => {
    const all: ApprovalRow[] = [];
    historyQueries.forEach((q, idx) => {
      if (q.data?.approvals) {
        all.push(...q.data.approvals);
      }
      void idx;
    });
    return all.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [historyQueries]);

  // Feedback-form dialog state (Phase 3 §6).
  const [feedbackDialog, setFeedbackDialog] = React.useState<{
    approvalId: string;
    decision: ApprovalDecision;
    title: string;
  } | null>(null);

  return (
    <div className="space-y-6">
      <PendingApprovalsCard
        pending={visiblePending}
        totalCount={pendingApprovalsList.length}
        stuckCount={stuckCount}
        stuckOnly={stuckOnly}
        onToggleStuckOnly={() => setStuckOnly((v) => !v)}
        loading={pendingLoading}
        deciding={decideMut.isPending}
        decidingId={decideMut.variables?.id}
        onDecide={(id, decision) => {
          if (DECISIONS_REQUIRING_FEEDBACK.includes(decision)) {
            const approval = pendingApprovalsList.find((a) => a.id === id);
            setFeedbackDialog({
              approvalId: id,
              decision,
              title: approval?.opportunity?.title ?? "Approval",
            });
          } else if (decision === "reject") {
            // Reject opens a separate dialog for the reason category.
            const approval = pendingApprovalsList.find((a) => a.id === id);
            setFeedbackDialog({
              approvalId: id,
              decision: "reject",
              title: approval?.opportunity?.title ?? "Approval",
            });
          } else {
            decideMut.mutate({ id, decision });
          }
        }}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        onSelectAll={selectAll}
        onSelectNone={selectNone}
        allSelected={selectedCount === visiblePending.length && visiblePending.length > 0}
        skipConfirmation={skipConfirmation}
      />

      {/* Phase-3 DEV-REVIEW-5 (#2): sticky bulk-action bar. Appears when ≥1
          pending approval is selected. Lets the operator approve-all /
          reject-all / skip-all / pause-all in one action. */}
      {selectedCount > 0 ? (
        <div className="sticky bottom-4 z-40 mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-lg border border-emerald-500/40 bg-background/95 p-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <Layers className="size-3.5 text-emerald-500" />
            {selectedCount} selected
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              className="h-7 gap-1 bg-emerald-600 text-white hover:bg-emerald-600/90"
              disabled={bulkRunning}
              onClick={() => handleBulkAction("approve")}
            >
              {bulkRunning ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
              Approve all
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 border-red-500/40 text-red-700 hover:bg-red-500/10 dark:text-red-300"
              disabled={bulkRunning}
              onClick={() => handleBulkAction("reject")}
            >
              <XCircle className="size-3" />
              Reject all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1"
              disabled={bulkRunning}
              onClick={() => handleBulkAction("skip")}
            >
              <SkipForward className="size-3" />
              Skip all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1"
              disabled={bulkRunning}
              onClick={() => handleBulkAction("pause")}
            >
              <Pause className="size-3" />
              Pause all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              disabled={bulkRunning}
              onClick={selectNone}
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      <HistoryCard approvals={history} loading={historyQueries.some((q) => q.isLoading)} />

      <FeedbackDialog
        open={feedbackDialog !== null}
        onClose={() => setFeedbackDialog(null)}
        approvalId={feedbackDialog?.approvalId ?? ""}
        decision={feedbackDialog?.decision ?? "improve"}
        title={feedbackDialog?.title ?? ""}
        onSubmit={(opts) => {
          if (!feedbackDialog) return;
          decideMut.mutate(
            {
              id: feedbackDialog.approvalId,
              decision: feedbackDialog.decision,
              options: opts,
            },
            {
              onSettled: () => setFeedbackDialog(null),
            }
          );
        }}
        submitting={decideMut.isPending}
      />

      {/* Phase-3 DEV-REVIEW-6 (#2): confirmation dialog for destructive
          bulk actions (reject-all, pause-all). Prevents accidental
          mass-rejection / mass-pause with a single misclick. */}
      <AlertDialog
        open={confirmDialog !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDialog(null);
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              {confirmDialog?.decision === "reject" ? (
                <XCircle className="size-5 text-red-500" />
              ) : (
                <Pause className="size-5 text-amber-500" />
              )}
              Confirm bulk {confirmDialog?.decision ?? "action"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  You are about to{" "}
                  <span className="font-semibold">
                    {confirmDialog?.decision === "reject" ? "reject" : "pause"}{" "}
                    {confirmDialog?.count ?? 0} approval
                    {(confirmDialog?.count ?? 0) === 1 ? "" : "s"}
                  </span>
                  {" "}in one action.
                </p>
                {confirmDialog?.decision === "reject" ? (
                  <p className="text-xs text-muted-foreground">
                    Rejected approvals cannot be undone — the corresponding
                    opportunities will be marked failed + removed from the
                    active queue. The operator would need to re-discover +
                    re-queue them from scratch.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Paused approvals will stay in the pending queue but the
                    agent will not process them until manually un-paused.
                    This is useful for holding work during an incident review.
                  </p>
                )}
                <p className="text-xs font-medium text-foreground">
                  Are you sure?
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Phase-3 DEV-REVIEW-7 (#2): "don't ask again" checkbox. */}
          <label className="flex cursor-pointer items-center gap-2 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-3 cursor-pointer accent-foreground"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
            />
            Don't ask again for this session
            <span className="ml-auto text-[10px] opacity-60">
              (clear via localStorage)
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-9">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                "h-9 gap-1",
                confirmDialog?.decision === "reject"
                  ? "bg-red-600 text-white hover:bg-red-600/90"
                  : "bg-amber-600 text-white hover:bg-amber-600/90"
              )}
              onClick={() => {
                if (confirmDialog) {
                  persistSkipConfirmation(dontAskAgain);
                  executeBulk(confirmDialog.decision);
                  setConfirmDialog(null);
                }
              }}
            >
              {confirmDialog?.decision === "reject" ? (
                <>
                  <XCircle className="size-4" />
                  Reject {confirmDialog?.count ?? 0} approval{(confirmDialog?.count ?? 0) === 1 ? "" : "s"}
                </>
              ) : (
                <>
                  <Pause className="size-4" />
                  Pause {confirmDialog?.count ?? 0} approval{(confirmDialog?.count ?? 0) === 1 ? "" : "s"}
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// useQueries polyfill — @tanstack/react-query v5 exports useQueries from the
// root. We import it lazily so the type stays stable.
// ---------------------------------------------------------------------------

import { useQueries } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// PendingApprovalsCard
// ---------------------------------------------------------------------------

interface PendingProps {
  pending: ApprovalRow[];
  /** Total count (before the stuck filter) — shown as "X of Y" when filtered. */
  totalCount: number;
  /** Count of approvals older than the stuck threshold (6h). */
  stuckCount: number;
  /** Whether the stuck-only filter is currently active. */
  stuckOnly: boolean;
  /** Toggle the stuck-only filter. */
  onToggleStuckOnly: () => void;
  loading: boolean;
  deciding: boolean;
  decidingId?: string;
  onDecide: (id: string, decision: ApprovalDecision) => void;
  /** Phase-3 DEV-REVIEW-5 (#2): bulk-selection support. */
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  allSelected: boolean;
  /** Phase-3 DEV-REVIEW-8 (#5): whether bulk destructive actions skip
   *  the confirmation dialog (shows a visual indicator badge). */
  skipConfirmation?: boolean;
}

function PendingApprovalsCard({
  pending,
  totalCount,
  stuckCount,
  stuckOnly,
  onToggleStuckOnly,
  loading,
  deciding,
  decidingId,
  onDecide,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onSelectNone,
  allSelected,
  skipConfirmation,
}: PendingProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <Clock className="size-4 text-amber-500" />
              Pending Approvals
              {totalCount > 0 ? (
                <Badge variant="outline" className="text-[10px]">
                  {stuckOnly ? `${pending.length} of ${totalCount}` : totalCount}
                </Badge>
              ) : null}
              {/* Phase-3 DEV-REVIEW-8 (#5): visual indicator when the
                  don't-ask-again preference is active. Shows a small rose
                  badge so the operator knows the safety net is off. */}
              {skipConfirmation ? (
                <Badge
                  variant="outline"
                  className="gap-1 border-rose-500/40 bg-rose-500/10 text-[9px] text-rose-700 dark:text-rose-300"
                  title="Bulk reject/pause actions skip the confirmation dialog. Reset via the keyboard shortcuts help dialog (?)."
                >
                  <ShieldAlert className="size-2.5" />
                  confirmations off
                </Badge>
              ) : null}
            </CardTitle>
            <CardDescription className="mt-1">
              Decisions on level-3 actions requiring operator approval —
              APPROVE, IMPROVE, REWORK, REQUEST CHANGES, REJECT, ABANDON, PAUSE,
              ASK AGENT (Phase 3 §36)
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {/* Phase-3 DEV-REVIEW-6 (#5): stuck-approvals filter toggle. */}
            {stuckCount > 0 ? (
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors",
                  stuckOnly
                    ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                    : "text-muted-foreground hover:bg-muted"
                )}
                onClick={onToggleStuckOnly}
                title={`Filter to only approvals older than 6 hours (${stuckCount} stuck)`}
              >
                <AlertTriangle className="size-3.5" />
                {stuckOnly ? `Showing ${stuckCount} stuck` : `${stuckCount} stuck > 6h`}
              </button>
            ) : null}
            {/* Phase-3 DEV-REVIEW-5 (#2): select-all checkbox. */}
            {!loading && pending.length > 0 ? (
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted"
                onClick={allSelected ? onSelectNone : onSelectAll}
                title={allSelected ? "Deselect all" : "Select all for bulk action"}
              >
                {allSelected ? (
                  <CheckSquare className="size-3.5 text-emerald-500" />
                ) : (
                  <Square className="size-3.5" />
                )}
                {allSelected ? "Deselect all" : "Select all"}
              </button>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : pending.length === 0 ? (
          <div className="rounded-md border border-dashed border-emerald-500/40 bg-emerald-500/5 p-8 text-center">
            <ShieldCheck className="mx-auto size-6 text-emerald-600 dark:text-emerald-400" />
            <p className="mt-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
              No approvals pending.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              The agent is operating within policy.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {pending.map((a) => (
              <PendingApprovalRow
                key={a.id}
                approval={a}
                deciding={deciding && decidingId === a.id}
                onDecide={(decision) => onDecide(a.id, decision)}
                selected={selectedIds.has(a.id)}
                onToggleSelect={() => onToggleSelect(a.id)}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// PendingApprovalRow — expanded card with artifact + quality gate + actions
// ---------------------------------------------------------------------------

function PendingApprovalRow({
  approval,
  deciding,
  onDecide,
  selected,
  onToggleSelect,
}: {
  approval: ApprovalRow;
  deciding: boolean;
  onDecide: (decision: ApprovalDecision) => void;
  /** Phase-3 DEV-REVIEW-5 (#2): selection state for bulk actions. */
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const [expanded, setExpanded] = React.useState(true);

  return (
    <div
      className={cn(
        "card-hover-lift relative rounded-xl border border-border/60 bg-card p-3.5 shadow-sm transition-colors sm:p-4",
        selected && "border-emerald-500/50 ring-1 ring-emerald-500/25"
      )}
    >
      {/* Amber left edge — signals "awaiting decision" without boxing
          the whole card in a heavy amber border (v2 polish). */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[3px] rounded-l-xl bg-amber-400/80"
      />
      {/* Header row */}
      <div className="flex flex-col gap-3 pl-1.5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* Phase-3 DEV-REVIEW-5 (#2): selection checkbox. */}
            <button
              type="button"
              onClick={onToggleSelect}
              className="shrink-0 rounded-sm p-0.5 transition-colors hover:bg-muted"
              aria-label={selected ? "Deselect this approval" : "Select this approval for bulk action"}
              title={selected ? "Deselect" : "Select for bulk action"}
            >
              {selected ? (
                <CheckSquare className="size-4 text-emerald-500" />
              ) : (
                <Square className="size-4 text-muted-foreground" />
              )}
            </button>
            <Badge
              variant="outline"
              className={cn("capitalize", riskBadgeClass(approval.riskLevel))}
            >
              <ShieldAlert className="size-3" />
              {approval.riskLevel}
            </Badge>
            {/* Muted metadata — L-level + age should not compete with the
                risk badge for attention (v2 polish). */}
            <Badge
              variant="outline"
              className="border-border/40 bg-transparent text-muted-foreground/70"
            >
              L{approval.executionLevel}
            </Badge>
            <span className="text-xs text-muted-foreground/70">
              {formatRelativeTime(approval.createdAt)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Hide details" : "Show details"}
            </Button>
          </div>
          <div className="mt-1.5 text-sm font-medium">
            {approval.opportunity?.title ?? "Approval request"}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{approval.reason}</p>
          {approval.opportunity ? (
            <div className="mt-1.5 text-[10px] text-muted-foreground">
              Source:{" "}
              <span className="font-mono">{approval.opportunity.source}</span>
              {" · "}
              Reward:{" "}
              <span className="font-semibold text-foreground">
                {formatUsd(approval.opportunity.rewardUsd)}
              </span>
              {" · "}
              Exp/hr:{" "}
              <span className="font-semibold text-foreground">
                {formatUsd(approval.opportunity.riskAdjustedHourly)}
              </span>
            </div>
          ) : null}
        </div>
        <ActionRow deciding={deciding} onDecide={onDecide} />
      </div>

      {/* Expanded details */}
      {expanded ? (
        <div className="mt-3 space-y-3 border-t border-amber-500/20 pt-3">
          <ApprovalDetailGrid approval={approval} />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActionRow v2 — decision actions reorganized by frequency + severity.
//
// Primary (always visible):   Approve (solid emerald) · Improve (outline)
// Destructive (visible):      Reject (red outline)
// Everything else lives in a kebab "More actions" dropdown so the row stays
// scannable: Request Changes · Rework · Ask Agent · Abandon · Pause.
// (Phase 3 §36 semantics preserved — same decisions, same dialog flow.)
// ---------------------------------------------------------------------------

function ActionRow({
  deciding,
  onDecide,
}: {
  deciding: boolean;
  onDecide: (decision: ApprovalDecision) => void;
}) {
  const moreActions: {
    label: string;
    decision: ApprovalDecision;
    icon: React.ReactNode;
    hint: string;
  }[] = [
    {
      label: "Request changes",
      decision: "request_changes",
      icon: <GitCompareArrows className="size-3.5" />,
      hint: "Ask for specific code changes",
    },
    {
      label: "Rework",
      decision: "rework",
      icon: <RefreshCw className="size-3.5" />,
      hint: "Redo the artifact from scratch",
    },
    {
      label: "Ask agent",
      decision: "ask_agent",
      icon: <HelpCircle className="size-3.5" />,
      hint: "Let the agent clarify or proceed",
    },
  ];

  const destructiveActions: {
    label: string;
    decision: ApprovalDecision;
    icon: React.ReactNode;
    hint: string;
  }[] = [
    {
      label: "Abandon",
      decision: "skip",
      icon: <SkipForward className="size-3.5" />,
      hint: "Skip this opportunity entirely",
    },
    {
      label: "Pause",
      decision: "pause",
      icon: <Pause className="size-3.5" />,
      hint: "Keep pending, stop the agent on it",
    },
  ];

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      {/* Primary: Approve */}
      <Button
        size="sm"
        variant="default"
        className="h-8 gap-1.5 bg-emerald-600 px-3 text-[11px] font-semibold text-white hover:bg-emerald-600/90"
        disabled={deciding}
        onClick={() => onDecide("approve")}
      >
        {deciding ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
        Approve
      </Button>

      {/* Secondary: Improve — opens the structured feedback dialog */}
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1.5 px-3 text-[11px]"
        disabled={deciding}
        onClick={() => onDecide("improve")}
      >
        <Wrench className="size-3.5" />
        Improve
      </Button>

      {/* Destructive: Reject */}
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1.5 border-red-500/30 px-3 text-[11px] text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400"
        disabled={deciding}
        onClick={() => onDecide("reject")}
      >
        <XCircle className="size-3.5" />
        Reject
      </Button>

      {/* Everything else */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 px-0"
            disabled={deciding}
            aria-label="More approval actions"
            title="More actions"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="text-[10px]">Iterate</DropdownMenuLabel>
          {moreActions.map((a) => (
            <DropdownMenuItem
              key={a.decision}
              onClick={() => onDecide(a.decision)}
              className="gap-2 text-[12px]"
            >
              {a.icon}
              <div className="flex flex-col">
                <span>{a.label}</span>
                <span className="text-[10px] text-muted-foreground">{a.hint}</span>
              </div>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] text-muted-foreground">Defer / discard</DropdownMenuLabel>
          {destructiveActions.map((a) => (
            <DropdownMenuItem
              key={a.decision}
              onClick={() => onDecide(a.decision)}
              className="gap-2 text-[12px]"
            >
              {a.icon}
              <div className="flex flex-col">
                <span>{a.label}</span>
                <span className="text-[10px] text-muted-foreground">{a.hint}</span>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ApprovalDetailGrid — opportunity info + latest iteration artifact +
// quality gate results + models + reviewer feedback (Phase 3 §5)
// ---------------------------------------------------------------------------

function ApprovalDetailGrid({ approval }: { approval: ApprovalRow }) {
  const taskId = approval.taskId;
  return (
    <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
      {/* What the opportunity asked for — open by default (decision-critical) */}
      <DetailBlock title="Opportunity requirements" defaultOpen>
        {approval.opportunity?.description ? (
          <p className="text-xs text-muted-foreground">
            {truncate(approval.opportunity.description, 240)}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground italic">
            No opportunity linked.
          </p>
        )}
        {approval.opportunity?.requirements ? (
          <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
            {parseStringArray(approval.opportunity.requirements).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : null}
      </DetailBlock>

      {/* Latest iteration artifact — open by default (the work to approve) */}
      <DetailBlock title="Agent's latest iteration" defaultOpen>
        {taskId ? (
          <LatestIterationView taskId={taskId} />
        ) : (
          <DetailPlaceholder text="No task linked to this approval yet — the agent will attach one when it starts work." />
        )}
      </DetailBlock>

      {/* Quality gate results */}
      <DetailBlock title="Quality gate (Phase 3 §12)">
        {taskId ? (
          <QualityGateView taskId={taskId} />
        ) : (
          <DetailPlaceholder text="Quality gate runs once a task is linked." />
        )}
      </DetailBlock>

      {/* Full iteration history (Phase 3 §7, §8, §9) — v0 → v1 → v2 timeline
          with View / Compare / Restore actions. */}
      <DetailBlock title="Iteration history (v0 → vN timeline)">
        {taskId ? (
          <TaskIterationHistory taskId={taskId} />
        ) : (
          <DetailPlaceholder text="Iteration history appears after the first agent run." />
        )}
      </DetailBlock>

      {/* Models + reviewer feedback — risk/EV line is decision-critical */}
      <DetailBlock title="Models + reviewer feedback" defaultOpen>
        <ModelsAndReviewerView approval={approval} />
      </DetailBlock>
    </div>
  );
}

/** Collapsible detail section — keeps the expanded approval card compact
 *  (Round-2 VLM nitpick). Decision-critical sections open by default;
 *  supporting sections collapse to a single title row. */
function DetailBlock({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border border-border/50 bg-muted/20"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 rounded-lg p-2.5 text-left transition-colors hover:bg-muted/40"
          aria-expanded={open}
        >
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {title}
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-2.5 pb-2.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Intentional-empty placeholder — dashed slot so "no data yet" reads as
 *  a designed state, not missing data (VLM QA nitpick fix). */
function DetailPlaceholder({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-border/60 bg-transparent px-2.5 py-2.5">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <FileCode2 className="size-3" />
      </span>
      <p className="text-xs italic text-muted-foreground/70">{text}</p>
    </div>
  );
}

function LatestIterationView({ taskId }: { taskId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["iterations", "task", taskId],
    queryFn: () => api.iterations.listForTask(taskId),
    refetchInterval: 30_000,
  });
  if (isLoading) return <Skeleton className="h-8 w-full" />;
  const iterations = data?.iterations ?? [];
  if (iterations.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        No iterations recorded yet.
      </p>
    );
  }
  const latest = iterations[iterations.length - 1];
  const artifact = safeParseArtifact(latest.artifactJson);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="outline" className="text-[10px]">
          <History className="size-2.5" />
          {latest.version}
        </Badge>
        {latest.qualityScore != null ? (
          <Badge variant="outline" className="text-[10px]">
            Q: {latest.qualityScore.toFixed(1)}/10
          </Badge>
        ) : null}
        {latest.modelId ? (
          <Badge variant="outline" className="text-[10px] font-mono">
            {latest.modelId}
          </Badge>
        ) : null}
        <span className="text-[10px] text-muted-foreground">
          {formatRelativeTime(latest.createdAt)}
        </span>
      </div>
      {artifact.approach ? (
        <p className="text-[11px] text-muted-foreground">
          {truncate(artifact.approach, 200)}
        </p>
      ) : null}
      {artifact.files.length > 0 ? (
        <div className="space-y-0.5">
          {artifact.files.slice(0, 3).map((f, i) => (
            <div
              key={i}
              className="flex items-center gap-1 text-[10px] text-muted-foreground"
            >
              <FileCode2 className="size-2.5" />
              <span className="font-mono">{f.path}</span>
              <span className="text-muted-foreground/60">
                ({f.language})
              </span>
            </div>
          ))}
          {artifact.files.length > 3 ? (
            <div className="text-[10px] text-muted-foreground italic">
              +{artifact.files.length - 3} more file(s)
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground italic">
          No files in this iteration's artifact.
        </p>
      )}
    </div>
  );
}

function QualityGateView({ taskId }: { taskId: string }) {
  const { data: iterationsData, isLoading: itLoading } = useQuery({
    queryKey: ["iterations", "task", taskId],
    queryFn: () => api.iterations.listForTask(taskId),
    refetchInterval: 30_000,
  });
  const latestId = iterationsData?.iterations?.[iterationsData.iterations.length - 1]?.id;
  const { data, isLoading } = useQuery({
    queryKey: ["iterations", "quality-gate", latestId],
    queryFn: () =>
      latestId ? api.iterations.qualityGate(latestId) : Promise.resolve(null),
    enabled: !!latestId,
  });
  if (itLoading || isLoading) return <Skeleton className="h-8 w-full" />;
  if (!data?.qualityGate) {
    return (
      <p className="text-xs text-muted-foreground italic">
        No quality gate available (no iterations).
      </p>
    );
  }
  const qg = data.qualityGate;
  return (
    <div className="space-y-1">
      <Badge
        variant="outline"
        className={cn(
          "text-[10px] uppercase",
          qg.overall === "pass"
            ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : qg.overall === "warn"
            ? "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300"
            : "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300"
        )}
      >
        Overall: {qg.overall}
      </Badge>
      <div className="grid grid-cols-2 gap-1">
        {qg.checks.map((c) => (
          <div
            key={c.name}
            className="flex items-center gap-1 rounded border border-border/40 p-1"
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                c.status === "pass"
                  ? "bg-emerald-500"
                  : c.status === "warn"
                  ? "bg-amber-500"
                  : "bg-red-500"
              )}
            />
            <span className="text-[9px] text-muted-foreground">
              {c.name.replace(/_/g, " ")}
            </span>
            <span className="ml-auto text-[9px] uppercase">{c.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelsAndReviewerView({ approval }: { approval: ApprovalRow }) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1 text-[10px]">
        <span className="text-muted-foreground">Risk:</span>
        <span className="font-medium capitalize">{approval.riskLevel}</span>
        <span className="text-muted-foreground/60">·</span>
        <span className="text-muted-foreground">Exec level:</span>
        <span className="font-medium">L{approval.executionLevel}</span>
        {approval.opportunity ? (
          <>
            <span className="text-muted-foreground/60">·</span>
            <span className="text-muted-foreground">EV:</span>
            <span className="font-semibold">
              {formatUsd(approval.opportunity.expectedValue)}
            </span>
          </>
        ) : null}
      </div>
      {approval.feedback ? (
        <div className="rounded border border-amber-500/20 bg-amber-500/5 p-1.5 text-[11px]">
          <div className="font-medium text-amber-700 dark:text-amber-300">
            Prior feedback:
          </div>
          <p className="mt-0.5 text-muted-foreground">
            {truncate(approval.feedback, 200)}
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground italic">
          No prior reviewer feedback on this approval.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HistoryCard
// ---------------------------------------------------------------------------

function HistoryCard({
  approvals,
  loading,
}: {
  approvals: ApprovalRow[];
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Decision History</CardTitle>
        <CardDescription>
          Recently-decided approvals — includes the new IMPROVE / REWORK /
          REQUEST CHANGES / ASK AGENT / PAUSE statuses (Phase 3 §4)
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="max-h-[400px] overflow-y-auto scrollbar-thin space-y-1.5">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))
          ) : approvals.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/60 p-6 text-center text-xs text-muted-foreground">
              No decisions yet.
            </div>
          ) : (
            approvals.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-card/40 p-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {a.opportunity?.title ?? a.reason}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {a.opportunity?.source ?? "—"} ·{" "}
                    {formatRelativeTime(a.createdAt)}
                    {a.feedbackType ? ` · ${a.feedbackType}` : ""}
                    {a.feedbackPriority ? ` / ${a.feedbackPriority}` : ""}
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className={cn("capitalize", decidedBadgeClass(a.status))}
                >
                  {a.status}
                </Badge>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// FeedbackDialog — structured feedback form for IMPROVE / REWORK /
// REQUEST CHANGES + the REJECT reason-category form (Phase 3 §6, §32)
// ---------------------------------------------------------------------------

function FeedbackDialog({
  open,
  onClose,
  approvalId,
  decision,
  title,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  approvalId: string;
  decision: ApprovalDecision;
  title: string;
  onSubmit: (opts: {
    feedback?: string;
    feedbackType?: FeedbackType;
    feedbackPriority?: FeedbackPriority;
    feedbackTargetAreas?: string[];
    reasonCategory?: string;
  }) => void;
  submitting: boolean;
}) {
  const [feedback, setFeedback] = React.useState("");
  const [feedbackType, setFeedbackType] = React.useState<FeedbackType>("other");
  const [feedbackPriority, setFeedbackPriority] =
    React.useState<FeedbackPriority>("medium");
  const [targetAreasRaw, setTargetAreasRaw] = React.useState("");
  const [reasonCategory, setReasonCategory] = React.useState<string>("other");

  // Reset form state whenever the dialog opens for a different approval.
  React.useEffect(() => {
    if (open) {
      setFeedback("");
      setFeedbackType("other");
      setFeedbackPriority("medium");
      setTargetAreasRaw("");
      setReasonCategory("other");
    }
  }, [open, approvalId, decision]);

  const isReject = decision === "reject";
  const requiresFeedback = DECISIONS_REQUIRING_FEEDBACK.includes(decision);
  const verb = isReject
    ? "reject"
    : decision === "improve"
    ? "improve"
    : decision === "rework"
    ? "rework"
    : "request changes to";

  const canSubmit = isReject
    ? reasonCategory.length > 0
    : feedback.trim().length > 0 && feedbackType.length > 0 && feedbackPriority.length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const targetAreas = targetAreasRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (isReject) {
      onSubmit({
        feedback: feedback.trim() || undefined,
        reasonCategory,
        feedbackType: "other",
        feedbackPriority: "medium",
      });
    } else {
      onSubmit({
        feedback: feedback.trim(),
        feedbackType,
        feedbackPriority,
        feedbackTargetAreas: targetAreas.length > 0 ? targetAreas : undefined,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            {requiresFeedback ? (
              <AlertTriangle className="size-4 text-amber-500" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            {verb.charAt(0).toUpperCase() + verb.slice(1)}: {truncate(title, 50)}
          </DialogTitle>
          <DialogDescription>
            {requiresFeedback
              ? "Provide structured feedback so the agent can plan the next iteration (Phase 3 §6)."
              : "Pick a reason category (Phase 3 §32). The category is recorded for the audit trail + future learning."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!isReject ? (
            <>
              <div className="space-y-1">
                <Label className="text-xs">Feedback</Label>
                <Textarea
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="Describe what needs to change and why…"
                  rows={4}
                  className="text-xs"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Issue type</Label>
                  <Select
                    value={feedbackType}
                    onValueChange={(v) => setFeedbackType(v as FeedbackType)}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FEEDBACK_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Priority</Label>
                  <Select
                    value={feedbackPriority}
                    onValueChange={(v) =>
                      setFeedbackPriority(v as FeedbackPriority)
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FEEDBACK_PRIORITIES.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">
                  Target areas{" "}
                  <span className="text-muted-foreground">
                    (comma-separated file/area paths, optional)
                  </span>
                </Label>
                <Input
                  value={targetAreasRaw}
                  onChange={(e) => setTargetAreasRaw(e.target.value)}
                  placeholder="src/resolvers/profile-metadata.ts, tests/profile-metadata.test.ts"
                  className="text-xs"
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1">
                <Label className="text-xs">Reason category (Phase 3 §32)</Label>
                <Select value={reasonCategory} onValueChange={setReasonCategory}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REJECT_REASONS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">
                  Optional comment{" "}
                  <span className="text-muted-foreground">
                    (recorded on the approval row)
                  </span>
                </Label>
                <Textarea
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="Optional context for this rejection…"
                  rows={3}
                  className="text-xs"
                />
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSubmit || submitting}
            onClick={handleSubmit}
            className={
              isReject
                ? "bg-red-600 text-white hover:bg-red-600/90"
                : "bg-amber-600 text-white hover:bg-amber-600/90"
            }
          >
            {submitting ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              `Confirm ${verb}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function riskBadgeClass(riskLevel: string): string {
  switch (riskLevel) {
    case "high":
      return "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300";
    case "moderate":
      return "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "financial":
      return "border-purple-500/30 bg-purple-500/15 text-purple-700 dark:text-purple-300";
    default:
      return "border-slate-500/30 bg-slate-500/15 text-slate-700 dark:text-slate-300";
  }
}

function decidedBadgeClass(status: string): string {
  switch (status) {
    case "approved":
      return "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "rejected":
    case "skip":
      return "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300";
    case "improve":
    case "rework":
    case "request_changes":
      return "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "ask_agent":
      return "border-cyan-500/30 bg-cyan-500/15 text-cyan-700 dark:text-cyan-300";
    case "pause":
      return "border-purple-500/30 bg-purple-500/15 text-purple-700 dark:text-purple-300";
    default:
      return "border-slate-500/30 bg-slate-500/15 text-slate-700 dark:text-slate-300";
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

function safeParseArtifact(json: string | null | undefined): {
  approach: string;
  files: Array<{ path: string; language: string; content: string }>;
  tests: Array<{ path: string; framework: string; content: string }>;
} {
  if (!json) return { approach: "", files: [], tests: [] };
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return {
      approach: typeof parsed.approach === "string" ? parsed.approach : "",
      files: Array.isArray(parsed.files)
        ? (parsed.files as Array<Record<string, unknown>>)
            .map((f) => ({
              path: typeof f.path === "string" ? f.path : "",
              language: typeof f.language === "string" ? f.language : "",
              content: typeof f.content === "string" ? f.content : "",
            }))
            .filter((f) => f.path.length > 0)
        : [],
      tests: [],
    };
  } catch {
    return { approach: "", files: [], tests: [] };
  }
}

function decisionSummary(
  decision: ApprovalDecision,
  res: {
    iteration?: IterationRow;
    plan?: { requestedChanges?: string[] };
    queueResult?: { queued?: boolean };
    iterationError?: string;
    planError?: string;
    canIterate?: boolean;
  }
): { kind: "success" | "info" | "error"; message: string } {
  if (res.iterationError) {
    return {
      kind: "error",
      message: `${decision} recorded but iteration failed: ${res.iterationError}`,
    };
  }
  if (decision === "approve") {
    return {
      kind: "success",
      message: res.queueResult?.queued
        ? "Approved + queued for execution."
        : "Approved (no execution queue needed).",
    };
  }
  if (DECISIONS_REQUIRING_FEEDBACK.includes(decision)) {
    const version = res.iteration?.version;
    const changes = res.plan?.requestedChanges?.length ?? 0;
    return {
      kind: "info",
      message: `${decision}d — created ${version ?? "new iteration"} with ${changes} planned change(s).${
        res.planError ? ` Plan error: ${res.planError}` : ""
      }`,
    };
  }
  if (decision === "reject") {
    return { kind: "info", message: "Rejected — reason recorded." };
  }
  if (decision === "pause") {
    return { kind: "info", message: "Paused — PAUSE marker written." };
  }
  return { kind: "success", message: `Decision '${decision}' recorded.` };
}

// QualityGateResult type is imported but the only field used is via apiFetch
// — keep the import for callers that want it.
export type { QualityGateResult };
