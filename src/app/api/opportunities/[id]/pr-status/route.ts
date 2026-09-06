// GET /api/opportunities/[id]/pr-status
//
// v0.5.1 Goal Path feature: LIVE PR status for a submitted opportunity.
//
// The PR monitor (monitorSubmittedPRs) only runs during orchestrator cycles
// (every ~4h via GitHub Actions) and records transitions in the event log —
// but the operator checking the dashboard wants "where is my PR RIGHT NOW"
// without waiting for the next cycle. This endpoint resolves the submission's
// PR URL exactly the way the monitor does (Task output → submissionUrl,
// gated by the IdempotencyRecord github-pr ref), then calls fetchPRStatus
// directly against the GitHub API and returns the live state.
//
// Read-only, never mutates opportunity status (that's the monitor's job, so
// lifecycle transitions stay single-sourced and idempotent).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fetchPRStatus } from "@/lib/execution-adapters/monitoring/pr-monitor";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const op = await db.opportunity.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        title: true,
      },
    });
    if (!op) {
      return NextResponse.json(
        { error: "opportunity not found" },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    if (op.status !== "submitted" && op.status !== "awaiting_payment") {
      return NextResponse.json(
        {
          opportunityId: id,
          monitored: false,
          reason: `opportunity is "${op.status}" — live PR status applies to submitted / awaiting_payment opportunities`,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Resolve the PR URL — same path the PR monitor uses.
    const task = await db.task.findFirst({
      where: {
        opportunityId: id,
        toAgent: "execution",
        status: "success",
      },
      orderBy: { completedAt: "desc" },
      select: { output: true },
    });

    let prUrl: string | null = null;
    if (task?.output) {
      try {
        const output = JSON.parse(task.output) as {
          submissionUrl?: string;
          submissionResult?: { submissionUrl?: string };
        };
        prUrl =
          output.submissionUrl ?? output.submissionResult?.submissionUrl ?? null;
      } catch {
        // ignore parse errors
      }
    }

    if (!prUrl) {
      return NextResponse.json(
        {
          opportunityId: id,
          monitored: false,
          reason: "no PR URL recorded for this opportunity (submission was simulated or pre-adoption)",
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const fetched = await fetchPRStatus(prUrl);
    if (!fetched.ok) {
      return NextResponse.json(
        {
          opportunityId: id,
          monitored: true,
          prUrl,
          fetchError: {
            kind: fetched.error.kind,
            message: fetched.error.message,
            retryable: fetched.error.retryable,
          },
        },
        {
          status: fetched.error.retryable ? 503 : 422,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    return NextResponse.json(
      {
        opportunityId: id,
        monitored: true,
        prUrl,
        status: {
          state: fetched.status.state,
          merged: fetched.status.merged,
          mergedAt: fetched.status.mergedAt,
          mergeable: fetched.status.mergeable,
          reviewStatus: fetched.status.reviewStatus,
          ciStatus: fetched.status.ciStatus,
          reviewComments: fetched.status.reviewComments.slice(-5),
          prNumber: fetched.status.prNumber,
          repoFullName: fetched.status.repoFullName,
        },
        fetchedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/opportunities/[id]/pr-status] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
