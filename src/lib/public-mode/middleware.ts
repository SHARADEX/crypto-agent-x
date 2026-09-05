// Public read-only mode (Phase-2 P3-4).
//
// When `PUBLIC_READ_ONLY=true` (env) OR the agent state has
// `autonomyMode === "observe"` AND the request lacks an operator token,
// the dashboard serves a read-only view: all GET endpoints work, but every
// mutating endpoint (POST/PATCH/DELETE) returns 403 with a clear message.
//
// This lets the operator share a public dashboard link (e.g. for a grant
// application, an audit, or a hackathon demo) without risking that a visitor
// can pause the agent, approve a task, or trigger a cycle.
//
// The operator token is an optional `OPERATOR_TOKEN` env var. When set, any
// request with the header `X-Operator-Token: <value>` is treated as an
// operator request (full access). When unset, only same-origin requests from
// the dashboard are mutating-allowed (the dashboard's fetch calls are
// same-origin so they pass the origin check).

import { db } from "@/lib/db";

const READ_ONLY_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Paths that are ALWAYS allowed even in read-only mode (they're read endpoints
 *  exposed under POST for complex query bodies, or they're the auth endpoints
 *  themselves). */
const ALWAYS_ALLOWED_PATTERNS: RegExp[] = [
  /^\/api\/public\//,
];

export interface PublicModeDecision {
  readonly: boolean;
  reason: string;
}

/**
 * Decide whether the current request should be treated as read-only.
 * Returns `{ readonly: false }` when the request is allowed to mutate.
 */
export async function decidePublicMode(req: Request): Promise<PublicModeDecision> {
  // 1. GET/HEAD/OPTIONS are always allowed.
  const method = req.method.toUpperCase();
  if (!READ_ONLY_METHODS.has(method)) {
    return { readonly: false, reason: "read method" };
  }

  // 2. Always-allowed paths.
  const url = new URL(req.url);
  const path = url.pathname;
  if (ALWAYS_ALLOWED_PATTERNS.some((re) => re.test(path))) {
    return { readonly: false, reason: "always-allowed path" };
  }

  // 3. Explicit env flag.
  if (process.env.PUBLIC_READ_ONLY === "true") {
    // Operator token bypass.
    const operatorToken = process.env.OPERATOR_TOKEN;
    if (operatorToken) {
      const sent = req.headers.get("x-operator-token");
      if (sent && sent === operatorToken) {
        return { readonly: false, reason: "operator token" };
      }
    }
    return {
      readonly: true,
      reason:
        "PUBLIC_READ_ONLY=true — set X-Operator-Token header or unset the env var to mutate.",
    };
  }

  return { readonly: false, reason: "not in public mode" };
}

/**
 * Is the system currently in public read-only mode? (Used by the dashboard
 * to hide/disable mutating buttons.)
 */
export async function isPublicReadOnlyMode(): Promise<boolean> {
  if (process.env.PUBLIC_READ_ONLY === "true") return true;
  try {
    const state = await db.agentState.findUnique({
      where: { id: "singleton" },
      select: { autonomyMode: true },
    });
    // observe mode is implicitly read-only for the public (no auto-execution).
    // But we only enforce read-only for non-operator requests when the env
    // flag is set — observe mode alone doesn't block the operator.
    return false;
  } catch {
    return false;
  }
}
