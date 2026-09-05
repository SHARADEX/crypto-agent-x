// GET /api/strategies/allocations
//
// Return the 7 strategy families + their current target allocation %, the
// hard min/max limits (Phase 3 §26), the disabled flag, the scan frequency,
// the last rebalance timestamp + reason (Phase 3 §23), the rolled-up
// per-family stats (Phase 3 §40 — discovered / attempted / completed / failed
// / totalNetUsd / totalHours / avgHourly / successRate), and the trend.
//
// Used by the Strategies dashboard tab's:
//   - Family rollup table (Phase 3 §39 — every column the spec lists).
//   - Allocation Controls panel (Phase 3 §25).
//   - Per-family disable / enable / set-limits controls.

import { NextResponse } from "next/server";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import { getAllocations } from "@/lib/economics/strategy-allocator";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await bootstrapAgent();

    const allocations = await getAllocations();

    const totalTarget = allocations.reduce(
      (sum, a) => sum + (a.disabled ? 0 : a.targetAllocation),
      0
    );

    return NextResponse.json(
      {
        allocations,
        count: allocations.length,
        totalTargetAllocation: Number(totalTarget.toFixed(2)),
        // The total SHOULD always be 100 — surface it so the dashboard can
        // warn the operator when drift has crept in (e.g. after a DB
        // migration that left a family at 0%).
        isBalanced: Math.abs(totalTarget - 100) < 0.01,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/strategies/allocations GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// POST /api/strategies/allocations
//
// Operator actions on the strategy allocation system (Phase 3 §25, §26).
//
// The request body shape determines the action:
//
//   1. { action: "set_allocation", family, targetAllocation }
//        — override the family's target %. The other families are auto-
//          rescaled so the total stays at 100%.
//
//   2. { action: "auto_optimize" }
//        — return control to the adaptive allocator (resets every family's
//          target to its default; the next rebalance pass will adjust
//          toward measured performance).
//
//   3. { action: "set_limits", family, min, max }
//        — set the hard floor + ceiling for the family (Phase 3 §26). If
//          the current target is outside the new window, it is clamped.
//
//   4. { action: "toggle", family, disabled }
//        — disable (true) or enable (false) a family. Disabling sets its
//          target to 0% and redistributes the freed allocation across the
//          other active families.
//
//   5. { action: "rebalance" }
//        — manually trigger an adaptive rebalance pass right now (useful
//          for the operator to verify the rebalancer's behaviour without
//          waiting for 5 paid opportunities to accumulate).
//
// NEVER throws — every error is returned as a 4xx / 5xx JSON response.

import {
  setAllocation,
  setAllocationLimits,
  disableFamily,
  enableFamily,
  autoOptimize,
  rebalanceAllocations,
} from "@/lib/economics/strategy-allocator";
import { STRATEGY_FAMILY_MAP } from "@/lib/economics/strategy-families";
import { logEvent } from "@/lib/agent/events";

interface SetAllocationBody {
  action: "set_allocation";
  family: string;
  targetAllocation: number;
}

interface AutoOptimizeBody {
  action: "auto_optimize";
}

interface SetLimitsBody {
  action: "set_limits";
  family: string;
  min: number;
  max: number;
}

interface ToggleBody {
  action: "toggle";
  family: string;
  disabled: boolean;
}

interface RebalanceBody {
  action: "rebalance";
}

type PostBody =
  | SetAllocationBody
  | AutoOptimizeBody
  | SetLimitsBody
  | ToggleBody
  | RebalanceBody;

const VALID_ACTIONS = new Set([
  "set_allocation",
  "auto_optimize",
  "set_limits",
  "toggle",
  "rebalance",
]);

export async function POST(req: Request) {
  try {
    await bootstrapAgent();

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
    const action = typeof bodyObj.action === "string" ? bodyObj.action : "";
    if (!VALID_ACTIONS.has(action)) {
      return NextResponse.json(
        {
          error: `Invalid action. Must be one of: ${Array.from(VALID_ACTIONS).join(" | ")}.`,
        },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const typed = bodyObj as unknown as PostBody;

    // --- set_allocation -----------------------------------------------
    if (typed.action === "set_allocation") {
      const family = typed.family;
      if (!family || !STRATEGY_FAMILY_MAP[family as keyof typeof STRATEGY_FAMILY_MAP]) {
        return NextResponse.json(
          { error: `Unknown family: ${family}.` },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
      const target = Number(typed.targetAllocation);
      if (!Number.isFinite(target) || target < 0 || target > 100) {
        return NextResponse.json(
          { error: "targetAllocation must be a number in [0, 100]." },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
      const result = await setAllocation(family as never, target);
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error ?? "setAllocation failed." },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
      await logEvent(
        "economics",
        "info",
        "strategy_allocation_overridden",
        { family, targetAllocation: target },
        {}
      );
      return NextResponse.json(
        { ok: true, changes: result.changes ?? [] },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // --- auto_optimize -------------------------------------------------
    if (typed.action === "auto_optimize") {
      const result = await autoOptimize();
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error ?? "autoOptimize failed." },
          { status: 500, headers: { "Cache-Control": "no-store" } }
        );
      }
      return NextResponse.json(
        { ok: true, changes: result.changes },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // --- set_limits ----------------------------------------------------
    if (typed.action === "set_limits") {
      const family = typed.family;
      if (!family || !STRATEGY_FAMILY_MAP[family as keyof typeof STRATEGY_FAMILY_MAP]) {
        return NextResponse.json(
          { error: `Unknown family: ${family}.` },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
      const min = Number(typed.min);
      const max = Number(typed.max);
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return NextResponse.json(
          { error: "min and max must be finite numbers." },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
      const result = await setAllocationLimits(family as never, min, max);
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error ?? "setAllocationLimits failed." },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
      return NextResponse.json(
        { ok: true, newTarget: result.newTarget },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // --- toggle --------------------------------------------------------
    if (typed.action === "toggle") {
      const family = typed.family;
      if (!family || !STRATEGY_FAMILY_MAP[family as keyof typeof STRATEGY_FAMILY_MAP]) {
        return NextResponse.json(
          { error: `Unknown family: ${family}.` },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
      const disabled = !!typed.disabled;
      const result = disabled
        ? await disableFamily(family as never)
        : await enableFamily(family as never);
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error ?? "toggle failed." },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }
      return NextResponse.json(
        { ok: true, family, disabled },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // --- rebalance -----------------------------------------------------
    if (typed.action === "rebalance") {
      const result = await rebalanceAllocations();
      return NextResponse.json(
        {
          ok: true,
          rebalanced: result.rebalanced,
          changes: result.changes,
          skippedReason: result.skippedReason ?? null,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Should be unreachable — action was validated above.
    return NextResponse.json(
      { error: `Unhandled action: ${action}` },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/strategies/allocations POST] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
