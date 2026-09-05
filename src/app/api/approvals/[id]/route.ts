// POST /api/approvals/[id]
//
// Record an operator decision on a pending Approval row. Body (Phase 3 §4, §6,
// §32):
//
//   - decision              : "approve" | "reject" | "improve" | "rework"
//                             | "request_changes" | "ask_agent" | "skip"
//                             | "pause"
//   - feedback?            : free-text feedback from the human
//   - feedbackType?        : ui | functionality | bugs | performance | visuals
//                            | gameplay | security | documentation | code_quality
//                            | requirements_mismatch | missing_feature | other
//   - feedbackPriority?    : low | medium | high | critical
//   - feedbackTargetAreas?: string[] — file/area paths the feedback targets
//   - decidedBy?           : free-form operator identifier (default "operator")
//   - reasonCategory?      : for "reject" — Phase 3 §32 reason category
//                            (scam | not_worth_it | already_done | duplicate
//                            | out_of_scope | insufficient_info | other)
//
// Side effects:
//   - The Approval row's `status` / `decidedAt` / `decidedBy` + the feedback
//     fields are updated.
//   - The decision is logged via `logEvent` for the audit trail.
//   - On "approve": the related opportunity (if any) is queued for execution
//     via `queueForExecution(opportunityId)`.
//   - On "improve" | "rework" | "request_changes": a new TaskIteration is
//     created on the related Task (linked to this Approval via feedbackId),
//     the ImprovementPlanner produces a plan, the Opportunity is moved to
//     `needs_improvement` status, and the plan + iteration are returned so
//     the dashboard can show what happens next.
//   - On "pause": the Opportunity is left in its current status but a
//     PAUSE marker is recorded; the operator can resume from the dashboard.
//
// NEVER throws — always returns a result object.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { logEvent } from "@/lib/agent/events";
import { queueForExecution } from "@/lib/orchestrator/orchestrator";
import {
  createIteration,
  type IterationRow,
} from "@/lib/iteration/iteration-service";
import {
  planImprovement,
  type FeedbackType,
  type FeedbackPriority,
  type ImprovementPlan,
  type PlanResult,
} from "@/lib/iteration/improvement-planner";

export const dynamic = "force-dynamic";

const VALID_DECISIONS = new Set([
  "approve",
  "reject",
  "improve",
  "rework",
  "request_changes",
  "ask_agent",
  "skip",
  "pause",
]);

const VALID_FEEDBACK_TYPES = new Set([
  "ui",
  "functionality",
  "bugs",
  "performance",
  "visuals",
  "gameplay",
  "security",
  "documentation",
  "code_quality",
  "requirements_mismatch",
  "missing_feature",
  "other",
]);

const VALID_FEEDBACK_PRIORITIES = new Set([
  "low",
  "medium",
  "high",
  "critical",
]);

const VALID_REASON_CATEGORIES = new Set([
  "scam",
  "not_worth_it",
  "already_done",
  "duplicate",
  "out_of_scope",
  "insufficient_info",
  "other",
]);

/**
 * Map a request `decision` to the Approval row's `status` value.
 *
 * The schema's status enum (prisma/schema.prisma model Approval) is:
 *   pending | approved | rejected | improve | rework | request_changes
 *   | ask_agent | skip | pause
 *
 * The route's `decision` field uses the verb form ("approve"/"reject") while
 * the status field uses the past-tense form ("approved"/"rejected"). The
 * other decisions (improve / rework / request_changes / ask_agent / skip /
 * pause) are already past-tense-equivalent and pass through unchanged.
 *
 * P0-5 fix: previously this route stored `status = decision` verbatim, which
 * meant decision="approve" wrote status="approve" (NOT "approved"). The
 * execution agent's approval gate (`execution-agent.ts:167`) looks for
 * `status: "approved"` — so it would NEVER find an approval created via
 * this route, blocking execution forever. The bulk route
 * (`/api/approvals/bulk/route.ts:108-114`) already does this mapping
 * correctly; this brings the single-approval route in line.
 */
const DECISION_TO_STATUS: Record<string, string> = {
  approve: "approved",
  reject: "rejected",
  improve: "improve",
  rework: "rework",
  request_changes: "request_changes",
  ask_agent: "ask_agent",
  skip: "skip",
  pause: "pause",
};

/** Decisions that trigger a new iteration loop (Phase 3 §6). */
const ITERATION_DECISIONS = new Set(["improve", "rework", "request_changes"]);

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface DecisionResponseBody {
  approval: unknown;
  queueResult?: { queued: boolean; requiresApproval: boolean; reason: string };
  iteration?: IterationRow;
  plan?: ImprovementPlan;
  planError?: string;
  reasonCategory?: string;
  canIterate?: boolean;
  iterationError?: string;
  /** Phase-3 fix: true when we rolled the Approval back to "pending"
   *  because createIteration failed (so the operator can retry). */
  rolledBackToPending?: boolean;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    await bootstrapAgent();

    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { error: "Missing approval id." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const bodyObj = (body as Record<string, unknown> | null) ?? {};
    const decision = typeof bodyObj.decision === "string" ? bodyObj.decision : "";
    if (!VALID_DECISIONS.has(decision)) {
      return NextResponse.json(
        {
          error:
            "Invalid decision. Must be one of: approve | reject | improve | rework | request_changes | ask_agent | skip | pause.",
        },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const decidedBy =
      typeof bodyObj.decidedBy === "string"
        ? bodyObj.decidedBy.trim() || "operator"
        : "operator";

    const feedback =
      typeof bodyObj.feedback === "string" ? bodyObj.feedback : null;

    const feedbackType =
      typeof bodyObj.feedbackType === "string" &&
      VALID_FEEDBACK_TYPES.has(bodyObj.feedbackType)
        ? (bodyObj.feedbackType as FeedbackType)
        : null;

    const feedbackPriority =
      typeof bodyObj.feedbackPriority === "string" &&
      VALID_FEEDBACK_PRIORITIES.has(bodyObj.feedbackPriority)
        ? (bodyObj.feedbackPriority as FeedbackPriority)
        : null;

    const feedbackTargetAreasRaw = bodyObj.feedbackTargetAreas;
    const feedbackTargetAreas: string[] | null = Array.isArray(
      feedbackTargetAreasRaw
    )
      ? feedbackTargetAreasRaw.filter(
          (x): x is string => typeof x === "string" && x.length > 0
        )
      : null;

    const reasonCategory =
      typeof bodyObj.reasonCategory === "string" &&
      VALID_REASON_CATEGORIES.has(bodyObj.reasonCategory)
        ? bodyObj.reasonCategory
        : null;

    // --- Validate feedback requirements for iteration decisions -------------
    if (ITERATION_DECISIONS.has(decision)) {
      if (!feedback || feedback.trim().length === 0) {
        return NextResponse.json(
          {
            error: `Decision '${decision}' requires non-empty 'feedback' text.`,
          },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
      if (!feedbackType) {
        return NextResponse.json(
          {
            error: `Decision '${decision}' requires a 'feedbackType' (one of: ${Array.from(
              VALID_FEEDBACK_TYPES
            ).join(" | ")}).`,
          },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
      if (!feedbackPriority) {
        return NextResponse.json(
          {
            error: `Decision '${decision}' requires a 'feedbackPriority' (one of: ${Array.from(
              VALID_FEEDBACK_PRIORITIES
            ).join(" | ")}).`,
          },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
    }

    // For "reject" — strongly prefer a reason category (Phase 3 §32). We
    // don't hard-require it (the operator may want to reject quickly), but
    // we surface a warning when it's missing.
    if (decision === "reject" && !reasonCategory) {
      // Soft warning — proceed but record the missing category.
      console.warn(
        `[api/approvals/[id]] reject without reasonCategory for approval ${id}`
      );
    }

    // --- Load the existing Approval row -------------------------------------
    const existing = await db.approval.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        opportunityId: true,
        taskId: true,
        decidedAt: true,
      },
    });
    if (!existing) {
      return NextResponse.json(
        { error: `Approval ${id} not found.` },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    // --- Update the Approval row with the new status + feedback ------------
    // P0-5 fix: map the decision verb to the schema's past-tense status
    // (approve → approved, reject → rejected). The other decisions pass
    // through unchanged. See DECISION_TO_STATUS above.
    const updateData: Record<string, unknown> = {
      status: DECISION_TO_STATUS[decision] ?? decision,
      decidedAt: new Date(),
      decidedBy,
    };
    if (feedback !== null) updateData.feedback = feedback;
    if (feedbackType !== null) updateData.feedbackType = feedbackType;
    if (feedbackPriority !== null)
      updateData.feedbackPriority = feedbackPriority;
    if (feedbackTargetAreas !== null) {
      updateData.feedbackTargetAreas = JSON.stringify(feedbackTargetAreas);
    }
    if (reasonCategory !== null) {
      // Stash the reject reason category in the feedback text if no
      // explicit feedback was provided, so the audit trail records why.
      if (!feedback) {
        updateData.feedback = `reject_reason:${reasonCategory}`;
      }
      updateData.feedbackType = updateData.feedbackType ?? "other";
    }

    const updated = await db.approval.update({
      where: { id },
      data: updateData,
    });

    await logEvent(
      "orchestrator",
      decision === "approve" ? "info" : "warn",
      `approval_${decision}d`,
      {
        approvalId: id,
        opportunityId: existing.opportunityId ?? null,
        taskId: existing.taskId ?? null,
        decidedBy,
        previousStatus: existing.status,
        feedback: feedback ?? null,
        feedbackType: feedbackType ?? null,
        feedbackPriority: feedbackPriority ?? null,
        feedbackTargetAreas: feedbackTargetAreas ?? null,
        reasonCategory: reasonCategory ?? null,
      },
      existing.opportunityId
        ? { opportunityId: existing.opportunityId }
        : undefined
    );

    const responseBody: DecisionResponseBody = { approval: updated };

    // --- "approve" — queue for execution (existing flow) -------------------
    if (decision === "approve" && existing.opportunityId) {
      try {
        responseBody.queueResult = await queueForExecution(
          existing.opportunityId
        );
      } catch (err) {
        console.error("[api/approvals/[id]] queueForExecution failed:", err);
        responseBody.queueResult = {
          queued: false,
          requiresApproval: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // --- "pause" — write a PAUSE marker so the kill switch picks it up ----
    if (decision === "pause") {
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const markerPath = path.join(process.cwd(), "PAUSE");
        fs.writeFileSync(
          markerPath,
          JSON.stringify(
            {
              reason: feedback ?? "operator paused via approval decision",
              approvalId: id,
              decidedBy,
              at: new Date().toISOString(),
            },
            null,
            2
          ),
          "utf-8"
        );
      } catch (err) {
        console.error("[api/approvals/[id]] pause marker write failed:", err);
      }
    }

    // --- "improve" / "rework" / "request_changes" — start a new iteration --
    if (ITERATION_DECISIONS.has(decision)) {
      const taskId = existing.taskId;
      if (!taskId) {
        responseBody.iterationError =
          "Approval has no linked taskId — cannot start an iteration.";
      } else {
        // Check the iteration cap before creating a new iteration.
        const { canIterate } = await import("@/lib/iteration/iteration-service");
        const gate = await canIterate(taskId);
        if (!gate.ok) {
          responseBody.iterationError = gate.error ?? "canIterate check failed";
        } else if (!gate.data?.canIterate) {
          responseBody.canIterate = false;
          responseBody.iterationError = `Iteration cap reached (${gate.data?.iterationCount}/${gate.data?.maxIterations}) — cannot start another iteration.`;
          // Mark the opportunity as failed — the agent cannot improve this
          // deliverable any further.
          if (existing.opportunityId) {
            try {
              await db.opportunity.update({
                where: { id: existing.opportunityId },
                data: { status: "failed" },
              });
            } catch (err) {
              console.error(
                "[api/approvals/[id]] failed-to-failed update threw:",
                err
              );
            }
          }
        } else {
          responseBody.canIterate = true;
          const iteration = await createIteration({
            taskId,
            feedbackId: id,
            feedbackText: feedback ?? undefined,
            feedbackType: feedbackType ?? undefined,
            feedbackPriority: feedbackPriority ?? undefined,
          });
          if (!iteration.ok || !iteration.data) {
            responseBody.iterationError =
              iteration.error ?? "createIteration returned no data";
            // Phase-3 fix: roll back the Approval status to "pending" so
            // the operator can retry the decision. Without this rollback,
            // the Approval would be stuck in "improve" status with the
            // feedback saved but no iteration created — the opportunity
            // would never transition to needs_improvement and the
            // feedback would be orphaned (the Approval disappears from
            // the default pending queue, so the operator can't retry).
            try {
              await db.approval.update({
                where: { id },
                data: {
                  status: "pending",
                  decidedAt: null,
                  decidedBy: null,
                },
              });
              responseBody.rolledBackToPending = true;
            } catch (rollbackErr) {
              console.error(
                "[api/approvals/[id]] rollback-to-pending failed:",
                rollbackErr
              );
            }
            await logEvent(
              "orchestrator",
              "error",
              "iteration_creation_failed",
              {
                approvalId: id,
                taskId,
                error: responseBody.iterationError,
                rolledBackToPending: responseBody.rolledBackToPending === true,
              },
              { taskId, opportunityId: existing.opportunityId ?? undefined }
            ).catch(() => null);
          } else {
            responseBody.iteration = iteration.data;

            // Plan the improvement (Phase 3 §27).
            const planInput: Parameters<typeof planImprovement>[0] = {
              taskId,
              feedback: feedback ?? "",
              feedbackType: feedbackType ?? "other",
              feedbackPriority: feedbackPriority ?? "medium",
            };
            if (feedbackTargetAreas && feedbackTargetAreas.length > 0) {
              planInput.feedbackTargetAreas = feedbackTargetAreas;
            }
            const planResult: PlanResult = await planImprovement(planInput);
            if (!planResult.ok || !planResult.plan) {
              responseBody.planError =
                planResult.error ?? "planImprovement returned no plan";
            } else {
              responseBody.plan = planResult.plan;
            }

            // Move the Opportunity into the `needs_improvement` state so
            // the orchestrator picks it up + routes back to the deliverable
            // specialist with the new iteration's feedback context.
            if (existing.opportunityId) {
              try {
                await db.opportunity.update({
                  where: { id: existing.opportunityId },
                  data: { status: "needs_improvement" },
                });
              } catch (err) {
                console.error(
                  "[api/approvals/[id]] opportunity needs_improvement update failed:",
                  err
                );
              }
            }
          }
        }
      }
    }

    // --- "reject" — record the reason category on the Opportunity ---------
    if (decision === "reject" && existing.opportunityId) {
      try {
        await db.opportunity.update({
          where: { id: existing.opportunityId },
          data: { status: "rejected" },
        });
      } catch (err) {
        console.error(
          "[api/approvals/[id]] opportunity rejected update failed:",
          err
        );
      }
      responseBody.reasonCategory = reasonCategory ?? "other";
    }

    // --- "ask_agent" — surface to the orchestrator as a question ----------
    // We don't dispatch immediately; we just record the question on the
    // approval + log it. The dashboard's "Ask Agent" panel will pick it up.
    if (decision === "ask_agent") {
      await logEvent(
        "orchestrator",
        "info",
        "approval_ask_agent",
        {
          approvalId: id,
          opportunityId: existing.opportunityId ?? null,
          taskId: existing.taskId ?? null,
          question: feedback ?? "(no question provided)",
          decidedBy,
        },
        existing.opportunityId
          ? { opportunityId: existing.opportunityId }
          : undefined
      );
    }

    return NextResponse.json(responseBody, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[api/approvals/[id] POST] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
