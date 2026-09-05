// Email-draft submission adapter (Phase-2 §20, P1-10, P2-EXEC-ADAPTERS).
//
// The HONEST FALLBACK adapter. Used when:
//   - `getAdapterForCategory()` returns `null` (no adapter matches the
//     opportunity's category + source URL), OR
//   - a real adapter was selected but `isConfigured()` returned `false`
//     (e.g. GithubPrAdapter picked but GITHUB_TOKEN unset), OR
//   - the opportunity's category is `freelance` (no platform API exists).
//
// What it does:
//   - Writes the deliverable + a cover-letter email draft to
//     `data/submissions/<opportunityId>/email-draft.txt`.
//   - Returns `{ success: true, status: "draft" }`.
//
// What it does NOT do:
//   - Send the email. We don't have an SMTP credential + the operator
//     must review the draft before sending.
//   - Fake a submission. The `externalRef` is `email-draft:<opportunityId>`,
//     not a fake submission ID.
//
// This adapter is ALWAYS configured — it's the safety net that ensures
// the execution agent NEVER has to fail loudly for want of a real
// adapter. The previous behaviour (P2-DASH-OBS) was to mark the
// opportunity as `failed` when no real adapter existed. With this
// fallback, the opportunity is marked `executed` (the work was prepared)
// but the operator must complete the submission manually.

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
// EmailDraftAdapter
// ---------------------------------------------------------------------------

/**
 * Honest fallback adapter: writes the deliverable + a cover-letter email
 * draft to disk. ALWAYS configured. NEVER fakes a submission.
 */
export class EmailDraftAdapter implements SubmissionAdapter {
  readonly id = "email-draft";
  readonly category = "freelance"; // also the catch-all fallback

  isConfigured(): boolean {
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
        fileCount: input.deliverable.files.length,
      },
      logCtx
    );

    const draftPath = await writeEmailDraft(input).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[email-draft-adapter] draft write failed:", msg);
      return null;
    });

    const externalRef = `email-draft:${input.opportunityId}`;
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
      },
      logCtx
    );

    return {
      success: true,
      externalRef,
      submissionUrl: draftPath ?? undefined,
      status: "draft",
      details:
        `Email draft + deliverable saved to ` +
        (draftPath ?? "(write failed — see logs)") +
        `. Operator must review + send manually.`,
      adapterId: this.id,
    };
  }
}

// ---------------------------------------------------------------------------
// Draft builder
// ---------------------------------------------------------------------------

/**
 * Write the email draft + the deliverable to a single text file the
 * operator can open, review, and copy-paste into their mail client.
 *
 * Structure:
 *   1. Operator instructions (what to do next).
 *   2. Cover-letter email (subject + body) — pre-filled, ready to send.
 *   3. The deliverable's approach.
 *   4. The deliverable's files (as code blocks).
 *   5. Test outcomes.
 *   6. Disclosure.
 */
async function writeEmailDraft(input: SubmissionInput): Promise<string> {
  const dir = path.join(SUBMISSIONS_ROOT, input.opportunityId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "email-draft.txt");

  const op = input.opportunity;
  const approach = (input.deliverable.approach || "(no approach provided)").trim();
  const tests = input.deliverable.tests.filter(Boolean);
  const files = input.deliverable.files;

  // Detect a likely recipient email from the source URL (best-effort).
  const recipientHint = guessRecipient(op.sourceUrl, op.organization);

  const lines: string[] = [
    "================================================================================",
    "EMAIL DRAFT — prepared by the CryptoEarn autonomous agent",
    "================================================================================",
    "",
    `Opportunity: ${op.title}`,
    `Organization: ${op.organization || "(unknown)"}`,
    `Source URL: ${op.sourceUrl}`,
    `Reward: ${op.rewardAmount} ${op.rewardCurrency}`,
    "",
    "OPERATOR ACTION REQUIRED:",
    "  1. Review the cover letter below.",
    "  2. Send it (with the attached deliverable files) to the opportunity",
    "     contact at the source URL.",
    "  3. Mark the opportunity as `awaiting_payment` in the dashboard once sent.",
    "",
    "================================================================================",
    "COVER LETTER",
    "================================================================================",
    "",
    `To: ${recipientHint}`,
    `Subject: Submission: ${op.title}`,
    "",
    "Hello,",
    "",
    approach,
    "",
    "I've attached the deliverable files below. Please let me know if you",
    "need any changes or additional context.",
    "",
    "Thank you for the opportunity.",
    "",
    "Best regards,",
    "[OPERATOR NAME]",
    "",
    "================================================================================",
    "DELIVERABLE FILES",
    "================================================================================",
    "",
  ];

  if (files.length === 0) {
    lines.push("(no files — deliverable was prose-only)", "");
  } else {
    for (const f of files) {
      const fence = "```".padEnd(3, "`");
      lines.push(`--- ${f.path} (${f.language || "text"}) ---`, "");
      lines.push(fence + (f.language || ""));
      lines.push(f.content);
      lines.push("```", "");
    }
  }

  if (tests.length > 0) {
    lines.push("================================================================================", "TEST OUTCOMES", "================================================================================", "");
    for (const t of tests) {
      lines.push(`- ${t}`);
    }
    lines.push("");
  }

  lines.push(
    "================================================================================",
    "DISCLOSURE",
    "================================================================================",
    "",
    "This draft was prepared by the CryptoEarn autonomous agent. The agent",
    "cannot send email on your behalf — manual operator review + send is",
    "required. No submission has been faked.",
    ""
  );

  await fs.writeFile(filePath, lines.join("\n"), "utf8");

  // Also dump each file separately so the operator can attach them.
  for (const f of files) {
    const safeName = f.path.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
    const attachmentPath = path.join(dir, `attachment-${safeName}`);
    try {
      await fs.writeFile(attachmentPath, f.content, "utf8");
    } catch (err) {
      console.warn("[email-draft-adapter] attachment write failed:", err);
    }
  }

  return filePath;
}

/**
 * Best-effort guess of the recipient email from the source URL + org.
 * Returns a placeholder when nothing sensible can be derived.
 */
function guessRecipient(sourceUrl: string, organization: string): string {
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) {
    return "[OPPORTUNITY CONTACT EMAIL]";
  }
  try {
    const url = new URL(sourceUrl);
    const host = url.hostname.replace(/^www\./, "");
    // mailto: links — extract the address directly.
    if (url.protocol === "mailto:") {
      return url.pathname;
    }
    // Default postmaster guess for the domain.
    return `postmaster@${host}`;
  } catch {
    if (organization) {
      return `[contact at ${organization}]`;
    }
    return "[OPPORTUNITY CONTACT EMAIL]";
  }
}
