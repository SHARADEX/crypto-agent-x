// GitHub PR submission adapter (Phase-2 §20, P1-10, P2-EXEC-ADAPTERS).
//
// Handles `github_bounty`, `coding_task`, `developer_task`, `bug_bounty`
// opportunities where the source URL is a GitHub issue.
//
// Pipeline (every step is a separate GitHub REST API call):
//
//   1. Parse the issue URL → owner/repo/issue_number.
//   2. Fork the repo (idempotent — GitHub returns the existing fork).
//   3. Get the fork's default branch HEAD sha.
//   4. Create a new branch on the fork off the HEAD.
//   5. Create a tree with the deliverable files (base_tree = HEAD tree).
//   6. Create a commit on the branch with the new tree (parent = HEAD).
//   7. Update the branch ref to point at the new commit.
//   8. Open a pull request against the upstream repo's default branch.
//
// SAFETY (spec §32, §20):
//   - NEVER force-push to the upstream repo.
//   - NEVER push directly to main/master on the upstream — always via a PR.
//   - The PR body discloses this was AI-prepared (spec §40, §43 honesty).
//   - The PR body NEVER contains the agent's internal task/opportunity IDs.
//   - 30s timeout per API call via AbortController (in `adapterFetch`).
//   - Auth: `Authorization: Bearer $GITHUB_TOKEN` (PAT with `repo` + `public_repo`).
//
// ERROR HANDLING: NEVER throws. Returns `{ success: false, error }` on:
//   - 401: invalid token
//   - 403: rate limit / forbidden (includes `X-RateLimit-Remaining: 0`)
//   - 404: repo / issue not found
//   - 422: validation (e.g. branch already exists with conflicting files)
//   - network / timeout: returns the abort/transport error message

import { logEvent } from "@/lib/agent/events";
import {
  GITHUB_API_BASE,
  adapterFetch,
  failureResult,
  type SubmissionAdapter,
  type SubmissionInput,
  type SubmissionResult,
} from "./types";

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

interface ParsedIssueUrl {
  owner: string;
  repo: string;
  issueNumber: number;
}

/**
 * Parse a GitHub URL into owner/repo/issue_number. Accepts:
 *   - https://github.com/{owner}/{repo}/issues/{n}
 *   - https://github.com/{owner}/{repo}/pull/{n}  (treated as issue ref)
 *   - https://github.com/{owner}/{repo}            (issueNumber = 0)
 *
 * Returns `null` when the URL is not a github.com URL or doesn't match
 * the expected shape. NEVER throws.
 */
export function parseGithubUrl(sourceUrl: string): ParsedIssueUrl | null {
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) return null;
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    return null;
  }
  // Path: /{owner}/{repo}/issues/{n} OR /{owner}/{repo}
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo, kind, num] = parts;
  if (!owner || !repo) return null;
  // Strip trailing .git if present.
  const cleanRepo = repo.endsWith(".git") ? repo.slice(0, -4) : repo;
  let issueNumber = 0;
  if ((kind === "issues" || kind === "pull") && num) {
    const n = parseInt(num, 10);
    if (Number.isFinite(n) && n > 0) issueNumber = n;
  }
  return { owner, repo: cleanRepo, issueNumber };
}

// ---------------------------------------------------------------------------
// GitHub API response shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface GhRepo {
  name: string;
  default_branch: string;
  owner: { login: string };
  fork: boolean;
  parent?: { owner: { login: string }; name: string; default_branch: string };
}

interface GhFork {
  name: string;
  full_name: string; // "<fork_owner>/<repo>"
  owner: { login: string };
  default_branch: string;
}

interface GhRef {
  ref: string;
  object: { sha: string };
}

interface GhCommit {
  sha: string;
  tree: { sha: string };
}

interface GhTree {
  sha: string;
}

interface GhPr {
  number: number;
  html_url: string;
  state: string;
}

// ---------------------------------------------------------------------------
// GithubPrAdapter
// ---------------------------------------------------------------------------

/**
 * Submission adapter that opens a pull request against the upstream
 * repository referenced in `opportunity.sourceUrl`.
 *
 * Auth: `GITHUB_TOKEN` env var (a Personal Access Token with `repo` +
 * `public_repo` scopes).
 */
export class GithubPrAdapter implements SubmissionAdapter {
  readonly id = "github-pr";
  readonly category = "github_bounty";
  private readonly token: string;

  constructor() {
    this.token = (process.env.GITHUB_TOKEN ?? "").trim();
  }

  isConfigured(): boolean {
    return this.token.length > 0;
  }

  requiredCredentials(): string[] {
    return ["GITHUB_TOKEN"];
  }

  // -------------------------------------------------------------------------
  // submit
  // -------------------------------------------------------------------------

  async submit(input: SubmissionInput): Promise<SubmissionResult> {
    const logCtx = { taskId: input.taskId, opportunityId: input.opportunityId };
    const sourceUrl = input.opportunity.sourceUrl;

    await logEvent(
      "execution",
      "info",
      "submission_attempt",
      {
        adapter: this.id,
        opportunityId: input.opportunityId,
        sourceUrl,
        fileCount: input.deliverable.files.length,
        hasDiff: Boolean(input.deliverable.diff),
        hasPatch: Boolean(input.deliverable.patch),
      },
      logCtx
    );

    if (!this.isConfigured()) {
      return this.fail(
        input,
        "GITHUB_TOKEN is not set — cannot authenticate to the GitHub REST API.",
        logCtx
      );
    }

    // --- 1. Parse the source URL ----------------------------------------
    const parsed = parseGithubUrl(sourceUrl);
    if (!parsed) {
      return this.fail(
        input,
        `source URL is not a GitHub issue URL: "${sourceUrl}".`,
        logCtx
      );
    }
    const { owner, repo, issueNumber } = parsed;

    // --- 2. Fetch upstream repo metadata (for default branch + fork check)
    const upstreamMeta = await this.callGithub<GhRepo>(
      "GET",
      `/repos/${owner}/${repo}`,
      undefined,
      logCtx
    );
    if (!upstreamMeta.ok) {
      return this.fail(
        input,
        `GitHub API: GET /repos/${owner}/${repo} failed — ${upstreamMeta.error}`,
        logCtx
      );
    }
    const defaultBranch = upstreamMeta.json?.default_branch ?? "main";
    if (!defaultBranch) {
      return this.fail(
        input,
        `upstream repo ${owner}/${repo} has no default_branch.`,
        logCtx
      );
    }

    // --- 3. Fork the repo (idempotent — returns existing fork) ----------
    // Forks go to the AUTHENTICATED user's namespace, not `owner`.
    const forkResp = await this.callGithub<GhFork>(
      "POST",
      `/repos/${owner}/${repo}/forks`,
      {},
      logCtx
    );
    if (!forkResp.ok) {
      return this.fail(
        input,
        `GitHub API: POST /repos/${owner}/${repo}/forks failed — ${forkResp.error}`,
        logCtx
      );
    }
    const fork = forkResp.json;
    if (!fork || !fork.owner?.login) {
      return this.fail(
        input,
        "GitHub API: fork response missing owner.login.",
        logCtx
      );
    }
    const forkOwner = fork.owner.login;
    const forkRepo = fork.name || repo;
    // Forks inherit the upstream's default branch name (GitHub convention).
    const forkDefaultBranch = fork.default_branch || defaultBranch;

    // --- 4. Get the fork's default-branch HEAD sha -----------------------
    // Forks are eventually-consistent — GitHub may take a few seconds to
    // provision the repo + push the default branch. We retry the HEAD fetch
    // up to 3 times with 2s backoff.
    let headSha: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const refResp = await this.callGithub<GhRef>(
        "GET",
        `/repos/${forkOwner}/${forkRepo}/git/refs/heads/${forkDefaultBranch}`,
        undefined,
        logCtx
      );
      if (refResp.ok && refResp.json?.object?.sha) {
        headSha = refResp.json.object.sha;
        break;
      }
      if (attempt < 3) {
        await sleep(2000 * attempt);
      }
    }
    if (!headSha) {
      return this.fail(
        input,
        `GitHub API: could not resolve HEAD sha for ${forkOwner}/${forkRepo}:${forkDefaultBranch} after 3 attempts (fork may still be provisioning).`,
        logCtx
      );
    }

    // --- 5. Get the HEAD commit (for its tree sha — used as base_tree) --
    const headCommit = await this.callGithub<GhCommit>(
      "GET",
      `/repos/${forkOwner}/${forkRepo}/git/commits/${headSha}`,
      undefined,
      logCtx
    );
    if (!headCommit.ok || !headCommit.json?.tree?.sha) {
      return this.fail(
        input,
        `GitHub API: GET /repos/${forkOwner}/${forkRepo}/git/commits/${headSha} failed — ${headCommit.error}`,
        logCtx
      );
    }
    const baseTreeSha = headCommit.json.tree.sha;

    // --- 6. Create a tree with the deliverable files --------------------
    if (input.deliverable.files.length === 0) {
      return this.fail(
        input,
        "deliverable.files is empty — nothing to commit.",
        logCtx
      );
    }
    const treePayload = {
      base_tree: baseTreeSha,
      tree: input.deliverable.files.map((f) => ({
        path: f.path.replace(/^\/+/, ""), // GitHub rejects leading slashes
        mode: "100644" as const,
        type: "blob" as const,
        content: f.content,
      })),
    };
    const treeResp = await this.callGithub<GhTree>(
      "POST",
      `/repos/${forkOwner}/${forkRepo}/git/trees`,
      treePayload,
      logCtx
    );
    if (!treeResp.ok || !treeResp.json?.sha) {
      return this.fail(
        input,
        `GitHub API: POST /repos/${forkOwner}/${forkRepo}/git/trees failed — ${treeResp.error}`,
        logCtx
      );
    }
    const newTreeSha = treeResp.json.sha;

    // --- 7. Create the commit (parent = HEAD, tree = new tree) ----------
    const branchName = `cryptoearn-bot/${issueNumber || "submission"}-${Date.now()}`;
    const commitPayload = {
      message: buildCommitMessage(input, issueNumber),
      tree: newTreeSha,
      parents: [headSha],
    };
    const commitResp = await this.callGithub<GhCommit>(
      "POST",
      `/repos/${forkOwner}/${forkRepo}/git/commits`,
      commitPayload,
      logCtx
    );
    if (!commitResp.ok || !commitResp.json?.sha) {
      return this.fail(
        input,
        `GitHub API: POST /repos/${forkOwner}/${forkRepo}/git/commits failed — ${commitResp.error}`,
        logCtx
      );
    }
    const newCommitSha = commitResp.json.sha;

    // --- 8. Create the branch ref (pointing at the new commit) ----------
    const refPayload = {
      ref: `refs/heads/${branchName}`,
      sha: newCommitSha,
    };
    const refCreateResp = await this.callGithub<GhRef>(
      "POST",
      `/repos/${forkOwner}/${forkRepo}/git/refs`,
      refPayload,
      logCtx
    );
    if (!refCreateResp.ok) {
      // Common failure: branch name collides (already exists). We retry
      // once with a longer suffix.
      const retryBranch = `${branchName}-${Math.floor(Math.random() * 1000)}`;
      const retryResp = await this.callGithub<GhRef>(
        "POST",
        `/repos/${forkOwner}/${forkRepo}/git/refs`,
        {
          ref: `refs/heads/${retryBranch}`,
          sha: newCommitSha,
        },
        logCtx
      );
      if (!retryResp.ok) {
        return this.fail(
          input,
          `GitHub API: POST /repos/${forkOwner}/${forkRepo}/git/refs failed — ${refCreateResp.error}`,
          logCtx
        );
      }
      // Use the retry branch name for the PR.
      return await this.openPullRequest(
        input,
        owner,
        repo,
        forkOwner,
        retryBranch,
        defaultBranch,
        issueNumber,
        logCtx
      );
    }

    return await this.openPullRequest(
      input,
      owner,
      repo,
      forkOwner,
      branchName,
      defaultBranch,
      issueNumber,
      logCtx
    );
  }

  // -------------------------------------------------------------------------
  // Open the pull request (separate method so the branch-name retry works)
  // -------------------------------------------------------------------------

  private async openPullRequest(
    input: SubmissionInput,
    upstreamOwner: string,
    upstreamRepo: string,
    forkOwner: string,
    branchName: string,
    baseBranch: string,
    issueNumber: number,
    logCtx: { taskId: string; opportunityId: string }
  ): Promise<SubmissionResult> {
    const prPayload = {
      title: buildPrTitle(input, issueNumber),
      body: buildPrBody(input, issueNumber),
      head: `${forkOwner}:${branchName}`,
      base: baseBranch,
      draft: false,
    };
    const prResp = await this.callGithub<GhPr>(
      "POST",
      `/repos/${upstreamOwner}/${upstreamRepo}/pulls`,
      prPayload,
      logCtx
    );
    if (!prResp.ok || !prResp.json?.number) {
      // The branch was created but the PR failed — surface this clearly.
      return this.fail(
        input,
        `GitHub API: POST /repos/${upstreamOwner}/${upstreamRepo}/pulls failed — ${prResp.error}. ` +
          `The branch '${forkOwner}:${branchName}' was created on the fork but no PR was opened. ` +
          `Operator can open the PR manually at https://github.com/${upstreamOwner}/${upstreamRepo}/compare/${baseBranch}...${forkOwner}:${branchName}`,
        logCtx
      );
    }
    const pr = prResp.json;
    const externalRef = `github-pr:${pr.number}`;
    const submissionUrl = pr.html_url;

    await logEvent(
      "execution",
      "info",
      "submission_complete",
      {
        adapter: this.id,
        opportunityId: input.opportunityId,
        externalRef,
        submissionUrl,
        status: "pending_review",
        prNumber: pr.number,
        fork: `${forkOwner}/${upstreamRepo}`,
        branch: branchName,
      },
      logCtx
    );

    return {
      success: true,
      externalRef,
      submissionUrl,
      status: "pending_review",
      details:
        `Opened pull request #${pr.number} against ${upstreamOwner}/${upstreamRepo}. ` +
        `Fork: ${forkOwner}/${upstreamRepo} branch ${branchName}. ` +
        `The PR is now pending human review by the upstream maintainers.`,
      expectedReviewAt: undefined,
      adapterId: this.id,
    };
  }

  // -------------------------------------------------------------------------
  // Wrapper around `adapterFetch` that injects the GitHub auth headers
  // and centralises error parsing. NEVER throws.
  // -------------------------------------------------------------------------

  private async callGithub<T>(
    method: string,
    path: string,
    body: unknown,
    logCtx: { taskId: string; opportunityId: string }
  ): Promise<{ ok: boolean; json: T | null; error?: string; status: number }> {
    const url = path.startsWith("http") ? path : `${GITHUB_API_BASE}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "CryptoEarn-Agent/0.3 (submission-adapter)",
      },
    };
    if (body !== undefined && method !== "GET" && method !== "HEAD") {
      init.body = JSON.stringify(body);
    }

    const res = await adapterFetch(url, init);
    if (!res.ok) {
      // GitHub returns useful error messages in the response body — extract
      // the `message` field if present so the operator sees something
      // actionable (e.g. "Validation failed: ref already exists").
      let detail = res.error ?? `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(res.text) as { message?: string; errors?: Array<{ message?: string }> };
        if (parsed?.message) detail = `${detail} — ${parsed.message}`;
        if (parsed?.errors?.length) {
          const subMsgs = parsed.errors.map((e) => e.message).filter(Boolean).join("; ");
          if (subMsgs) detail = `${detail} (${subMsgs})`;
        }
      } catch {
        // ignore — keep the bare HTTP error
      }
      await logEvent(
        "execution",
        "warn",
        "submission_api_error",
        {
          adapter: this.id,
          method,
          path,
          status: res.status,
          error: detail,
          opportunityId: logCtx.opportunityId,
        },
        logCtx
      );
      return { ok: false, json: null, error: detail, status: res.status };
    }
    return { ok: true, json: res.json as T | null, status: res.status };
  }

  // -------------------------------------------------------------------------
  // failure helper — logs the error + returns a SubmissionResult
  // -------------------------------------------------------------------------

  private async fail(
    input: SubmissionInput,
    error: string,
    logCtx: { taskId: string; opportunityId: string }
  ): Promise<SubmissionResult> {
    await logEvent(
      "execution",
      "warn",
      "submission_failed",
      {
        adapter: this.id,
        opportunityId: input.opportunityId,
        error,
      },
      logCtx
    );
    return failureResult(this.id, `error:${this.id}`, error);
  }
}

// ---------------------------------------------------------------------------
// PR title + body builders
// ---------------------------------------------------------------------------

/**
 * Build the PR title. NEVER includes the agent's internal opportunity/task IDs.
 * Format: "<short title>" — fixed-prefix-free; the maintainers should see a
 * normal-looking PR title.
 */
function buildPrTitle(input: SubmissionInput, issueNumber: number): string {
  // Truncate the opportunity title to keep PR titles under ~80 chars.
  const title = (input.opportunity.title ?? "Automated submission").slice(0, 72);
  return issueNumber > 0 ? `${title}` : title;
}

/**
 * Build the PR body. Includes:
 *   - The approach (from the coding/writing agent's deliverable).
 *   - The test results (if any).
 *   - A "Fixes #<issue_number>" line (if the source URL was an issue).
 *   - A clear disclosure that this PR was prepared by an autonomous agent.
 *
 * NEVER includes the agent's internal IDs (opportunityId, taskId, runId).
 */
function buildPrBody(input: SubmissionInput, issueNumber: number): string {
  const approach = (input.deliverable.approach ?? "").trim() || "(no approach summary provided)";
  const tests = input.deliverable.tests.filter(Boolean);
  const lines: string[] = [];
  if (issueNumber > 0) {
    lines.push(`Fixes #${issueNumber}`, "");
  }
  lines.push("## Approach", "", approach, "");
  if (tests.length > 0) {
    lines.push("## Test results", "", ...tests.map((t) => `- ${t}`), "");
  }
  lines.push(
    "## Disclosure",
    "",
    "This pull request was prepared by an autonomous AI agent (CryptoEarn). " +
      "The code was generated by an LLM, executed in a sandboxed workspace, " +
      "and the test suite was run before this PR was opened. " +
      "Human review is required before merge.",
    ""
  );
  return lines.join("\n");
}

/**
 * Build the commit message. Short + descriptive — the PR body carries the
 * full approach + disclosure.
 */
function buildCommitMessage(input: SubmissionInput, issueNumber: number): string {
  const summary = (input.deliverable.approach ?? input.opportunity.title ?? "Automated submission")
    .split("\n")[0]
    .slice(0, 72);
  const suffix = issueNumber > 0 ? ` (refs #${issueNumber})` : "";
  return `${summary}${suffix}\n\nPrepared by the CryptoEarn autonomous agent.`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
