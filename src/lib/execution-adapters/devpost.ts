// Devpost hackathon submission adapter (Phase-2 §20, P1-10, P2-EXEC-ADAPTERS).
//
// Handles `hackathon` category opportunities from Devpost.
//
// Devpost hackathon submissions require:
//   - a Devpost account (email + password OR OAuth via GitHub/Google),
//   - a per-hackathon project setup (title, devpost.com URL slug, video
//     demo, code repo link, write-up),
//   - submission BEFORE the hackathon deadline.
//
// We CAN'T do this autonomously:
//   - Devpost's ToS forbids automated account creation.
//   - Project setup requires a video demo upload (no public API).
//   - The submission step itself is a button click that requires an
//     authenticated session cookie.
//
// This is an HONEST PARTIAL adapter:
//   - It does NOT fake a submission.
//   - It returns `{ status: "draft" }` with the hackathon's
//     "start project" URL for the operator.
//   - It writes a draft write-up to `data/submissions/<opportunityId>/devpost.md`
//     the operator can paste into Devpost's editor.
//
// `isConfigured()` returns `true` always — no creds needed.

import { promises as fs } from "fs";
import path from "path";
import { logEvent } from "@/lib/agent/events";
import type {
  SubmissionAdapter,
  SubmissionInput,
  SubmissionResult,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUBMISSIONS_ROOT = path.join(process.cwd(), "data", "submissions");

// ---------------------------------------------------------------------------
// DevpostHackathonAdapter
// ---------------------------------------------------------------------------

/**
 * Honest partial adapter: writes a hackathon project draft + returns the
 * Devpost "start project" URL for the operator.
 *
 * NEVER fakes a submission. NEVER makes a network call.
 */
export class DevpostHackathonAdapter implements SubmissionAdapter {
  readonly id = "devpost";
  readonly category = "hackathon";

  isConfigured(): boolean {
    // Always configured — no creds needed (it's a URL redirect + draft file).
    return true;
  }

  requiredCredentials(): string[] {
    return [];
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
        sourceUrl: input.opportunity.sourceUrl,
      },
      logCtx
    );

    const submissionUrl = resolveDevpostUrl(input.opportunity.sourceUrl);

    const draftPath = await writeDevpostDraft(input).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[devpost-adapter] draft write failed:", msg);
      return null;
    });

    const externalRef = `devpost:${input.opportunityId}`;
    await logEvent(
      "execution",
      "info",
      "submission_complete",
      {
        adapter: this.id,
        opportunityId: input.opportunityId,
        externalRef,
        submissionUrl,
        status: "draft",
        draftPath,
      },
      logCtx
    );

    return {
      success: true,
      externalRef,
      submissionUrl,
      status: "draft",
      details:
        `Hackathon project drafted — operator must complete the submission on Devpost at ` +
        `${submissionUrl}. ` +
        (draftPath ? `Project write-up saved to ${draftPath}.` : "(draft write failed — see logs.)"),
      adapterId: this.id,
    };
  }
}

// ---------------------------------------------------------------------------
// URL resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the operator-actionable Devpost URL. The opportunity's
 * sourceUrl is typically `https://www.devpost.com/hackathons/<slug>` or
 * `https://<hackathon-slug>.devpost.com/`. The "start project" URL is
 * `<base>/submissions/new` (Devpost's project-start form).
 */
function resolveDevpostUrl(sourceUrl: string): string {
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) {
    return "https://devpost.com/hackathons";
  }
  try {
    const url = new URL(sourceUrl);
    if (!/devpost\.com$/i.test(url.hostname) && !/\.devpost\.com$/i.test(url.hostname)) {
      return "https://devpost.com/hackathons";
    }
    // Strip trailing slash + append the start-project path.
    const base = `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
    return `${base}/submissions/new`;
  } catch {
    return "https://devpost.com/hackathons";
  }
}

// ---------------------------------------------------------------------------
// Draft builder
// ---------------------------------------------------------------------------

async function writeDevpostDraft(input: SubmissionInput): Promise<string> {
  const dir = path.join(SUBMISSIONS_ROOT, input.opportunityId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "devpost.md");

  const op = input.opportunity;
  const approachText = (input.deliverable.approach || "(no approach provided)").trim();
  const tests = input.deliverable.tests.filter(Boolean);
  const files = input.deliverable.files;

  const lines: string[] = [
    `# ${op.title}`,
    "",
    `**Organization:** ${op.organization || "(unknown)"}`,
    `**Hackathon URL:** ${op.sourceUrl}`,
    `**Reward:** ${op.rewardAmount} ${op.rewardCurrency}`,
    "",
    "## Operator action required",
    "",
    "Devpost hackathon submissions require:",
    "  1. A Devpost account (sign up at https://devpost.com).",
    "  2. A per-hackathon project setup on the hackathon's page.",
    "  3. A video demo upload (≤5 minutes).",
    "  4. Submission BEFORE the hackathon deadline (see the hackathon page).",
    "",
    "Open the URL below in your browser, click 'Start a submission', and",
    "paste the relevant sections from this draft.",
    "",
    `**Start-project URL:** ${resolveDevpostUrl(op.sourceUrl)}`,
    "",
    "## Project title",
    "",
    op.title,
    "",
    "## Short description (Devpost tagline)",
    "",
    truncate(stripMarkdown(approachText), 280),
    "",
    "## Detailed write-up",
    "",
    approachText,
    "",
  ];

  if (tests.length > 0) {
    lines.push("## Test outcomes", "", ...tests.map((t) => `- ${t}`), "");
  }
  if (files.length > 0) {
    lines.push(
      "## Code / attached files",
      "",
      ...files.map((f) => `- \`${f.path}\` (${f.language}, ${f.content.length} chars)`),
      ""
    );
  }

  lines.push(
    "## Video demo script",
    "",
    "**OPERATOR:** record a screen capture walking through:",
    "  - The problem the project solves (1 sentence).",
    "  - The implementation approach (the write-up above).",
    "  - A live demo of the running code.",
    "  - The test results.",
    "",
    "## Disclosure",
    "",
    "This draft was prepared by the CryptoEarn autonomous agent. The agent",
    "cannot create a Devpost account or submit the project on your behalf —",
    "manual operator action is required.",
    ""
  );

  await fs.writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function stripMarkdown(s: string): string {
  return s
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
