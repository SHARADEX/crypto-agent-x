// PR Monitoring — polls GitHub PR status after submission (Phase 3.1 §10, §27).
//
// After the GithubPrAdapter opens a PR, the agent needs to monitor its status:
//   - Is it OPEN, CLOSED, or MERGED?
//   - Has a reviewer requested changes?
//   - Is CI passing?
//
// If the PR receives review feedback (changes requested), the system creates
// a new task iteration (Phase 3.1 §27) so the coding agent can address the
// feedback.
//
// This module polls the GitHub REST API for PR status. It's called by the
// orchestrator loop on each cycle for opportunities in "submitted" status.

import { logEvent } from "@/lib/agent/events";
import { db } from "@/lib/db";

const GITHUB_API = "https://api.github.com";

// Phase-3 fix: per-PR consecutive-transient-failure counter. After
// MAX_TRANSIENT_FAILURES cycles of 403/429/5xx/network errors on the same
// PR, we mark the opportunity as `failed` so we stop wasting API quota
// polling a PR that's never going to resolve. Persisted across restarts
// would require a schema field; for now we use a module-level Map (cleared
// on process restart, which is acceptable — the counter rebuilds from zero
// and the operator can see the failures in the event log).
const MAX_TRANSIENT_FAILURES = 10;
const transientFailureCounts = new Map<string, number>();

export interface PRStatus {
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  mergeable: boolean | null;
  reviewStatus: "none" | "approved" | "changes_requested" | "commented";
  ciStatus: "unknown" | "pending" | "success" | "failure";
  reviewComments: Array<{
    author: string;
    body: string;
    state: string; // APPROVED, CHANGES_REQUESTED, COMMENTED, PENDING
    submittedAt: string;
  }>;
  prUrl: string;
  prNumber: number;
  repoFullName: string;
}

// Phase-3 fix: structured fetch error so the caller can distinguish
// permanent failures (404 PR deleted, 401 bad token) from transient ones
// (429 rate limit, 5xx GitHub down, network timeout) and act accordingly.
export interface PRFetchError {
  kind:
    | "not_found" // 404 — PR deleted / never existed → permanent
    | "auth" // 401/403 — bad token / forbidden → permanent (operator fix)
    | "rate_limited" // 429 — transient, back off
    | "server_error" // 5xx — transient, GitHub down
    | "network" // fetch threw — transient
    | "unknown"; // other HTTP status
  httpStatus?: number;
  message: string;
  retryable: boolean;
}

/**
 * Parse a GitHub PR URL into owner/repo/number.
 * Example: https://github.com/owner/repo/pull/123 → { owner: "owner", repo: "repo", number: 123 }
 */
function parsePrUrl(
  prUrl: string
): { owner: string; repo: string; number: number } | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

/**
 * Fetch the current status of a GitHub PR.
 * Requires GITHUB_TOKEN for API authentication.
 *
 * Phase-3 fix: returns a discriminated union instead of bare `null` so the
 * caller can distinguish permanent failures (404/401 → mark opportunity
 * failed) from transient ones (429/5xx/network → skip this cycle).
 */
export async function fetchPRStatus(
  prUrl: string
): Promise<{ ok: true; status: PRStatus } | { ok: false; error: PRFetchError }> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      ok: false,
      error: {
        kind: "auth",
        message: "GITHUB_TOKEN env var is not set — cannot authenticate to GitHub API",
        retryable: false,
      },
    };
  }

  const parsed = parsePrUrl(prUrl);
  if (!parsed) {
    return {
      ok: false,
      error: {
        kind: "unknown",
        message: `Could not parse PR URL: ${prUrl}`,
        retryable: false,
      },
    };
  }

  const { owner, repo, number } = parsed;

  try {
    // 1. Fetch the PR itself.
    const prResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!prResponse.ok) {
      // Phase-3 fix: classify the HTTP error so the caller can decide
      // whether to retry, mark failed, or alert the operator.
      const body = await prResponse.text().catch(() => "");
      const kind: PRFetchError["kind"] =
        prResponse.status === 404 ? "not_found"
        : prResponse.status === 401 || prResponse.status === 403 ? "auth"
        : prResponse.status === 429 ? "rate_limited"
        : prResponse.status >= 500 ? "server_error"
        : "unknown";
      // `network` can't occur here (we're in the HTTP-response-received path);
      // network errors throw + are caught by the outer try/catch which returns
      // kind="network". So retryable is computed from the HTTP kinds only.
      const retryable = kind === "rate_limited" || kind === "server_error";
      return {
        ok: false,
        error: {
          kind,
          httpStatus: prResponse.status,
          message: `GitHub API returned ${prResponse.status}: ${body.slice(0, 200)}`,
          retryable,
        },
      };
    }

    const prData = await prResponse.json() as {
      state: string;
      merged: boolean;
      merged_at: string | null;
      mergeable: boolean | null;
      html_url: string;
      number: number;
      head: { ref: string; sha: string };
    };

    // 2. Fetch review comments.
    const reviewsResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/reviews`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10_000),
      }
    );

    let reviews: PRStatus["reviewComments"] = [];
    if (reviewsResponse.ok) {
      const reviewsData = (await reviewsResponse.json()) as Array<{
        user: { login: string };
        body: string;
        state: string;
        submitted_at: string;
      }>;
      reviews = reviewsData.map((r) => ({
        author: r.user?.login ?? "unknown",
        body: r.body ?? "",
        state: r.state,
        submittedAt: r.submitted_at,
      }));
    }

    // 3. Fetch CI status (check runs on the head SHA).
    let ciStatus: PRStatus["ciStatus"] = "unknown";
    try {
      const ciResponse = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/commits/${prData.head.sha}/check-runs`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (ciResponse.ok) {
        const ciData = (await ciResponse.json()) as {
          check_runs: Array<{ status: string; conclusion: string | null }>;
        };
        if (ciData.check_runs && ciData.check_runs.length > 0) {
          const allCompleted = ciData.check_runs.every(
            (r) => r.status === "completed"
          );
          if (!allCompleted) {
            ciStatus = "pending";
          } else {
            const allPassed = ciData.check_runs.every(
              (r) => r.conclusion === "success"
            );
            ciStatus = allPassed ? "success" : "failure";
          }
        }
      }
    } catch {
      // CI status is best-effort.
    }

    // Determine the review status.
    let reviewStatus: PRStatus["reviewStatus"] = "none";
    if (reviews.length > 0) {
      const latestReview = reviews[reviews.length - 1];
      if (latestReview.state === "APPROVED") {
        reviewStatus = "approved";
      } else if (latestReview.state === "CHANGES_REQUESTED") {
        reviewStatus = "changes_requested";
      } else {
        reviewStatus = "commented";
      }
    }

    return {
      ok: true as const,
      status: {
        state: prData.state as "open" | "closed",
        merged: prData.merged,
        mergedAt: prData.merged_at,
        mergeable: prData.mergeable,
        reviewStatus,
        ciStatus,
        reviewComments: reviews,
        prUrl: prData.html_url ?? prUrl,
        prNumber: prData.number,
        repoFullName: `${owner}/${repo}`,
      },
    };
  } catch (err) {
    // Network error / timeout / abort — transient.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[pr-monitor] fetchPRStatus failed:", message);
    return {
      ok: false,
      error: {
        kind: "network",
        message,
        retryable: true,
      },
    };
  }
}

/**
 * Monitor all opportunities in "submitted" status + update their state
 * based on the PR's current status. Called by the orchestrator loop.
 *
 * Phase 3.1 §27: if a PR receives "changes_requested" review feedback,
 * the opportunity transitions to "needs_improvement" + a new task iteration
 * is triggered (handled by the orchestrator, not here — this function just
 * updates the opportunity status + logs the event).
 */
export async function monitorSubmittedPRs(): Promise<{
  checked: number;
  merged: number;
  changesRequested: number;
  closed: number;
  errors: number;
}> {
  const result = { checked: 0, merged: 0, changesRequested: 0, closed: 0, errors: 0 };

  try {
    // Phase-3 fix (Issue 10): poll opportunities in "submitted" status (PR
    // opened, awaiting review/merge). Previously this polled
    // "awaiting_payment" — but the orchestrator prematurely set
    // awaiting_payment on review acceptance, so the monitor's merged
    // branch was a no-op. Now the orchestrator sets "submitted" on review
    // acceptance, and ONLY this monitor transitions submitted →
    // awaiting_payment when the PR is actually merged.
    const opportunities = await db.opportunity.findMany({
      where: { status: "submitted" },
      select: {
        id: true,
        title: true,
        sourceUrl: true,
      },
      take: 50, // cap per cycle
    });

    for (const opp of opportunities) {
      result.checked++;

      // Find the submission's external reference (PR URL).
      // The execution agent stores it on the Task output or the IdempotencyRecord.
      const idemRecord = await db.idempotencyRecord.findFirst({
        where: {
          opportunityId: opp.id,
          status: "completed",
        },
        orderBy: { completedAt: "desc" },
      });

      const externalRef = idemRecord?.externalRef;
      if (!externalRef || !externalRef.startsWith("github-pr:")) {
        continue; // Not a GitHub PR submission.
      }

      // The externalRef format is "github-pr:<pr_number>" — but the actual
      // PR URL is stored in the submission result. For monitoring, we need
      // the full URL. Let's reconstruct it from the sourceUrl (the issue URL).
      // Actually, the GithubPrAdapter stores the PR URL in the Task output.
      const task = await db.task.findFirst({
        where: {
          opportunityId: opp.id,
          toAgent: "execution",
          status: "success",
        },
        orderBy: { completedAt: "desc" },
      });

      let prUrl: string | null = null;
      if (task?.output) {
        try {
          const output = JSON.parse(task.output) as {
            submissionUrl?: string;
            submissionResult?: { submissionUrl?: string };
          };
          prUrl =
            output.submissionUrl ??
            output.submissionResult?.submissionUrl ??
            null;
        } catch {
          // ignore parse errors
        }
      }

      if (!prUrl) {
        continue; // Can't monitor without a PR URL.
      }

      const status = await fetchPRStatus(prUrl);
      if (!status.ok) {
        // Phase-3 fix: classify the error + act appropriately.
        // Permanent errors (404 PR deleted, 401/403 bad token) → mark the
        // opportunity as `failed` and stop polling it.
        // Transient errors (429 rate limit, 5xx, network) → increment the
        // per-PR failure counter; after MAX_TRANSIENT_FAILURES consecutive
        // transient failures, mark `failed`. Otherwise just log + skip.
        const err = status.error;
        const isPermanent = !err.retryable;
        const consecutive = (transientFailureCounts.get(opp.id) ?? 0) + 1;

        if (isPermanent) {
          // 404 / 401 / 403 / parse failure — this PR is never going to resolve.
          transientFailureCounts.delete(opp.id);
          await db.opportunity.update({
            where: { id: opp.id },
            data: { status: "failed" },
          });
          result.errors++;
          result.closed++; // count as "closed" for the summary
          await logEvent(
            "execution",
            "error",
            "pr_monitor_permanent_error",
            {
              opportunityId: opp.id,
              prUrl,
              errorKind: err.kind,
              httpStatus: err.httpStatus ?? null,
              message: err.message,
            },
            { opportunityId: opp.id }
          );
        } else {
          // Transient — increment counter, log, and only fail after N cycles.
          transientFailureCounts.set(opp.id, consecutive);
          if (consecutive >= MAX_TRANSIENT_FAILURES) {
            await db.opportunity.update({
              where: { id: opp.id },
              data: { status: "failed" },
            });
            transientFailureCounts.delete(opp.id);
            result.errors++;
            result.closed++;
            await logEvent(
              "execution",
              "error",
              "pr_monitor_max_retries_exceeded",
              {
                opportunityId: opp.id,
                prUrl,
                consecutiveFailures: consecutive,
                lastErrorKind: err.kind,
                lastError: err.message,
              },
              { opportunityId: opp.id }
            );
          } else {
            result.errors++;
            await logEvent(
              "execution",
              "warn",
              "pr_monitor_transient_error",
              {
                opportunityId: opp.id,
                prUrl,
                errorKind: err.kind,
                httpStatus: err.httpStatus ?? null,
                consecutiveFailures: consecutive,
                maxRetries: MAX_TRANSIENT_FAILURES,
                message: err.message,
              },
              { opportunityId: opp.id }
            );
          }
        }
        continue;
      }

      // Success — reset the transient failure counter.
      transientFailureCounts.delete(opp.id);
      const prStatus = status.status;

      // Update the opportunity based on the PR status.
      if (prStatus.merged) {
        // PR was merged → transition submitted → awaiting_payment.
        // Phase-3 fix (Issue 10): this is now a REAL transition (was a
        // no-op when the orchestrator already set awaiting_payment on
        // review acceptance).
        await db.opportunity.update({
          where: { id: opp.id },
          data: { status: "awaiting_payment" },
        });
        result.merged++;
        await logEvent(
          "execution",
          "info",
          "pr_merged",
          {
            opportunityId: opp.id,
            prUrl: prStatus.prUrl,
            mergedAt: prStatus.mergedAt,
          },
          { opportunityId: opp.id }
        );
      } else if (prStatus.state === "closed" && !prStatus.merged) {
        // PR was closed without merge → transition to failed.
        await db.opportunity.update({
          where: { id: opp.id },
          data: { status: "failed" },
        });
        result.closed++;
        await logEvent(
          "execution",
          "warn",
          "pr_closed_without_merge",
          {
            opportunityId: opp.id,
            prUrl: prStatus.prUrl,
          },
          { opportunityId: opp.id }
        );
      } else if (prStatus.reviewStatus === "changes_requested") {
        // Reviewer requested changes → transition to needs_improvement.
        await db.opportunity.update({
          where: { id: opp.id },
          data: { status: "needs_improvement" },
        });
        result.changesRequested++;
        await logEvent(
          "execution",
          "warn",
          "pr_changes_requested",
          {
            opportunityId: opp.id,
            prUrl: prStatus.prUrl,
            reviews: prStatus.reviewComments,
          },
          { opportunityId: opp.id }
        );
      } else {
        // PR is still open, no changes requested — just log the status.
        await logEvent(
          "execution",
          "info",
          "pr_status_check",
          {
            opportunityId: opp.id,
            prUrl: prStatus.prUrl,
            state: prStatus.state,
            reviewStatus: prStatus.reviewStatus,
            ciStatus: prStatus.ciStatus,
          },
          { opportunityId: opp.id }
        );
      }
    }

    return result;
  } catch (err) {
    console.error("[pr-monitor] monitorSubmittedPRs failed:", err);
    return result;
  }
}
