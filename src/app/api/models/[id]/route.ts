// PATCH /api/models/[id]
//
// Update a model record's role / enabled flag / health status. Used by the
// operator dashboard to:
//   - enable / disable a model
//   - assign it a routing role (primary / secondary / reviewer / etc.)
//   - mark it healthy / degraded / unhealthy / blacklisted
//
// Body: `{ role?: ModelRole, enabled?: boolean, status?: ModelStatus }`.
// Returns the updated ModelRecord (with deserialized JSON fields).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import {
  getModel,
  rowToModelRecord,
  setModelRole,
  setModelStatus,
} from "@/lib/llm/registry";
import { logEvent } from "@/lib/agent/events";
import type { ModelRole, ModelStatus } from "@/lib/agent/types";

export const dynamic = "force-dynamic";

const VALID_ROLES = new Set<ModelRole>([
  "primary",
  "secondary",
  "reviewer",
  "exploration",
  "disabled",
]);
const VALID_STATUSES = new Set<ModelStatus>([
  "healthy",
  "degraded",
  "unhealthy",
  "blacklisted",
]);

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    await bootstrapAgent();

    const { id: modelId } = await params;
    if (!modelId) {
      return NextResponse.json(
        { error: "Missing model id." },
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

    const b = body as {
      role?: unknown;
      enabled?: unknown;
      status?: unknown;
    } | null;

    const role =
      typeof b?.role === "string" && VALID_ROLES.has(b.role as ModelRole)
        ? (b.role as ModelRole)
        : undefined;
    const enabled =
      typeof b?.enabled === "boolean" ? b.enabled : undefined;
    const status =
      typeof b?.status === "string" &&
      VALID_STATUSES.has(b.status as ModelStatus)
        ? (b.status as ModelStatus)
        : undefined;

    if (role === undefined && enabled === undefined && status === undefined) {
      return NextResponse.json(
        {
          error:
            "No valid fields to update. Pass at least one of: role, enabled, status.",
        },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const existing = await getModel(modelId);
    if (!existing) {
      return NextResponse.json(
        { error: `Model '${modelId}' not found.` },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Apply mutations in sequence so each one's logging / validation fires.
    if (role) {
      await setModelRole(modelId, role);
    }
    if (status) {
      await setModelStatus(modelId, status);
    }
    if (enabled !== undefined) {
      await db.modelRecord.update({
        where: { modelId },
        data: { enabled },
      });
    }

    // Re-read the row so the response carries the latest state of every
    // field (role, status, enabled, JSON blobs).
    const row = await db.modelRecord.findUnique({ where: { modelId: modelId } });
    const updated = row ? rowToModelRecord(row) : existing;

    await logEvent("model_router", "info", "model_record_updated", {
      modelId,
      role: role ?? existing.role,
      status: status ?? existing.status,
      enabled: enabled ?? existing.enabled,
      previousRole: existing.role,
      previousStatus: existing.status,
      previousEnabled: existing.enabled,
    });

    return NextResponse.json(
      { model: updated },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/models/[id] PATCH] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
