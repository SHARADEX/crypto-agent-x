"use client";

// OpportunityDetailSheet — full-detail slide-over for a single Opportunity.
//
// The sheet fetches /api/opportunities/[id] when opened and renders the
// full record including related tasks / earnings / transactions / approvals
// / events so the operator can review the entire pipeline at a glance.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ExternalLink, Loader2, ShieldCheck, ShieldAlert, Clock, GitPullRequest } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, formatUsd, formatRelativeTime, statusColor } from "./lib/api";
import { daysUntil, deadlineUrgency } from "./lib/deadline";
import { ScoreBar } from "./score-bar";
import { WatchStar } from "./watch-star";
import { cn } from "@/lib/utils";

export function OpportunityDetailSheet({
  opportunityId,
  open,
  onOpenChange,
}: {
  opportunityId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["opportunity-detail", opportunityId],
    queryFn: () => api.opportunities.get(opportunityId as string),
    enabled: !!opportunityId && open,
    refetchInterval: 15_000,
  });

  const processMut = useMutation({
    mutationFn: (id: string) => api.opportunities.process(id),
    onSuccess: () => {
      toast.success("Opportunity processed — lifecycle advanced.");
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["opportunity-detail", opportunityId] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["analytics"] });
    },
    onError: (e) => toast.error(`Process failed: ${e.message}`),
  });

  const verifyMut = useMutation({
    mutationFn: (id: string) => api.opportunities.verifyPayment(id),
    onSuccess: (res) => {
      const matched = (res.result as { matched?: boolean } | undefined)?.matched;
      if (matched) toast.success("Payment verified — matched on chain.");
      else toast.info("Payment not yet matched on chain.");
      qc.invalidateQueries({ queryKey: ["opportunity-detail", opportunityId] });
      qc.invalidateQueries({ queryKey: ["ledger"] });
    },
    onError: (e) => toast.error(`Verify failed: ${e.message}`),
  });

  const op = data?.opportunity;

  // v0.5.1: live PR status for submitted / awaiting_payment opportunities —
  // reads the new /api/opportunities/[id]/pr-status endpoint (GitHub API,
  // read-only). Renders as its own section below the actions.
  const prStatusQuery = useQuery({
    queryKey: ["pr-status", opportunityId],
    queryFn: () => api.opportunities.prStatus(opportunityId as string),
    enabled:
      !!opportunityId &&
      open &&
      (op?.status === "submitted" || op?.status === "awaiting_payment"),
    refetchInterval: 60_000,
    staleTime: 45_000,
    retry: 1,
  });

  // Since v0.4.1 the detail endpoint emits the same canonical shape as the
  // LIST endpoint (nested reward.estimated_usd). Older flat responses
  // (rewardUsd / rewardAmount / rewardCurrency) are still tolerated here as
  // defense-in-depth so the sheet never crashes on the wire shape (runtime
  // bug fix: "Cannot read properties of undefined (reading 'estimated_usd')").
  const rewardUsd =
    op?.reward?.estimated_usd ??
    (op as { rewardUsd?: number } | undefined)?.rewardUsd ??
    0;

  // Since v0.4.1 the detail endpoint parses requirements / skillsRequired into
  // real arrays server-side. The normalizer below tolerates legacy JSON-encoded
  // strings as well (runtime bug fix: "map is not a function").
  const requirements = parseStringArray(
    (op as { requirements?: string[] | string } | undefined)?.requirements as
      | string[]
      | string
      | undefined
  );
  const skillsRequired = parseStringArray(
    (op as { skillsRequired?: string[] | string } | undefined)?.skillsRequired as
      | string[]
      | string
      | undefined
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full flex-col gap-0 p-0 sm:max-w-2xl"
      >
        <SheetHeader className="border-b p-4">
          <SheetTitle className="text-base leading-snug">
            {isLoading ? (
              <Skeleton className="h-5 w-3/4" />
            ) : op ? (
              op.title
            ) : (
              "Opportunity"
            )}
          </SheetTitle>
          <SheetDescription className="flex items-center gap-2 text-xs">
            {op ? (
              <>
                <span className="font-mono">{op.source}</span>
                <span aria-hidden>·</span>
                <span>{op.organization || "Unknown org"}</span>
                <span aria-hidden>·</span>
                <span className="font-mono capitalize">{op.category}</span>
              </>
            ) : (
              "Loading…"
            )}
          </SheetDescription>
          {op && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={cn(
                  "capitalize",
                  statusColor(op.status).bg,
                  statusColor(op.status).text,
                  statusColor(op.status).border
                )}
              >
                {statusColor(op.status).label}
              </Badge>
              {op.sourceVerified ? (
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                >
                  <ShieldCheck className="size-3" /> Source verified
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                >
                  <ShieldAlert className="size-3" /> Source unverified
                </Badge>
              )}
              {op.paymentVerified && (
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                >
                  Payment verified
                </Badge>
              )}
              {/* v0.4.3: deadline urgency pill (matches briefing + cards) */}
              {op.deadline && (
                <Badge
                  variant="outline"
                  title={`Deadline: ${new Date(op.deadline).toLocaleString()}`}
                  className={cn(
                    "gap-1 font-semibold tabular-nums",
                    deadlineUrgency(daysUntil(op.deadline)).className
                  )}
                >
                  <Clock className="size-3" aria-hidden />
                  {deadlineUrgency(daysUntil(op.deadline)).label}
                </Badge>
              )}
              {/* v0.4.1: watchlist star — pin this opportunity for later */}
              <span className="ml-auto flex items-center">
                <WatchStar
                  id={op.id}
                  watched={
                    (op as { watched?: boolean }).watched ?? false
                  }
                  size="md"
                />
              </span>
            </div>
          )}
        </SheetHeader>

        {error ? (
          <div className="p-4 text-sm text-destructive">{String(error)}</div>
        ) : null}

        <ScrollArea className="scrollbar-thin flex-1">
          <div className="flex flex-col gap-6 p-4">
            {/* Reward + scores row */}
            {isLoading || !op ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric label="Reward (USD)" value={formatUsd(rewardUsd)} />
                <Metric label="Est. Hours" value={`${op.estimatedHours.toFixed(1)}h`} />
                <Metric
                  label="Expected Hourly"
                  value={formatUsd(op.expectedHourly)}
                />
                <Metric
                  label="Risk-Adj. Hourly"
                  value={formatUsd(op.riskAdjustedHourly)}
                />
                <div className="col-span-2 sm:col-span-2">
                  <div className="text-xs text-muted-foreground">Risk Score</div>
                  <ScoreBar value={op.riskScore} kind="risk" showValue />
                </div>
                <div className="col-span-2 sm:col-span-2">
                  <div className="text-xs text-muted-foreground">Verification Score</div>
                  <ScoreBar value={op.verificationScore} kind="verification" showValue />
                </div>
              </section>
            )}

            {/* Description */}
            {op ? (
              <section>
                <h3 className="mb-2 text-sm font-semibold">Description</h3>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {op.description || "No description available."}
                </p>
              </section>
            ) : null}

            {/* Requirements / skills */}
            {op ? (
              <section className="grid gap-4 sm:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Requirements</h3>
                  {requirements.length === 0 ? (
                    <p className="text-xs text-muted-foreground">None listed.</p>
                  ) : (
                    <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                      {requirements.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Skills Required</h3>
                  <div className="flex flex-wrap gap-1">
                    {skillsRequired.length === 0 ? (
                      <span className="text-xs text-muted-foreground">None listed.</span>
                    ) : (
                      skillsRequired.map((s) => (
                        <Badge
                          key={s}
                          variant="outline"
                          className="bg-slate-500/10 text-slate-700 dark:text-slate-300"
                        >
                          {s}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
              </section>
            ) : null}

            {/* Actions */}
            {op ? (
              <section className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  className="bg-emerald-600 text-white hover:bg-emerald-600/90"
                  disabled={processMut.isPending}
                  onClick={() => processMut.mutate(op.id)}
                >
                  {processMut.isPending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : null}
                  Process
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={verifyMut.isPending}
                  onClick={() => verifyMut.mutate(op.id)}
                >
                  {verifyMut.isPending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : null}
                  Verify Payment
                </Button>
                {op.sourceUrl ? (
                  <Button asChild size="sm" variant="ghost">
                    <a href={op.sourceUrl} target="_blank" rel="noreferrer noopener">
                      <ExternalLink className="size-3" /> Source
                    </a>
                  </Button>
                ) : null}
              </section>
            ) : null}

            <Separator />

            {/* v0.5.1: LIVE PR status (submitted / awaiting_payment only) */}
            {op && (op.status === "submitted" || op.status === "awaiting_payment") ? (
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                  <GitPullRequest className="size-3.5 text-emerald-500" />
                  Pull Request — Live
                </h3>
                {prStatusQuery.isLoading ? (
                  <Skeleton className="h-20 w-full" />
                ) : prStatusQuery.data?.monitored && prStatusQuery.data.status ? (
                  <div className="rounded-md border border-border/60 bg-card/40 p-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                      {prStatusQuery.data.prUrl ? (
                        <a
                          href={prStatusQuery.data.prUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1 font-mono font-semibold underline decoration-border underline-offset-2 hover:decoration-emerald-500/60"
                        >
                          {prStatusQuery.data.status.repoFullName}#{prStatusQuery.data.status.prNumber}
                          <ExternalLink className="size-3" />
                          <span className="sr-only">open PR on GitHub in a new tab</span>
                        </a>
                      ) : null}
                      <Badge
                        variant="outline"
                        className={cn(
                          prStatusQuery.data.status.merged
                            ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : prStatusQuery.data.status.state === "open"
                            ? "border-sky-500/30 bg-sky-500/15 text-sky-700 dark:text-sky-300"
                            : "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300"
                        )}
                      >
                        {prStatusQuery.data.status.merged
                          ? "Merged"
                          : prStatusQuery.data.status.state === "open"
                          ? "Open"
                          : "Closed"}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn(
                          prStatusQuery.data.status.reviewStatus === "approved"
                            ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : prStatusQuery.data.status.reviewStatus === "changes_requested"
                            ? "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                            : ""
                        )}
                      >
                        {prStatusQuery.data.status.reviewStatus === "none"
                          ? "Awaiting review"
                          : prStatusQuery.data.status.reviewStatus.replace(/_/g, " ")}
                      </Badge>
                      {prStatusQuery.data.status.ciStatus !== "unknown" && (
                        <Badge
                          variant="outline"
                          className={cn(
                            prStatusQuery.data.status.ciStatus === "success"
                              ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                              : prStatusQuery.data.status.ciStatus === "failure"
                              ? "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300"
                              : ""
                          )}
                        >
                          CI · {prStatusQuery.data.status.ciStatus}
                        </Badge>
                      )}
                    </div>
                    {prStatusQuery.data.status.reviewComments.length > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {prStatusQuery.data.status.reviewComments
                          .slice(-2)
                          .map((c, i) => (
                            <p
                              key={i}
                              className="border-l-2 border-border pl-2 text-[11px] leading-snug text-muted-foreground"
                            >
                              <span className="font-semibold text-foreground/80">
                                {c.author} · {c.state.toLowerCase().replace(/_/g, " ")}:
                              </span>{" "}
                              {c.body.slice(0, 200)}
                            </p>
                          ))}
                      </div>
                    )}
                    <p className="mt-2 text-[10px] text-muted-foreground/70">
                      Live from the GitHub API · refreshed every 60s · last check{" "}
                      {prStatusQuery.data.fetchedAt
                        ? formatRelativeTime(prStatusQuery.data.fetchedAt)
                        : "—"}
                    </p>
                  </div>
                ) : (
                  <p className="rounded-md border border-dashed border-border p-2.5 text-xs text-muted-foreground">
                    {prStatusQuery.data?.reason ??
                      prStatusQuery.data?.fetchError?.message ??
                      "Live PR status unavailable right now."}
                  </p>
                )}
              </section>
            ) : null}

            {/* Related tasks */}
            <section>
              <h3 className="mb-2 text-sm font-semibold">
                Related Tasks ({op?.tasks?.length ?? 0})
              </h3>
              <div className="max-h-64 overflow-y-auto scrollbar-thin space-y-1.5">
                {isLoading || !op ? (
                  <Skeleton className="h-8 w-full" />
                ) : op.tasks.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No tasks yet.</p>
                ) : (
                  op.tasks.map((t) => (
                    <div
                      key={t.id}
                      className="rounded-md border border-border/60 bg-card/40 p-2 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium truncate">
                          {t.objective}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn(
                            "capitalize",
                            statusColor(t.status).bg,
                            statusColor(t.status).text,
                            statusColor(t.status).border
                          )}
                        >
                          {statusColor(t.status).label}
                        </Badge>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span>{t.fromAgent} → {t.toAgent}</span>
                        {t.modelId ? <span>· {t.modelId}</span> : null}
                        <span>· {t.tokensUsed} tok</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Related events */}
            <section>
              <h3 className="mb-2 text-sm font-semibold">
                Related Events ({op?.events?.length ?? 0})
              </h3>
              <div className="max-h-64 overflow-y-auto scrollbar-thin space-y-1.5">
                {isLoading || !op ? (
                  <Skeleton className="h-8 w-full" />
                ) : op.events.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No events yet.</p>
                ) : (
                  op.events.slice(0, 30).map((e) => (
                    <div
                      key={e.id}
                      className="rounded-md border border-border/60 bg-card/40 p-2 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{e.event}</span>
                        <Badge
                          variant="outline"
                          className={cn(
                            "capitalize",
                            statusColor(e.level).bg,
                            statusColor(e.level).text,
                            statusColor(e.level).border
                          )}
                        >
                          {e.level}
                        </Badge>
                      </div>
                      <div className="mt-1 text-[10px] text-muted-foreground">
                        {e.agent} · {formatRelativeTime(e.createdAt)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-card/40 p-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** Normalize a Prisma scalar column that may arrive as a JSON-encoded string
 *  ("[\"a\",\"b\"]"), a real array, or null → always a string[]. */
function parseStringArray(value: string[] | string | null | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string");
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
