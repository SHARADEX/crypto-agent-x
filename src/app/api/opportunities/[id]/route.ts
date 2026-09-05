// GET    /api/opportunities/[id]
// PATCH  /api/opportunities/[id]
//
// GET: return a single opportunity (including its related tasks, earnings,
//      transactions, approvals, and events) so the dashboard can render the
//      detail view in one round-trip.
//
// PATCH: operator override — two supported bodies:
//      `{ status?: OpportunityStatus }`  — manually update lifecycle status
//      `{ watched?: boolean }`           — watchlist star/unstar (v0.4.1;
//                                         pure UI state, never touches the
//                                         orchestrator lifecycle).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { logEvent } from "@/lib/agent/events";
import { serializeOpportunity } from "@/lib/agent/serialize";
import type { OpportunityStatus } from "@/lib/agent/types";

export const dynamic = "force-dynamic";

const VALID_STATUSES: ReadonlySet<OpportunityStatus> = new Set([
  "discovered",
  "researching",
  "verified",
  "rejected",
  "queued",
  "planning",
  "approved",
  "executing",
  "executed",
  "submitted", // Phase-3 fix (Issue 10): PR opened, awaiting review/merge.
  "awaiting_payment",
  "needs_improvement",
  "paid",
  "failed",
]);

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    await bootstrapAgent();

    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { error: "Missing opportunity id." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const op = await db.opportunity.findUnique({
      where: { id },
      include: {
        tasks: {
          orderBy: { createdAt: "desc" },
          take: 200,
        },
        earnings: {
          orderBy: { createdAt: "desc" },
          take: 50,
        },
        transactions: {
          orderBy: { createdAt: "desc" },
          take: 50,
        },
        approvals: {
          orderBy: { createdAt: "desc" },
          take: 50,
        },
        events: {
          orderBy: { createdAt: "desc" },
          take: 100,
        },
      },
    });

    if (!op) {
      return NextResponse.json(
        { error: `Opportunity ${id} not found.` },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    // v0.4.1 normalization: emit the SAME canonical shape as the LIST endpoint
    // (nested reward + parsed string arrays) instead of the raw flat Prisma row.
    // The detail sheet keeps shape-tolerant accessors as defense-in-depth.
    const { tasks, earnings, transactions, approvals, events, ...scalars } = op;
    return NextResponse.json(
      {
        opportunity: {
          ...serializeOpportunity(scalars),
          tasks,
          earnings,
          transactions,
          approvals,
          events,
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/opportunities/[id] GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    await bootstrapAgent();

    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { error: "Missing opportunity id." },
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

    // --- Watchlist toggle (v0.4.1) -------------------------------------
    const watched = (body as { watched?: unknown } | null)?.watched;
    if (typeof watched === "boolean") {
      const updatedWatch = await db.opportunity.update({
        where: { id },
        data: { watched, watchedAt: watched ? new Date() : null },
      });
      await logEvent(
        "orchestrator",
        "info",
        watched ? "opportunity_watch_added" : "opportunity_watch_removed",
        { opportunityId: id, title: updatedWatch.title },
        { opportunityId: id }
      );
      return NextResponse.json(
        { opportunity: serializeOpportunity(updatedWatch) },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // --- Status override (original behavior) ----------------------------
    const status = (body as { status?: unknown } | null)?.status;
    if (
      typeof status !== "string" ||
      !VALID_STATUSES.has(status as OpportunityStatus)
    ) {
      return NextResponse.json(
        {
          error:
            "Invalid or missing status. Valid values: discovered, researching, verified, rejected, queued, planning, approved, executing, executed, submitted, awaiting_payment, needs_improvement, paid, failed.",
        },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const existing = await db.opportunity.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing) {
      return NextResponse.json(
        { error: `Opportunity ${id} not found.` },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    const updated = await db.opportunity.update({
      where: { id },
      data: { status: status as OpportunityStatus },
    });

    await logEvent(
      "orchestrator",
      "warn",
      "opportunity_status_overridden",
      {
        opportunityId: id,
        fromStatus: existing.status,
        toStatus: status,
        source: "api/opportunities/[id] PATCH",
      },
      { opportunityId: id }
    );

    return NextResponse.json(
      { opportunity: updated },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/opportunities/[id] PATCH] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
