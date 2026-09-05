// Gitcoin Grant submission adapter (Phase-2 §20, P1-10, P2-EXEC-ADAPTERS).
//
// Handles `grant` category opportunities from Gitcoin.
//
// Gitcoin Grants use a quadratic-funding round. The "submission" is a
// grant APPLICATION — not an on-chain transaction. Completing one requires:
//   - a Gitcoin Passport (KYC + humanity verification),
//   - a round-specific project setup (title, description, banner image,
//     impact statement, fund recipient address),
//   - submission BEFORE the round deadline.
//
// We CAN'T do any of that autonomously — KYC requires a human (camera,
// government ID, biometric liveness). Even if we had a Passport, the
// ToS forbids automated project creation.
//
// This is an HONEST PARTIAL adapter:
//   - It does NOT fake a submission.
//   - It returns `{ status: "draft" }` with the grant application URL
//     the operator must complete manually.
//   - It writes the prepared deliverable (the grant proposal draft) to
//     `data/submissions/<opportunityId>/gitcoin-grant.md` so the operator
//     has a starting point.
//
// `isConfigured()` returns `true` always — no creds needed (it's a URL
// redirect + a draft file).

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

/** Root directory for draft submissions. */
const SUBMISSIONS_ROOT = path.join(process.cwd(), "data", "submissions");

// ---------------------------------------------------------------------------
// GitcoinGrantAdapter
// ---------------------------------------------------------------------------

/**
 * Honest partial adapter: writes a grant proposal draft to disk + returns
 * the grant application URL for the operator to complete manually.
 *
 * NEVER fakes a submission. NEVER makes a network call.
 */
export class GitcoinGrantAdapter implements SubmissionAdapter {
  readonly id = "gitcoin-grant";
  readonly category = "grant";

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

    // Resolve the operator-actionable grant application URL. We prefer the
    // opportunity's sourceUrl (already a Gitcoin grant page); otherwise
    // fall back to the Gitcoin explorer landing.
    const grantApplicationUrl =
      input.opportunity.sourceUrl && /gitcoin\.co/i.test(input.opportunity.sourceUrl)
        ? input.opportunity.sourceUrl
        : "https://gitcoin.co/grants";

    // Write a markdown draft the operator can paste into Gitcoin's editor.
    const draftPath = await writeGrantDraft(input).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[gitcoin-grant-adapter] draft write failed:", msg);
      return null;
    });

    const externalRef = `gitcoin-grant:${input.opportunityId}`;
    await logEvent(
      "execution",
      "info",
      "submission_complete",
      {
        adapter: this.id,
        opportunityId: input.opportunityId,
        externalRef,
        submissionUrl: grantApplicationUrl,
        status: "draft",
        draftPath,
      },
      logCtx
    );

    return {
      success: true,
      externalRef,
      submissionUrl: grantApplicationUrl,
      status: "draft",
      details:
        `Grant application drafted — operator must complete Gitcoin Passport KYC ` +
        `+ submit manually at ${grantApplicationUrl}. ` +
        (draftPath ? `Draft proposal saved to ${draftPath}.` : "(draft write failed — see logs.)"),
      adapterId: this.id,
    };
  }
}

// ---------------------------------------------------------------------------
// Draft builder
// ---------------------------------------------------------------------------

/**
 * Write a grant-proposal markdown draft to `data/submissions/<opportunityId>/gitcoin-grant.md`.
 *
 * The draft is structured to mirror Gitcoin's project-setup form:
 *   - Project name
 *   - Short description (1-2 sentences — Gitcoin's "tagline")
 *   - Detailed description (the deliverable's approach)
 *   - Funding recipient (operator must fill in)
 *   - Impact statement (the approach + tests, reworded)
 *   - Links (the source URL)
 */
async function writeGrantDraft(input: SubmissionInput): Promise<string> {
  const dir = path.join(SUBMISSIONS_ROOT, input.opportunityId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "gitcoin-grant.md");

  const op = input.opportunity;
  const approachText = (input.deliverable.approach || "(no approach provided)").trim();
  const tests = input.deliverable.tests.filter(Boolean);
  const files = input.deliverable.files;

  const lines: string[] = [
    `# ${op.title}`,
    "",
    `**Organization:** ${op.organization || "(unknown)"}`,
    `**Category:** ${op.category}`,
    `**Reward:** ${op.rewardAmount} ${op.rewardCurrency}`,
    `**Source URL:** ${op.sourceUrl}`,
    "",
    "## Operator action required",
    "",
    "Gitcoin Grants require a Gitcoin Passport (KYC + humanity verification)",
    "and a project setup that this agent cannot complete autonomously.",
    "Open the grant round URL below in your browser, complete the project",
    "setup form, and paste the relevant sections from this draft.",
    "",
    `**Grant round URL:** ${op.sourceUrl}`,
    "",
    "## Short description (Gitcoin tagline)",
    "",
    truncate(stripMarkdown(approachText), 280),
    "",
    "## Detailed description",
    "",
    approachText,
    "",
    "## Funding recipient",
    "",
    "**OPERATOR:** fill in the wallet address that will receive grant funds.",
    "Use one of the agent's monitored wallets (see docs/CONFIGURATION.md)",
    "or your own wallet.",
    "",
    "## Impact statement",
    "",
    approachText,
    "",
  ];

  if (tests.length > 0) {
    lines.push("## Test outcomes", "", ...tests.map((t) => `- ${t}`), "");
  }

  if (files.length > 0) {
    lines.push(
      "## Attached files",
      "",
      ...files.map((f) => `- \`${f.path}\` (${f.language}, ${f.content.length} chars)`),
      ""
    );
  }

  lines.push(
    "## Disclosure",
    "",
    "This draft was prepared by the CryptoEarn autonomous agent. The agent",
    "cannot complete the Gitcoin Passport KYC step or submit the grant on",
    "your behalf — manual operator action is required.",
    ""
  );

  await fs.writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/** Strip the most common markdown markers so the tagline reads as plain prose. */
function stripMarkdown(s: string): string {
  return s
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
