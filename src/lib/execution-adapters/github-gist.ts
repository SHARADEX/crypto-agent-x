// GitHub Gist submission adapter (Phase-2 §20, P1-10, P2-EXEC-ADAPTERS).
//
// Handles `data_task`, `coding_task`, `developer_task` opportunities where
// the deliverable is a standalone snippet (NOT a PR). Useful when:
//   - the source URL is not a github.com repo (e.g. a forum thread, an
//     email, a chat message asking for a snippet),
//   - the deliverable is a single self-contained script (data wrangling,
//     API client demo, configuration generator), OR
//   - the operator hasn't granted push permission to the upstream repo
//     and a Gist is the closest "published" deliverable.
//
// Creates a public Gist via `POST /gists` with the deliverable files.
// Auth: `GITHUB_TOKEN` (same PAT as the PR adapter — `gist` scope required).
//
// NEVER throws. 30s timeout per API call.

import { logEvent } from "@/lib/agent/events";
import {
  GITHUB_API_BASE,
  adapterFetch,
  failureResult,
  type SubmissionAdapter,
  type SubmissionInput,
  type SubmissionResult,
} from "./types";

interface GhGist {
  id: string;
  html_url: string;
  description: string | null;
  public: boolean;
}

/**
 * Submission adapter that creates a public GitHub Gist with the
 * deliverable files. Falls back from the PR adapter when no upstream
 * repo can be identified.
 */
export class GithubGistAdapter implements SubmissionAdapter {
  readonly id = "github-gist";
  readonly category = "data_task";
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

  async submit(input: SubmissionInput): Promise<SubmissionResult> {
    const logCtx = { taskId: input.taskId, opportunityId: input.opportunityId };

    await logEvent(
      "execution",
      "info",
      "submission_attempt",
      {
        adapter: this.id,
        opportunityId: input.opportunityId,
        fileCount: input.deliverable.files.length,
      },
      logCtx
    );

    if (!this.isConfigured()) {
      return this.fail(
        input,
        "GITHUB_TOKEN is not set — cannot authenticate to the GitHub Gists API.",
        logCtx
      );
    }
    if (input.deliverable.files.length === 0) {
      return this.fail(input, "deliverable.files is empty — nothing to gist.", logCtx);
    }

    const description = (input.opportunity.title ?? "CryptoEarn deliverable").slice(0, 100);
    const files: Record<string, { content: string }> = {};
    for (const f of input.deliverable.files) {
      // GitHub Gists key files by basename; collisions overwrite.
      const name = f.path.split("/").pop() || "snippet.txt";
      // De-duplicate collisions by suffixing.
      let unique = name;
      let i = 1;
      while (files[unique]) {
        const dot = name.lastIndexOf(".");
        unique =
          dot > 0
            ? `${name.slice(0, dot)}-${i}${name.slice(dot)}`
            : `${name}-${i}`;
        i++;
      }
      files[unique] = { content: f.content };
    }

    const url = `${GITHUB_API_BASE}/gists`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "CryptoEarn-Agent/0.3 (submission-adapter)",
      },
      body: JSON.stringify({
        description,
        public: true,
        files,
      }),
    };

    const res = await adapterFetch(url, init);
    if (!res.ok) {
      const detail = parseGhError(res.error, res.text);
      return this.fail(
        input,
        `GitHub API: POST /gists failed — ${detail}`,
        logCtx
      );
    }

    const gist = res.json as GhGist | null;
    if (!gist?.id || !gist.html_url) {
      return this.fail(
        input,
        "GitHub API: gist response missing id or html_url.",
        logCtx
      );
    }

    const externalRef = `github-gist:${gist.id}`;
    await logEvent(
      "execution",
      "info",
      "submission_complete",
      {
        adapter: this.id,
        opportunityId: input.opportunityId,
        externalRef,
        submissionUrl: gist.html_url,
        status: "published",
      },
      logCtx
    );

    return {
      success: true,
      externalRef,
      submissionUrl: gist.html_url,
      status: "published",
      details: `Published a public GitHub Gist (${Object.keys(files).length} file(s)) at ${gist.html_url}.`,
      adapterId: this.id,
    };
  }

  private async fail(
    input: SubmissionInput,
    error: string,
    logCtx: { taskId: string; opportunityId: string }
  ): Promise<SubmissionResult> {
    await logEvent(
      "execution",
      "warn",
      "submission_failed",
      { adapter: this.id, opportunityId: input.opportunityId, error },
      logCtx
    );
    return failureResult(this.id, `error:${this.id}`, error);
  }
}

/**
 * Parse a GitHub error response body for an actionable message.
 */
function parseGhError(fallback: string | undefined, body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed?.message) return `${fallback ?? "request failed"} — ${parsed.message}`;
  } catch {
    // ignore
  }
  return fallback ?? "request failed";
}
