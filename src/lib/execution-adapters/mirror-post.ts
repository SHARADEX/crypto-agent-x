// Mirror.xyz submission adapter (Phase-2 §20, P1-10, P2-EXEC-ADAPTERS).
//
// Handles `content`, `oss_contribution`, `docs` categories where the
// deliverable is a long-form article.
//
// Mirror.xyz has a (mostly undocumented) publishing API. The auth token
// (`MIRROR_AUTH_TOKEN`) is obtained from the browser dev-tools Network
// panel after signing in to mirror.xyz — there is no official OAuth flow.
//
// Endpoint: `POST https://mirror.xyz/api/publications` with
// `{ title, body, canonicalUrl? }`. Returns `{ publication: { id, url } }`.
//
// If the token isn't configured, this adapter falls back to writing a
// markdown file the operator can paste into Mirror's editor. That's an
// HONEST partial path — it does NOT fake a publication.
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

const MIRROR_API_BASE = "https://mirror.xyz";
const SUBMISSIONS_ROOT = path.join(process.cwd(), "data", "submissions");

interface MirrorPublicationResponse {
  publication?: {
    id?: string;
    url?: string;
    title?: string;
  };
  // Mirror sometimes returns the fields flat:
  id?: string;
  url?: string;
}

// ---------------------------------------------------------------------------
// MirrorPostAdapter
// ---------------------------------------------------------------------------

/**
 * Submission adapter that publishes a long-form article to Mirror.xyz.
 *
 * Auth: `MIRROR_AUTH_TOKEN` env var (operator's Mirror session token,
 * scraped from browser dev-tools — Mirror has no official OAuth).
 *
 * Falls back to writing a markdown draft to disk when no token is set.
 */
export class MirrorPostAdapter implements SubmissionAdapter {
  readonly id = "mirror-post";
  readonly category = "content";
  private readonly token: string;

  constructor() {
    this.token = (process.env.MIRROR_AUTH_TOKEN ?? "").trim();
  }

  isConfigured(): boolean {
    return this.token.length > 0;
  }

  requiredCredentials(): string[] {
    return ["MIRROR_AUTH_TOKEN"];
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

    // Build the article body — combine the approach + any code files.
    const title = (input.opportunity.title ?? "Untitled").slice(0, 200);
    const body = buildArticleBody(input);

    if (!this.isConfigured()) {
      // Honest fallback: write a markdown draft the operator can paste
      // into Mirror's editor.
      const draftPath = await writeArticleDraft(input, title, body, "mirror").catch(
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn("[mirror-post-adapter] draft write failed:", msg);
          return null;
        }
      );
      const externalRef = `mirror-draft:${input.opportunityId}`;
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
          reason: "MIRROR_AUTH_TOKEN not configured",
        },
        logCtx
      );
      return {
        success: true,
        externalRef,
        submissionUrl: "https://mirror.xyz",
        status: "draft",
        details:
          `MIRROR_AUTH_TOKEN not set — article drafted to ` +
          (draftPath ?? "(write failed)") +
          `. Operator must paste it into Mirror's editor manually.`,
        adapterId: this.id,
      };
    }

    // Real publish path.
    const url = `${MIRROR_API_BASE}/api/publications`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "CryptoEarn-Agent/0.3 (submission-adapter)",
      },
      body: JSON.stringify({
        title,
        body,
        // canonicalUrl omitted — let Mirror generate one.
      }),
    };

    const res = await adapterFetch(url, init);
    if (!res.ok) {
      const detail = `${res.error ?? `HTTP ${res.status}`} — body: ${res.text.slice(0, 200)}`;
      // Fall back to the draft path so the operator still has the article.
      const draftPath = await writeArticleDraft(input, title, body, "mirror").catch(() => null);
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
        `Mirror API publish failed — ${detail}. ` +
          (draftPath ? `Draft saved to ${draftPath}.` : "Draft write also failed."),
        `Mirror API publish failed — ${detail}.`
      );
    }

    const parsed = res.json as MirrorPublicationResponse | null;
    const postId =
      parsed?.publication?.id ?? parsed?.id ?? `mirror-${input.opportunityId}-${Date.now()}`;
    const postUrl =
      parsed?.publication?.url ?? parsed?.url ?? `https://mirror.xyz/publication/${postId}`;

    const externalRef = `mirror:${postId}`;
    await logEvent(
      "execution",
      "info",
      "submission_complete",
      {
        adapter: this.id,
        opportunityId: input.opportunityId,
        externalRef,
        submissionUrl: postUrl,
        status: "published",
      },
      logCtx
    );

    return {
      success: true,
      externalRef,
      submissionUrl: postUrl,
      status: "published",
      details: `Published article "${title}" to Mirror at ${postUrl}.`,
      adapterId: this.id,
    };
  }
}

// ---------------------------------------------------------------------------
// Body builder
// ---------------------------------------------------------------------------

/**
 * Build the article body. Combines the approach + file contents as a single
 * markdown string. The first file (if it's a markdown file) is treated as
 * the article body; otherwise we synthesise a body from the approach + code
 * blocks.
 */
function buildArticleBody(input: SubmissionInput): string {
  const parts: string[] = [];

  // If the first file is markdown, use it as the body.
  const mdFile = input.deliverable.files.find(
    (f) => f.language === "markdown" || f.path.endsWith(".md")
  );
  if (mdFile) {
    parts.push(mdFile.content);
  } else {
    parts.push(input.deliverable.approach || input.opportunity.description || "");
  }

  // Append code blocks for non-markdown files.
  for (const f of input.deliverable.files) {
    if (f === mdFile) continue;
    const fence = "```" + (f.language || "");
    parts.push(`\n### ${f.path}\n\n${fence}\n${f.content}\n\`\`\`\n`);
  }

  // Append test results.
  if (input.deliverable.tests.length > 0) {
    parts.push("\n### Test outcomes\n");
    for (const t of input.deliverable.tests) {
      parts.push(`- ${t}`);
    }
  }

  // Disclosure.
  parts.push(
    "\n---\n",
    "*This article was prepared by the CryptoEarn autonomous agent.*"
  );

  return parts.join("\n").slice(0, 50_000); // Mirror body cap (approx)
}

/**
 * Write a markdown draft of the article to disk for the operator to paste.
 */
async function writeArticleDraft(
  input: SubmissionInput,
  title: string,
  body: string,
  platform: string
): Promise<string> {
  const dir = path.join(SUBMISSIONS_ROOT, input.opportunityId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${platform}.md`);
  const content = `# ${title}\n\nSource: ${input.opportunity.sourceUrl}\n\n${body}\n`;
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}
