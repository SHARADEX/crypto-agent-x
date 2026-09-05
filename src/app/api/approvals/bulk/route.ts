// POST /api/approvals/bulk
//
// Apply the same decision to multiple Approval rows at once
// (Phase-3 DEV-REVIEW-4, priority #5).
//
// Operators dealing with a backlog of stale approvals can approve-all
// or reject-all in one action rather than clicking each card.
//
// Request body:
//   {
//     "approvalIds": ["id1", "id2", ...],
//     "decision": "approve" | "reject" | "skip" | "pause",
//     "decidedBy": "operator-name" (optional, defaults to "bulk"),
//     "feedback": "optional feedback applied to all" (optional)
//   }
//
// Response:
//   {
//     "applied": <count>,
//     "skipped": <count>,   // rows that were not in "pending" status
//     "errors": [{ id, error }]  // per-row errors (e.g. not found)
//   }
//
// The endpoint is idempotent: re-running with the same approvalIds
// after they've been decided just reports them as "skipped" (not errors).
//
// Decisions that trigger iteration workflows (improve / rework /
// request_changes) are intentionally NOT supported in bulk — they
// require per-approval feedback + a new TaskIteration, which doesn't
// make sense to batch. The caller must use POST /api/approvals/[id]
// for those.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { logEvent } from "@/lib/agent/events";

export const dynamic = "force-dynamic";

const MAX_BULK = 100;

const BULK_DECISIONS = new Set(["approve", "reject", "skip", "pause"]);

interface BulkRequest {
  approvalIds?: unknown;
  decision?: unknown;
  decidedBy?: unknown;
  feedback?: unknown;
}

export async function POST(req: Request) {
  try {
    await bootstrapAgent();

    let body: BulkRequest;
    try {
      body = (await req.json()) as BulkRequest;
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { approvalIds, decision, decidedBy, feedback } = body;

    // Validate decision.
    if (typeof decision !== "string" || !BULK_DECISIONS.has(decision)) {
      return NextResponse.json(
        {
          error: `Invalid decision. Must be one of: ${Array.from(BULK_DECISIONS).join(", ")}.`,
        },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Validate approvalIds.
    if (!Array.isArray(approvalIds) || approvalIds.length === 0) {
      return NextResponse.json(
        { error: "approvalIds must be a non-empty array." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (approvalIds.length > MAX_BULK) {
      return NextResponse.json(
        { error: `Bulk decision is capped at ${MAX_BULK} approvals per call.` },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }
    const ids = approvalIds.filter(
      (id): id is string => typeof id === "string" && id.length > 0
    );
    if (ids.length !== approvalIds.length) {
      return NextResponse.json(
        { error: "All approvalIds must be non-empty strings." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const actor =
      typeof decidedBy === "string" && decidedBy.length > 0
        ? decidedBy
        : "bulk";

    // Map the decision to the Approval.status value.
    // "approve" → "approved", "reject" → "rejected", "skip" → "skip",
    // "pause" → "pause".
    const statusMap: Record<string, string> = {
      approve: "approved",
      reject: "rejected",
      skip: "skip",
      pause: "pause",
    };
    const targetStatus = statusMap[decision];

    // Fetch all the approvals in one query so we can report per-row outcomes.
    const approvals = await db.approval.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, opportunityId: true },
    });

    const applied: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    const errors: Array<{ id: string; error: string }> = [];

    // Find IDs that don't exist.
    const foundIds = new Set(approvals.map((a) => a.id));
    for (const id of ids) {
      if (!foundIds.has(id)) {
        errors.push({ id, error: "Approval not found." });
      }
    }

    // Apply the decision to each found approval.
    for (const approval of approvals) {
      if (approval.status !== "pending") {
        skipped.push({
          id: approval.id,
          reason: `not pending (current status: ${approval.status})`,
        });
        continue;
      }
      try {
        await db.approval.update({
          where: { id: approval.id },
          data: {
            status: targetStatus,
            decidedAt: new Date(),
            decidedBy: actor,
            feedback:
              typeof feedback === "string" && feedback.length > 0
                ? feedback
                : undefined,
          },
        });
        applied.push(approval.id);
      } catch (err) {
        errors.push({
          id: approval.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Log the bulk action as a single event (rather than one per approval)
    // so the event log isn't flooded.
    await logEvent(
      "orchestrator",
      "info",
      `approval_bulk_${decision}d`,
      {
        applied: applied.length,
        skipped: skipped.length,
        errors: errors.length,
        decision,
        decidedBy: actor,
        approvalIds: applied,
      },
      {}
    ).catch(() => null);

    // Phase-3 DEV-REVIEW-5 (#5): when the decision is "approve", trigger
    // processOpportunity for each approved opportunity so the execution
    // agent picks it up immediately rather than waiting for the next
    // orchestrator cycle. This is non-blocking — errors are logged but
    // don't fail the bulk response (the approval is already recorded).
    let triggered = 0;
    if (decision === "approve" && applied.length > 0) {
      try {
        const { processOpportunity } = await import(
          "@/lib/orchestrator/orchestrator"
        );
        // Fetch the approved approvals' opportunityIds (we already have
        // them from the earlier findMany, but filter to only the applied ones).
        const approvedRows = approvals.filter(
          (a) => applied.includes(a.id) && a.opportunityId
        );
        for (const row of approvedRows) {
          try {
            await processOpportunity(row.opportunityId!);
            triggered++;
          } catch (err) {
            // Non-fatal — the orchestrator loop will pick it up on the
            // next cycle. Log + continue.
            console.error(
              `[api/approvals/bulk] processOpportunity ${row.opportunityId} failed:`,
              err
            );
          }
        }
      } catch (err) {
        // If the dynamic import fails (e.g. module not found), log + continue.
        console.error(
          "[api/approvals/bulk] failed to trigger processOpportunity:",
          err
        );
      }
    }

    return NextResponse.json(
      {
        applied: applied.length,
        skipped: skipped.length,
        errors,
        appliedIds: applied,
        skippedRows: skipped,
        triggered, // Phase-3 DEV-REVIEW-5 (#5): count of opportunities queued for immediate execution.
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/approvals/bulk POST] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
