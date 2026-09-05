// Submission adapters registry (Phase-2 §20, P1-10, P2-EXEC-ADAPTERS).
//
// Re-exports every adapter + the registry helpers used by the Execution
// Agent (`getAdapterForCategory`) + the dashboard health endpoint
// (`getConfiguredAdapters`, `getAdapterHealth`).

import type { OpportunityCategory } from "@/lib/agent/types";
import type { SubmissionAdapter } from "./types";
import { GithubPrAdapter } from "./github-pr";
import { GithubGistAdapter } from "./github-gist";
import { GitcoinGrantAdapter } from "./gitcoin-grant";
import { DevpostHackathonAdapter } from "./devpost";
import { MirrorPostAdapter } from "./mirror-post";
import { MediumPostAdapter } from "./medium";
import { EmailDraftAdapter } from "./email-draft";

// ---------------------------------------------------------------------------
// Adapter instances (singletons — they read env vars at construction)
// ---------------------------------------------------------------------------

export const githubPrAdapter = new GithubPrAdapter();
export const githubGistAdapter = new GithubGistAdapter();
export const gitcoinGrantAdapter = new GitcoinGrantAdapter();
export const devpostHackathonAdapter = new DevpostHackathonAdapter();
export const mirrorPostAdapter = new MirrorPostAdapter();
export const mediumPostAdapter = new MediumPostAdapter();
export const emailDraftAdapter = new EmailDraftAdapter();

/**
 * Ordered registry of all adapters. Order matters for `getAdapterForCategory`
 * ONLY in the sense that the EmailDraftAdapter (fallback) should be LAST
 * — the function does explicit category dispatch, not a linear search.
 */
export const ADAPTERS: SubmissionAdapter[] = [
  githubPrAdapter,
  githubGistAdapter,
  gitcoinGrantAdapter,
  devpostHackathonAdapter,
  mirrorPostAdapter,
  mediumPostAdapter,
  emailDraftAdapter,
];

// ---------------------------------------------------------------------------
// Categories that map to the GitHub PR adapter
// ---------------------------------------------------------------------------

const GITHUB_PR_CATEGORIES: ReadonlySet<string> = new Set([
  "github_bounty",
  "coding_task",
  "developer_task",
  "bug_bounty",
]);

const GITHUB_GIST_CATEGORIES: ReadonlySet<string> = new Set([
  "data_task",
]);

const CONTENT_CATEGORIES: ReadonlySet<string> = new Set([
  "content",
  "oss_contribution",
  "docs",
]);

// ---------------------------------------------------------------------------
// getAdapterForCategory
// ---------------------------------------------------------------------------

/**
 * Pick the best submission adapter for a given opportunity.
 *
 * Selection rules (in priority order):
 *
 *   1. github_bounty / coding_task / developer_task / bug_bounty
 *      - If sourceUrl is a github.com URL → GithubPrAdapter (if configured)
 *        else GithubGistAdapter (if configured) else EmailDraftAdapter.
 *      - If sourceUrl is NOT github.com → GithubGistAdapter (if configured)
 *        else EmailDraftAdapter.
 *
 *   2. data_task
 *      - GithubGistAdapter (if configured) else EmailDraftAdapter.
 *
 *   3. grant
 *      - GitcoinGrantAdapter (always configured — it's a URL+draft fallback).
 *
 *   4. hackathon
 *      - DevpostHackathonAdapter (always configured).
 *
 *   5. content / oss_contribution / docs
 *      - MirrorPostAdapter (if configured) else MediumPostAdapter (if
 *        configured) else EmailDraftAdapter.
 *
 *   6. freelance (or anything else)
 *      - EmailDraftAdapter.
 *
 * The EmailDraftAdapter is the ALWAYS-AVAILABLE honest fallback — it never
 * fakes a submission, just writes a draft the operator must complete.
 *
 * @param category   the opportunity's category string
 * @param sourceUrl  the opportunity's source URL (used to detect GitHub)
 */
export function getAdapterForCategory(
  category: string,
  sourceUrl?: string
): SubmissionAdapter {
  const cat = (category ?? "").toLowerCase();

  // --- 1. GitHub PR categories -------------------------------------------------
  if (GITHUB_PR_CATEGORIES.has(cat)) {
    const isGithub = isGithubSourceUrl(sourceUrl);
    if (isGithub && githubPrAdapter.isConfigured()) {
      return githubPrAdapter;
    }
    if (githubGistAdapter.isConfigured()) {
      return githubGistAdapter;
    }
    return emailDraftAdapter;
  }

  // --- 2. data_task ------------------------------------------------------------
  if (GITHUB_GIST_CATEGORIES.has(cat)) {
    if (githubGistAdapter.isConfigured()) {
      return githubGistAdapter;
    }
    return emailDraftAdapter;
  }

  // --- 3. grant ----------------------------------------------------------------
  if (cat === "grant") {
    return gitcoinGrantAdapter;
  }

  // --- 4. hackathon ------------------------------------------------------------
  if (cat === "hackathon") {
    return devpostHackathonAdapter;
  }

  // --- 5. content / oss_contribution / docs -----------------------------------
  if (CONTENT_CATEGORIES.has(cat)) {
    if (mirrorPostAdapter.isConfigured()) {
      return mirrorPostAdapter;
    }
    if (mediumPostAdapter.isConfigured()) {
      return mediumPostAdapter;
    }
    return emailDraftAdapter;
  }

  // --- 6. freelance + default --------------------------------------------------
  return emailDraftAdapter;
}

/**
 * Returns true when `sourceUrl` is a github.com URL (not a gist, not an
 * API URL). Used by `getAdapterForCategory` to decide between the PR
 * adapter and the Gist adapter.
 */
function isGithubSourceUrl(sourceUrl: string | undefined): boolean {
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) return false;
  try {
    const url = new URL(sourceUrl);
    const host = url.hostname.toLowerCase();
    // Reject gist URLs — those go through the Gist adapter.
    if (host === "gist.github.com") return false;
    // Only accept github.com / www.github.com.
    if (host !== "github.com" && host !== "www.github.com") return false;
    // Need at least owner/repo to open a PR.
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length >= 2;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Health-check helpers (used by the dashboard + `/api/agent/health`)
// ---------------------------------------------------------------------------

/**
 * Return adapters where `isConfigured()` is true.
 */
export function getConfiguredAdapters(): SubmissionAdapter[] {
  return ADAPTERS.filter((a) => a.isConfigured());
}

export interface AdapterHealthRow {
  id: string;
  category: string;
  configured: boolean;
  requiredCredentials: string[];
  /** "real" (makes external API calls) | "fallback" (draft-only). */
  kind: "real" | "fallback";
}

/**
 * Build a health-check table for the dashboard. One row per adapter.
 */
export function getAdapterHealth(): AdapterHealthRow[] {
  return ADAPTERS.map((a) => ({
    id: a.id,
    category: a.category,
    configured: a.isConfigured(),
    requiredCredentials: a.requiredCredentials(),
    kind: adapterKind(a.id),
  }));
}

/**
 * Classify an adapter as `real` (makes external API calls) vs `fallback`
 * (draft-only — writes a file but doesn't submit anywhere).
 */
function adapterKind(id: string): "real" | "fallback" {
  switch (id) {
    case "github-pr":
    case "github-gist":
    case "mirror-post":
    case "medium":
      return "real";
    case "gitcoin-grant":
    case "devpost":
    case "email-draft":
      return "fallback";
    default:
      return "fallback";
  }
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type {
  SubmissionAdapter,
  SubmissionInput,
  SubmissionResult,
} from "./types";

export { failureResult, adapterFetch } from "./types";

// Re-export the opportunity category type for callers that want to
// constrain their inputs. (Just a passthrough so callers don't need to
// know about `@/lib/agent/types`.)
export type { OpportunityCategory };
