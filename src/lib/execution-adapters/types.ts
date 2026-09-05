// Submission adapters (Phase-2 §20, P1-10, P2-EXEC-ADAPTERS).
//
// A `SubmissionAdapter` is the bridge between the Execution Agent and an
// external platform (GitHub, Gitcoin, Devpost, Mirror, Medium, …). The
// execution agent picks ONE adapter per opportunity based on the category +
// the operator's configured credentials, then calls `submit(input)`.
//
// Design rules (mirrors spec §28, §29, §30 + the agent contract):
//
//   1. NEVER throw out of `submit()` — always return a `SubmissionResult`.
//      Failures carry `success: false` + an `error` string. This matches
//      the agent contract that `execute()` never throws either.
//   2. NEVER fake a submission. If the adapter can't make a real API call
//      (no token, network down, etc.), it must either:
//        a) return `{ success: false, error }` (real adapters), OR
//        b) return `{ success: true, status: "draft" }` (honest-fallback
//           adapters that write a draft to disk for the operator to
//           complete manually — e.g. EmailDraftAdapter).
//      NEVER return `{ success: true, status: "submitted" }` without
//      actually submitting.
//   3. Every HTTP call has an AbortController timeout (default 30s).
//   4. Every HTTP call records budget via `BudgetManager.recordWebRequest()`
//      BEFORE the fetch (so over-budget state is caught before the request
//      goes out — mirrors the pattern in `agent/sources/_http.ts`).
//   5. NEVER log secrets. Tokens live in env vars; they never appear in
//      `logEvent` payloads or `SubmissionResult.details`.
//   6. NEVER push to `main`/`master` of an upstream repo (the GitHub PR
//      adapter forks → branches → PRs, never force-pushes upstream).

/**
 * A submission adapter handles one category of opportunity (or a fallback
 * for everything else). Adapters are picked by `getAdapterForCategory`.
 */
export interface SubmissionAdapter {
  /** Stable identifier — "github-pr" | "github-gist" | "gitcoin-grant" | "devpost" | "mirror-post" | "medium" | "email-draft". */
  readonly id: string;
  /** Which OpportunityCategory this adapter primarily handles. */
  readonly category: string;
  /** Submit the prepared deliverable. NEVER throws. */
  submit(input: SubmissionInput): Promise<SubmissionResult>;
  /** Check if this adapter is configured (has the needed credentials/env). */
  isConfigured(): boolean;
  /** What credentials does this adapter need? (for the health check + dashboard). */
  requiredCredentials(): string[];
}

/**
 * The input handed to `SubmissionAdapter.submit()`. Built by the Execution
 * Agent from the opportunity row + the prior agent's deliverable.
 */
export interface SubmissionInput {
  /** The DB Opportunity.id. */
  opportunityId: string;
  /** The DB Task.id (if invoked via a Task handoff). */
  taskId: string;
  /**
   * The workspace containing the prepared deliverable (the coding agent's
   * sandbox root). May be empty when the deliverable was in-memory (e.g.
   * a writing-agent draft). Adapters must handle both cases.
   */
  workspacePath: string;
  /** The opportunity being fulfilled. */
  opportunity: {
    title: string;
    description: string;
    sourceUrl: string;
    category: string;
    organization: string;
    rewardAmount: number;
    rewardCurrency: string;
  };
  /** The deliverable produced by the coding/writing agent. */
  deliverable: {
    /** Short prose summary of the approach taken (used in PR body / cover letter). */
    approach: string;
    /** The files to publish/commit (path + language + content). */
    files: Array<{ path: string; language: string; content: string }>;
    /** A list of test outcome strings (e.g. "5 passed, 0 failed"). */
    tests: string[];
    /** The unified diff/patch if a git workspace was used (optional). */
    diff?: string;
    /** A complete patch string ready for `git apply` (optional). */
    patch?: string;
  };
  /** Operator approval ID (if one was required + granted). */
  approvalId?: string;
}

/**
 * Result of `SubmissionAdapter.submit()`.
 */
export interface SubmissionResult {
  /** True when the submission landed on the external platform (or was saved as an honest draft). */
  success: boolean;
  /**
   * External reference. Stable string the dashboard + audit log use to
   * link back to the submission. Convention:
   *   - github-pr:<pr_number>
   *   - github-gist:<gist_id>
   *   - gitcoin-grant:<opportunityId>
   *   - devpost:<opportunityId>
   *   - mirror:<post_id>
   *   - medium:<post_id>
   *   - email-draft:<opportunityId>
   *   - error:<reason>  (when success === false)
   */
  externalRef: string;
  /** Where the submission landed (PR URL, post URL, file path, …). */
  submissionUrl?: string;
  /** Status of the submission. */
  status: "submitted" | "pending_review" | "published" | "failed" | "draft";
  /** Human-readable details (NEVER includes secrets). */
  details: string;
  /** When the submission can be expected to be reviewed (if known). */
  expectedReviewAt?: string;
  /** Error message when `success === false`. */
  error?: string;
  /** Which adapter handled this (mirrors `adapter.id` for the audit log). */
  adapterId?: string;
}

// ---------------------------------------------------------------------------
// Shared HTTP helper
// ---------------------------------------------------------------------------

/**
 * Default per-API-call timeout (30s). Mirrors spec §32. Longer than the
 * 10s source-adapter timeout because submission endpoints (GitHub PR
 * creation, Mirror publish) can legitimately take longer.
 */
export const DEFAULT_ADAPTER_TIMEOUT_MS = 30_000;

/**
 * GitHub REST API base. Hardcoded — adapters don't accept arbitrary URLs.
 */
export const GITHUB_API_BASE = "https://api.github.com";

/**
 * Fetch a URL with timeout + budget recording. NEVER throws — returns
 * `{ ok: false, error }` on any failure (network, timeout, non-2xx).
 *
 * Mirrors the pattern in `agent/sources/_http.ts` but is intentionally
 * separate because:
 *   - The source-adapter helper sanitises content for LLM consumption.
 *     Submission adapters are talking to first-party APIs (GitHub,
 *     Mirror, Medium) and parsing the JSON response directly — the
 *     sanitiser would wrap the JSON in delimiters and break parsing.
 *   - The source-adapter helper caps bodies at 1MB; submission
 *     responses are tiny (PR metadata, gist metadata) so the cap is
 *     not needed.
 *
 * Auth headers, body, and method are passed through unchanged. The
 * caller is responsible for setting `Authorization` (the helper NEVER
 * logs it).
 *
 * @param url     the URL to fetch
 * @param init    fetch init (method, headers, body)
 * @param opts    timeoutMs (default 30s)
 */
export async function adapterFetch(
  url: string,
  init?: RequestInit,
  opts: { timeoutMs?: number } = {}
): Promise<{
  ok: boolean;
  status: number;
  json: unknown | null;
  text: string;
  error?: string;
  latencyMs: number;
}> {
  // Lazy import to avoid a hard cycle when this file is imported by the
  // budget manager's neighbours. `BudgetManager` is a singleton.
  const { BudgetManager } = await import("@/lib/budget/manager");

  const start = Date.now();
  try {
    await BudgetManager.getInstance().recordWebRequest();
  } catch (err) {
    console.warn("[execution-adapters] recordWebRequest failed:", err);
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let status = 0;
  let text = "";

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "follow",
    });
    status = res.status;
    text = await res.text();

    if (!res.ok) {
      return {
        ok: false,
        status,
        json: null,
        text,
        error: `HTTP ${status} ${res.statusText}`,
        latencyMs: Date.now() - start,
      };
    }

    let json: unknown | null = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        // Some endpoints return empty 204 bodies — leave json null.
      }
    }

    return {
      ok: true,
      status,
      json,
      text,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const msg = isAbort
      ? `timeout after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return {
      ok: false,
      status,
      json: null,
      text: "",
      error: msg,
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a failure `SubmissionResult` (NEVER throws).
 */
export function failureResult(
  adapterId: string,
  externalRef: string,
  error: string,
  details?: string
): SubmissionResult {
  return {
    success: false,
    externalRef,
    status: "failed",
    details: details ?? `Submission failed: ${error}`,
    error,
    adapterId,
  };
}
