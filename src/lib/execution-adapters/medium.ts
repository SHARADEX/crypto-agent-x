// Medium submission adapter (Phase-2 §20, P1-10, P2-EXEC-ADAPTERS).
//
// Handles `content` category opportunities — alternative to Mirror. Used
// when `MEDIUM_TOKEN` + `MEDIUM_USER_ID` are configured but Mirror is not.
//
// Uses the Medium REST API (officially documented):
//   `POST https://api.medium.com/v1/users/{userId}/posts`
//   with `Authorization: Bearer $MEDIUM_TOKEN`.
//
// Body schema:
//   {
//     title: string,
//     contentFormat: "markdown" | "html",
//     content: string,
//     tags?: string[],
//     canonicalUrl?: string,
//     publishStatus: "public" | "draft" | "unlisted"
//   }
//
// We always publish as `draft` first (the operator can flip it to public
// after reviewing). This is the HONEST default — Medium's API doesn't
// support auto-publishing as public without manual review of the
// integration's token scopes.
//
// NEVER throws. 30s timeout per API call.

import { promises as fs } from "fs";
import path from "path";
import { logEvent } from "@/lib/agent/events";
import {
  adapterFetch,
  failureResult,
  type SubmissionAdapter,
  type SubmissionInput,
  type SubmissionResult,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEDIUM_API_BASE = "https://api.medium.com/v1";
const SUBMISSIONS_ROOT = path.join(process.cwd(), "data", "submissions");

interface MediumPostResponse {
  data?: {
    id?: string;
    url?: string;
    title?: string;
    publishStatus?: string;
  };
}

// ---------------------------------------------------------------------------
// MediumPostAdapter
// ---------------------------------------------------------------------------

/**
 * Submission adapter that publishes a long-form article to Medium.
 *
 * Auth: `MEDIUM_TOKEN` + `MEDIUM_USER_ID` env vars.
 * Always publishes as `draft` (operator must flip to public).
 */
export class MediumPostAdapter implements SubmissionAdapter {
  readonly id = "medium";
  readonly category = "content";
  private readonly token: string;
  private readonly userId: string;

  constructor() {
    this.token = (process.env.MEDIUM_TOKEN ?? "").trim();
    this.userId = (process.env.MEDIUM_USER_ID ?? "").trim();
  }

  isConfigured(): boolean {
    return this.token.length > 0 && this.userId.length > 0;
  }

  requiredCredentials(): string[] {
    return ["MEDIUM_TOKEN", "MEDIUM_USER_ID"];
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
        configured: this.isConfigured(),
      },
      logCtx
    );

    const title = (input.opportunity.title ?? "Untitled").slice(0, 200);
    const content = buildArticleContent(input);
    const tags = deriveTags(input);

    if (!this.isConfigured()) {
      const draftPath = await writeArticleDraft(input, title, content).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[medium-adapter] draft write failed:", msg);
        return null;
      });
      const externalRef = `medium-draft:${input.opportunityId}`;
      await logEvent(
        "execution",
        "info",
        "submission_complete",
        {
          adapter: this.id,
          opportunityId: input.opportunityId,
          externalRef,
          status: "draft",
          draftPath,
          reason: "MEDIUM_TOKEN + MEDIUM_USER_ID not configured",
        },
        logCtx
      );
      return {
        success: true,
        externalRef,
        submissionUrl: "https://medium.com",
        status: "draft",
        details:
          `MEDIUM_TOKEN or MEDIUM_USER_ID not set — article drafted to ` +
          (draftPath ?? "(write failed)") +
          `. Operator must paste it into Medium's editor manually.`,
        adapterId: this.id,
      };
    }

    // Real publish path (as a DRAFT — operator flips to public after review).
    const url = `${MEDIUM_API_BASE}/users/${this.userId}/posts`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "CryptoEarn-Agent/0.3 (submission-adapter)",
      },
      body: JSON.stringify({
        title,
        contentFormat: "markdown",
        content,
        tags,
        publishStatus: "draft",
      }),
    };

    const res = await adapterFetch(url, init);
    if (!res.ok) {
      const detail = `${res.error ?? `HTTP ${res.status}`} — body: ${res.text.slice(0, 200)}`;
      const draftPath = await writeArticleDraft(input, title, content).catch(() => null);
      await logEvent(
        "execution",
        "warn",
        "submission_failed",
        {
          adapter: this.id,
          opportunityId: input.opportunityId,
          error: detail,
          draftPath,
        },
        logCtx
      );
      return failureResult(
        this.id,
        `error:${this.id}`,
        `Medium API publish failed — ${detail}. ` +
          (draftPath ? `Draft saved to ${draftPath}.` : "Draft write also failed."),
        `Medium API publish failed — ${detail}.`
      );
    }

    const parsed = res.json as MediumPostResponse | null;
    const postId = parsed?.data?.id ?? `medium-${input.opportunityId}-${Date.now()}`;
    const postUrl = parsed?.data?.url ?? `https://medium.com/@${this.userId}/${postId}`;

    const externalRef = `medium:${postId}`;
    await logEvent(
      "execution",
      "info",
      "submission_complete",
      {
        adapter: this.id,
        opportunityId: input.opportunityId,
        externalRef,
        submissionUrl: postUrl,
        status: "draft", // always draft — operator must flip to public
      },
      logCtx
    );

    return {
      success: true,
      externalRef,
      submissionUrl: postUrl,
      status: "draft", // honest — Medium draft, NOT public
      details:
        `Published article "${title}" to Medium as a DRAFT at ${postUrl}. ` +
        `Operator must review + flip to public before it's visible to readers.`,
      adapterId: this.id,
    };
  }
}

// ---------------------------------------------------------------------------
// Body + tags builders
// ---------------------------------------------------------------------------

function buildArticleContent(input: SubmissionInput): string {
  const parts: string[] = [];

  const mdFile = input.deliverable.files.find(
    (f) => f.language === "markdown" || f.path.endsWith(".md")
  );
  if (mdFile) {
    parts.push(mdFile.content);
  } else {
    parts.push(input.deliverable.approach || input.opportunity.description || "");
  }

  for (const f of input.deliverable.files) {
    if (f === mdFile) continue;
    const fence = "```" + (f.language || "");
    parts.push(`\n### ${f.path}\n\n${fence}\n${f.content}\n\`\`\`\n`);
  }

  if (input.deliverable.tests.length > 0) {
    parts.push("\n### Test outcomes\n");
    for (const t of input.deliverable.tests) {
      parts.push(`- ${t}`);
    }
  }

  parts.push(
    "\n---\n",
    "*This article was prepared by the CryptoEarn autonomous agent.*"
  );

  // Medium caps posts at ~100k chars; truncate defensively.
  return parts.join("\n").slice(0, 90_000);
}

/**
 * Derive up to 5 lowercase tags from the opportunity category + skills.
 * Medium rejects >5 tags + non-lowercase tags.
 */
function deriveTags(input: SubmissionInput): string[] {
  const tags = new Set<string>();
  const cat = (input.opportunity.category || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cat) tags.add(cat);
  // Pull keywords from the title (capitalised words > 4 chars).
  const titleWords = (input.opportunity.title || "")
    .split(/\s+/)
    .filter((w) => /^[A-Za-z][A-Za-z0-9-]{3,}$/.test(w))
    .map((w) => w.toLowerCase().replace(/[^a-z0-9-]/g, ""))
    .filter(Boolean);
  for (const w of titleWords) {
    if (tags.size >= 5) break;
    tags.add(w);
  }
  return Array.from(tags).slice(0, 5);
}

async function writeArticleDraft(
  input: SubmissionInput,
  title: string,
  content: string
): Promise<string> {
  const dir = path.join(SUBMISSIONS_ROOT, input.opportunityId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "medium.md");
  const body = `# ${title}\n\nSource: ${input.opportunity.sourceUrl}\n\n${content}\n`;
  await fs.writeFile(filePath, body, "utf8");
  return filePath;
}
