// GET /api/models
//
// Return the LLM model registry. Each row carries the deserialized JSON
// fields (capabilities, performance, limits) so the dashboard can render
// the full capability matrix without re-parsing.
//
// Query params:
//   - enabled  : "true" | "false" → filter by enabled flag
//   - role     : "primary" | "secondary" | "reviewer" | "exploration" | "disabled"
//   - status   : "healthy" | "degraded" | "unhealthy" | "blacklisted"

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { getModels } from "@/lib/llm/registry";
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

export async function GET(req: Request) {
  try {
    await bootstrapAgent();

    const url = new URL(req.url);
    const enabledParam = url.searchParams.get("enabled");
    const roleParam = url.searchParams.get("role");
    const statusParam = url.searchParams.get("status");

    const opts: {
      enabled?: boolean;
      role?: ModelRole;
      status?: ModelStatus;
    } = {};

    if (enabledParam === "true") opts.enabled = true;
    if (enabledParam === "false") opts.enabled = false;
    if (roleParam && VALID_ROLES.has(roleParam as ModelRole)) {
      opts.role = roleParam as ModelRole;
    }
    if (statusParam && VALID_STATUSES.has(statusParam as ModelStatus)) {
      opts.status = statusParam as ModelStatus;
    }

    const models = await getModels(opts);
    return NextResponse.json(
      { models, count: models.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/models GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
