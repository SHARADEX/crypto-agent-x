// Orchestrator (spec §4A, §4M, §4U).
//
// The Orchestrator decides:
//   - what needs to be done
//   - why it needs to be done
//   - which specialist is appropriate
//   - what information that specialist needs
//   - whether the action requires approval
//   - whether the result should be verified
//   - what should happen next
//
// It is the ONLY component that creates Task rows; agents execute them and
// report back via `AgentOutput`. Every specialist invocation goes through
// `dispatchSpecialist` which:
//   1. Creates a Task row (from_agent="orchestrator", to_agent=<specialist>).
//   2. Marks the task "running" + stamps startedAt.
//   3. Invokes the agent's `execute(input)`.
//   4. Marks the task "success" / "failed" + stamps completedAt + writes
//      output.
//   5. Logs every transition via `logEvent`.
//
// Spec §4U lifecycle the orchestrator walks an opportunity through:
//
//   discovered → research → verification → economics → planning
//             → approval (if level >= 2) → execution → review
//             → payment verification → ledger → learning (recordVerifiedEarning)
//
// The orchestrator never blindly executes the entire chain — it checks the
// result of each stage and aborts (or routes to a different specialist)
// when a stage fails.

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import { canRun, getState } from "@/lib/agent/state";
import { refreshKillSwitchState } from "@/lib/kill-switch";
import { evaluateRisk } from "@/lib/policy";
import { getAdapterForCategory } from "@/lib/execution-adapters";
import { recordExpected } from "@/lib/economics/ledger";
import { recordStrategyOutcome } from "@/lib/economics/strategy-stats";
import type { AgentName, Opportunity, RiskLevel } from "@/lib/agent/types";
import type { AgentInput, AgentOutput } from "@/lib/agents/types";

import * as scoutAgent from "@/lib/agents/scout-agent";
import * as researchAgent from "@/lib/agents/research-agent";
import * as verificationAgent from "@/lib/agents/verification-agent";
import * as securityAgent from "@/lib/agents/security-agent";
import * as economicsAgent from "@/lib/agents/economics-agent";
import * as codingAgent from "@/lib/agents/coding-agent";
import * as web3Agent from "@/lib/agents/web3-agent";
import * as writingAgent from "@/lib/agents/writing-agent";
import * as executionAgent from "@/lib/agents/execution-agent";
import * as paymentAgent from "@/lib/agents/payment-agent";
import * as reviewAgent from "@/lib/agents/review-agent";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProcessOpportunityResult {
  opportunityId: string;
  initialStatus: string;
  finalStatus: string;
  steps: Array<{
    agent: AgentName;
    taskId: string | null;
    success: boolean;
    nextAgent?: AgentName;
    notes?: string[];
  }>;
  aborted: boolean;
  abortReason?: string;
}

export interface TickResult {
  processed: ProcessOpportunityResult | null;
  selectedOpportunityId: string | null;
  reason: string;
}

// ---------------------------------------------------------------------------
// Specialist registry
// ---------------------------------------------------------------------------

interface SpecialistEntry {
  agent: AgentName;
  execute: (input: AgentInput) => Promise<AgentOutput>;
  defaultRiskLevel: RiskLevel;
}

const SPECIALISTS: Record<string, SpecialistEntry> = {
  scout: { agent: "scout", execute: scoutAgent.execute, defaultRiskLevel: "read" },
  research: { agent: "research", execute: researchAgent.execute, defaultRiskLevel: "read" },
  verification: { agent: "verification", execute: verificationAgent.execute, defaultRiskLevel: "read" },
  security: { agent: "security", execute: securityAgent.execute, defaultRiskLevel: "read" },
  economics: { agent: "economics", execute: economicsAgent.execute, defaultRiskLevel: "read" },
  coding: { agent: "coding", execute: codingAgent.execute, defaultRiskLevel: "low" },
  web3: { agent: "web3", execute: web3Agent.execute, defaultRiskLevel: "moderate" },
  writing: { agent: "writing", execute: writingAgent.execute, defaultRiskLevel: "low" },
  execution: { agent: "execution", execute: executionAgent.execute, defaultRiskLevel: "low" },
  payment: { agent: "payment", execute: paymentAgent.execute, defaultRiskLevel: "read" },
  review: { agent: "review", execute: reviewAgent.execute, defaultRiskLevel: "read" },
};

// ---------------------------------------------------------------------------
// Retry governor (v0.5.1)
// ---------------------------------------------------------------------------

/**
 * Exponential backoff base for the consecutive-failure retry governor:
 * 1st failure → 1h cooldown, then 2h, 4h, 8h… capped at 24h. Without this,
 * a mid-flight opportunity whose specialist keeps failing (e.g. the coding
 * agent cannot produce a safe, test-passing solution for a hard repo) gets
 * re-picked by selectNextOpportunity EVERY cycle and burns the daily LLM
 * budget while 150+ discovered opportunities starve behind it.
 */
const RETRY_BACKOFF_BASE_MS = 60 * 60 * 1000; // 1 hour
const RETRY_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000; // 24 hours
/** After this many CONSECUTIVE failures the opportunity is moved to the
 * `failed` terminal state — the honest outcome for a task the pipeline
 * cannot complete. recordCycleLesson then stores an execution_lesson so
 * the strategy allocator learns from it. */
const RETRY_MAX_ATTEMPTS = 6;

// ---------------------------------------------------------------------------
// processOpportunity
// ---------------------------------------------------------------------------

/**
 * Walk an opportunity through its lifecycle. Each step:
 *   1. Loads the opportunity fresh from the DB.
 *   2. Decides which specialist to invoke based on its status + category.
 *   3. Dispatches via `dispatchSpecialist`.
 *   4. Checks the result; aborts or transitions to the next status.
 *
 * The orchestrator stops at the first specialist that returns
 * `success === false` (unless it's a soft failure like "awaiting payment"
 * which is a normal expected state).
 */
export async function processOpportunity(
  opportunityId: string
): Promise<ProcessOpportunityResult> {
  const result: ProcessOpportunityResult = {
    opportunityId,
    initialStatus: "unknown",
    finalStatus: "unknown",
    steps: [],
    aborted: false,
  };

  // --- 0. Kill switch / state gate -----------------------------------
  await refreshKillSwitchState();
  const gate = await canRun();
  if (!gate.canRun) {
    result.aborted = true;
    result.abortReason = `kill switch: ${gate.reason}`;
    await logEvent(
      "orchestrator",
      "warn",
      "process_opportunity_aborted_kill_switch",
      { opportunityId, reason: gate.reason }
    );
    return result;
  }

  // --- 1. Load the opportunity ---------------------------------------
  let op = await db.opportunity.findUnique({
    where: { id: opportunityId },
  });
  if (!op) {
    result.aborted = true;
    result.abortReason = `opportunity ${opportunityId} not found`;
    return result;
  }
  result.initialStatus = op.status;
  result.finalStatus = op.status;

  await logEvent(
    "orchestrator",
    "info",
    "process_opportunity_started",
    {
      opportunityId,
      status: op.status,
      category: op.category,
      title: op.title,
    },
    { opportunityId }
  );

  // --- 2. Walk the lifecycle -----------------------------------------
  // We re-load the opportunity after every specialist invocation so we
  // always see the latest status the agent wrote.
  let guard = 0;
  while (guard < 8) {
    guard += 1;
    op = (await db.opportunity.findUnique({
      where: { id: opportunityId },
    }))!;
    if (!op) {
      result.aborted = true;
      result.abortReason = "opportunity disappeared mid-processing";
      break;
    }
    result.finalStatus = op.status;

    // Refresh kill switch between stages too — the operator may pause
    // mid-cycle.
    await refreshKillSwitchState();
    const gate2 = await canRun();
    if (!gate2.canRun) {
      result.aborted = true;
      result.abortReason = `kill switch: ${gate2.reason}`;
      break;
    }

    const next = decideNextSpecialist(op);
    if (!next) {
      // Reached a terminal state (paid / failed / rejected).
      break;
    }

    const specialist = SPECIALISTS[next.agent];
    if (!specialist) {
      result.aborted = true;
      result.abortReason = `no specialist registered for '${next.agent}'`;
      break;
    }

    const agentInput: AgentInput = {
      opportunity: op as unknown as Record<string, unknown>,
      context: next.context,
    };

    const dispatched = await dispatchSpecialist(
      specialist,
      agentInput,
      opportunityId,
      next.objective
    );
    result.steps.push({
      agent: specialist.agent,
      taskId: dispatched.taskId,
      success: dispatched.output.success,
      nextAgent: dispatched.output.nextAgent,
      notes: dispatched.output.notes,
    });

    if (!dispatched.output.success) {
      // Soft failures (e.g. payment still pending) keep the opportunity in
      // an expected intermediate state. The orchestrator can come back
      // to it on a later cycle.
      const freshOp = await db.opportunity.findUnique({
        where: { id: opportunityId },
        select: { status: true },
      });
      result.finalStatus = freshOp?.status ?? op.status;
      if (
        freshOp?.status === "awaiting_payment" ||
        freshOp?.status === "submitted"
      ) {
        // Normal — the next cycle will retry payment verification, OR the
        // PR monitor will transition submitted → awaiting_payment when the
        // PR is merged (Phase-3 fix, Issue 10).
        break;
      }
      result.aborted = true;
      result.abortReason = `specialist '${specialist.agent}' reported failure: ${
        (dispatched.output.result.error as string) ?? "unknown"
      }`;

      // v0.5.1 retry governor — exponential backoff (see constants above).
      // Soft states (awaiting_payment / submitted) already broke out above;
      // anything left here is a genuine failure to advance.
      try {
        const nextCount = (op.attemptCount ?? 0) + 1;
        const backoffMs = Math.min(
          RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, nextCount - 1),
          RETRY_BACKOFF_MAX_MS
        );
        const exhausted = nextCount >= RETRY_MAX_ATTEMPTS;
        await db.opportunity.update({
          where: { id: opportunityId },
          data: {
            attemptCount: nextCount,
            lastAttemptAt: new Date(),
            // Once exhausted the status goes terminal `failed`; keep the
            // cooldown stamp anyway so a manual status reset still respects
            // the governor.
            nextRetryAt: exhausted ? null : new Date(Date.now() + backoffMs),
            ...(exhausted ? { status: "failed" } : {}),
          },
        });
        if (exhausted) {
          result.finalStatus = "failed";
          await logEvent(
            "orchestrator",
            "warn",
            "opportunity_retry_exhausted",
            {
              opportunityId,
              attemptCount: nextCount,
              movedToStatus: "failed",
              lastReason: result.abortReason.slice(0, 200),
            },
            { opportunityId }
          );
        } else {
          await logEvent(
            "orchestrator",
            "info",
            "opportunity_retry_backoff",
            {
              opportunityId,
              attemptCount: nextCount,
              backoffMinutes: Math.round(backoffMs / 60_000),
              reason: result.abortReason.slice(0, 200),
            },
            { opportunityId }
          );
        }
      } catch (govErr) {
        console.error(
          "[orchestrator] retry-governor update failed:",
          govErr
        );
      }
      break;
    }

    // v0.5.1 retry governor — a specialist SUCCEEDED, so the pipeline is
    // advancing: clear the consecutive-failure counter so any future
    // failure starts the backoff from 1h again (not from the stale count).
    if ((op.attemptCount ?? 0) > 0) {
      await db.opportunity
        .update({
          where: { id: opportunityId },
          data: { attemptCount: 0, nextRetryAt: null },
        })
        .catch((err) => {
          console.error(
            "[orchestrator] retry-governor reset failed:",
            err
          );
        });
    }

    // After the economics agent succeeds, transition the opportunity from
    // "verified" → "queued" via the policy gate (spec §4U). This creates the
    // expected earning (spec §14) and records the strategy attempt.
    if (specialist.agent === "economics" && op.status === "verified") {
      const queued = await queueForExecution(opportunityId);
      if (queued.queued) {
        result.steps.push({
          agent: "orchestrator",
          taskId: null,
          success: true,
          nextAgent: undefined,
          notes: [`queued for execution; requiresApproval=${queued.requiresApproval}; ${queued.reason}`],
        });
        // Reload so the loop sees "queued" and dispatches the deliverable
        // specialist (coding / web3 / writing) on the next iteration.
        op = (await db.opportunity.findUnique({
          where: { id: opportunityId },
        }))!;
      } else if (queued.reason.includes("not queueable") || queued.reason.includes("not found")) {
        // Skip silently — the opportunity may have already been queued by a
        // previous cycle or is in a terminal state.
      } else {
        // Policy rejected — opportunity is now "rejected".
        result.finalStatus = "rejected";
        result.steps.push({
          agent: "orchestrator",
          taskId: null,
          success: false,
          nextAgent: undefined,
          notes: [`policy rejected: ${queued.reason}`],
        });
        break;
      }
    }

    // After the deliverable specialist (coding / web3 / writing) succeeds,
    // transition "queued"/"planning"/"needs_improvement" → "executed"
    // (simulated execution). The deliverable IS the execution in this demo —
    // real submission adapters (GitHub PR, hackathon entry) would slot in
    // here. This unblocks the review → payment verification tail of the
    // lifecycle. Phase 3 §4: when the operator requested changes, the
    // opportunity is in `needs_improvement` and is routed back here so the
    // specialist can produce the next iteration.
    if (
      (specialist.agent === "coding" ||
        specialist.agent === "web3" ||
        specialist.agent === "writing") &&
      (op.status === "queued" ||
        op.status === "planning" ||
        op.status === "needs_improvement")
    ) {
      await db.opportunity.update({
        where: { id: opportunityId },
        data: { status: "executed" },
      }).catch((err) => {
        console.error("[orchestrator] post-deliverable transition failed:", err);
      });

      // Phase 3 §7: if this task has a current iteration, record the
      // deliverable specialist's output as the iteration's artifact so the
      // version-history UI can render it.
      try {
        const taskRow = dispatched.taskId
          ? await db.task.findUnique({
              where: { id: dispatched.taskId },
              select: { currentIterationId: true },
            })
          : null;
        if (taskRow?.currentIterationId && dispatched.output.result) {
          const { recordIterationResult } = await import(
            "@/lib/iteration/iteration-service"
          );
          const artifact = normalizeArtifact(dispatched.output.result);
          await recordIterationResult({
            iterationId: taskRow.currentIterationId,
            artifact: artifact as never,
            qualityScore: dispatched.output.qualityScore ?? undefined,
            status: "reviewed",
          });
        }
      } catch (err) {
        console.error(
          "[orchestrator] iteration artifact record failed:",
          err
        );
      }

      op = (await db.opportunity.findUnique({
        where: { id: opportunityId },
      }))!;
      result.steps.push({
        agent: "orchestrator",
        taskId: null,
        success: true,
        nextAgent: undefined,
        notes: [`deliverable produced → simulated execution (status=executed)`],
      });
    }

    // After the review agent succeeds on an "executed" opportunity, transition
    // to "approved" when a REAL PR submission is possible (GITHUB_TOKEN set +
    // GitHub issue sourceUrl + not mock mode) so the execution agent opens the
    // actual pull request and sets "submitted" itself; otherwise fall back to
    // "submitted" directly (Phase-3 fix, Issue 10 simulated path). The PR
    // monitor then transitions submitted → awaiting_payment ONLY when the PR
    // is actually merged (not on review acceptance). The review agent's own
    // verdict field is consulted when present; "needs_revision" sends the
    // opportunity back to "queued" for rework; "reject" → failed.
    if (specialist.agent === "review" && op.status === "executed") {
      const reviewResult = dispatched.output.result as Record<string, unknown> | undefined;
      const verdict = reviewResult?.verdict as string | undefined;
      const nextStatus =
        verdict === "needs_revision" ? "queued"
        : verdict === "reject" ? "failed"
        : realPrSubmissionEligible(op) ? "approved"
        : "submitted"; // Phase-3 fix (Issue 10): was "awaiting_payment".
      await db.opportunity.update({
        where: { id: opportunityId },
        data: { status: nextStatus },
      }).catch((err) => {
        console.error("[orchestrator] post-review transition failed:", err);
      });
      op = (await db.opportunity.findUnique({
        where: { id: opportunityId },
      }))!;
      result.steps.push({
        agent: "orchestrator",
        taskId: null,
        success: true,
        nextAgent: undefined,
        notes: [
          `review verdict='${verdict ?? "accept"}' → status=${nextStatus}${
            nextStatus === "approved" ? " (real PR submission path)" : ""
          }`,
        ],
      });
    }

    // Execution-agent gate blocks. The execution agent returns success=true
    // with allowed=false (policy / approval gate) or skipped=true (observe
    // mode) instead of a hard failure. Stop walking the lifecycle here — the
    // status stays "approved" and a later cycle retries once the operator
    // approves the pending Approval row (or raises the autonomy mode).
    // Without this break the dispatch loop would spin 8 times re-creating
    // blocked execution Tasks.
    if (specialist.agent === "execution") {
      const gateResult = dispatched.output.result as
        | Record<string, unknown>
        | undefined;
      if (
        gateResult &&
        (gateResult.allowed === false || gateResult.skipped === true)
      ) {
        result.steps.push({
          agent: "orchestrator",
          taskId: null,
          success: true,
          nextAgent: undefined,
          notes: [
            `execution gated: ${String(
              gateResult.reason ?? "blocked by policy/approval gate"
            )}`,
          ],
        });
        break;
      }
    }
  }

  result.finalStatus =
    (await db.opportunity.findUnique({
      where: { id: opportunityId },
      select: { status: true },
    }))?.status ?? result.finalStatus;

  await logEvent(
    "orchestrator",
    result.aborted ? "warn" : "info",
    "process_opportunity_completed",
    {
      opportunityId,
      initialStatus: result.initialStatus,
      finalStatus: result.finalStatus,
      stepCount: result.steps.length,
      aborted: result.aborted,
      abortReason: result.abortReason ?? null,
    },
    { opportunityId }
  );

  return result;
}

// ---------------------------------------------------------------------------
// decideNextSpecialist
// ---------------------------------------------------------------------------

interface NextSpecialist {
  agent: AgentName;
  objective: string;
  context?: Record<string, unknown>;
}

/**
 * Decide which specialist should run next, based on the opportunity's
 * current status and category. Returns `null` when the opportunity is in a
 * terminal state (paid / failed / rejected) — there is nothing more to do.
 *
 * Spec §4U example chain:
 *   discovered → research → verification → economics → planning
 *            → coding/web3/writing → review → execution → payment
 */
function decideNextSpecialist(op: {
  id: string;
  status: string;
  category: string;
  riskScore: number;
  verificationScore: number;
  expectedValue: number;
  capitalRequired: boolean;
  paymentVerified: boolean;
  title?: string;
  description?: string;
}): NextSpecialist | null {
  switch (op.status) {
    case "discovered":
      return {
        agent: "research",
        objective: "Deep-research the opportunity to surface requirements, eligibility, and evidence quality.",
      };

    case "researching":
      // The research agent sets status back to "discovered" or "verified"
      // when done. If we still see "researching" it means the agent crashed
      // mid-flight — re-run it.
      return {
        agent: "research",
        objective: "Resume research — previous attempt did not complete cleanly.",
      };

    case "verified":
      return {
        agent: "economics",
        objective: "Compute deterministic economics estimate (expected value, hourly, risk-adjusted).",
      };

    case "queued":
      // The orchestrator has decided to pursue — plan + dispatch the
      // specialist that produces the deliverable.
      return planDeliverable(op);

    case "planning":
      return planDeliverable(op);

    case "needs_improvement":
      // Phase 3 §4, §11: a prior iteration was rejected with feedback.
      // Route back to the deliverable specialist (coding / writing / web3)
      // so it can produce the next iteration. The orchestrator's
      // `dispatchSpecialist` will record the result on the latest
      // TaskIteration row via the iteration service.
      return planDeliverable(op);

    case "approved":
      return {
        agent: "execution",
        objective: "Execute the approved task — submit the deliverable to the source.",
        context: { action: "submit_solution", riskLevel: "low" },
      };

    case "executed":
      return {
        agent: "review",
        objective: "Independently review the executed deliverable before payment verification.",
      };

    case "submitted":
      // Phase-3 fix (Issue 10): the deliverable has been submitted (e.g. PR
      // opened) and is awaiting review/merge on the external platform.
      // The PR monitor (monitorSubmittedPRs) polls these opportunities and
      // transitions them to awaiting_payment (merged) or needs_improvement
      // (changes_requested) or failed (closed without merge). The
      // orchestrator does NOT dispatch a specialist for this status — it
      // just breaks out of the loop and lets the next cycle pick up any
      // PR-monitor transitions.
      return null;

    case "awaiting_payment":
      return {
        agent: "payment",
        objective: "Verify the payment has landed on a monitored wallet.",
      };

    case "paid":
    case "failed":
    case "rejected":
      return null;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Real-PR-submission eligibility (the missing execution wiring)
// ---------------------------------------------------------------------------

/**
 * True when this opportunity's deliverable can be submitted as a REAL
 * GitHub pull request right now:
 *   - not MOCK_MODE (mock runs keep the simulated path), AND
 *   - the adapter selection for (category, sourceUrl) resolves to the
 *     GithubPrAdapter AND that adapter is configured (GITHUB_TOKEN set).
 *
 * Used by the post-review transition: when the review agent accepts a
 * deliverable that can really be PR'd, the opportunity goes to status
 * "approved" so the execution agent opens the actual pull request
 * (subject to the policy + approval gates) instead of jumping straight
 * to "submitted" with no external artifact.
 */
function realPrSubmissionEligible(op: {
  category: string;
  sourceUrl: string;
}): boolean {
  if ((process.env.MOCK_MODE ?? "").toLowerCase() === "true") return false;
  try {
    const adapter = getAdapterForCategory(
      op.category ?? "",
      op.sourceUrl ?? ""
    );
    return adapter.id === "github-pr" && adapter.isConfigured();
  } catch {
    return false;
  }
}

/**
 * Pick the specialist that produces the opportunity's deliverable.
 *
 *   - coding_task, github_bounty, bug_bounty, developer_task → coding
 *   - hackathon → coding (or web3 if the description mentions smart contracts)
 *   - docs, content, oss_contribution → writing
 *   - data_task, freelance → coding
 *   - grant → writing (grant applications are mostly narrative)
 *   - ecosystem → coding
 *   - default → coding
 *
 * Spec §4B: "Only use [the Writing Agent] when the opportunity actually
 * rewards this type of work." We honour that by routing only docs/content/
 * oss_contribution/grant to the writing agent.
 */
function planDeliverable(op: {
  id: string;
  category: string;
  status: string;
  title?: string;
  description?: string;
}): NextSpecialist | null {
  // First time we plan: transition to "planning" status, then dispatch.
  // When called from "planning", dispatch directly.
  // (Both states route to the same specialist.)
  const category = op.category;
  // Spec §4B — the Writing Agent is for opportunities that reward written
  // deliverables (docs, articles, READMEs, grant proposals, OSS writeups).
  const writingCategories: Set<string> = new Set(["docs", "content", "oss_contribution", "grant"]);
  // Categories that are inherently smart-contract / web3 work. bug_bounty
  // is included because the majority of high-value bug bounties in the
  // crypto space target Solidity / EVM contracts.
  const web3Categories: Set<string> = new Set(["bug_bounty"]);

  // Keyword heuristic — even when the category isn't exclusively web3, a
  // description that mentions Solidity / smart contracts / EVM / DeFi
  // should route to the web3 agent (which has the contract-specific
  // safety pipeline: inspectGeneratedCode on Solidity snippets,
  // `requires_human_approval` flagging per spec §4B).
  const web3Keywords = /\b(solidity|smart\s*contract|web3|evm|defi|audit\s*contract|erc-?20|erc-?721|erc-?1155|gas\s*optimization|reentrancy|flash\s*loan)\b/i;
  const descriptionText = `${op.title ?? ""} ${op.description ?? ""}`;

  if (web3Categories.has(category) || web3Keywords.test(descriptionText)) {
    return {
      agent: "web3",
      objective: "Analyse the smart-contract requirements and prepare a safe solution outline.",
    };
  }
  if (writingCategories.has(category)) {
    return {
      agent: "writing",
      objective: "Draft the documentation/article/README that satisfies the opportunity requirements.",
      context: { format: "markdown" },
    };
  }
  return {
    agent: "coding",
    objective: "Generate a solution outline + code skeleton for the bounty.",
    context: { language: "typescript" },
  };
}

// ---------------------------------------------------------------------------
// dispatchSpecialist
// ---------------------------------------------------------------------------

interface DispatchedSpecialist {
  taskId: string;
  output: AgentOutput;
}

/**
 * Create a Task row, mark it running, invoke the specialist, mark it
 * success/failed, and write the output back. Every step is logged via
 * `logEvent`.
 *
 * Spec §4M: agents communicate via structured Task objects. The orchestrator
 * is the ONLY component that creates Task rows.
 */
async function dispatchSpecialist(
  specialist: SpecialistEntry,
  input: AgentInput,
  opportunityId: string,
  objective: string
): Promise<DispatchedSpecialist> {
  // --- 1. Create the Task row -----------------------------------------
  let task: { id: string };
  try {
    task = await db.task.create({
      data: {
        opportunityId,
        fromAgent: "orchestrator",
        toAgent: specialist.agent,
        objective,
        input: JSON.stringify(input.context ?? {}),
        status: "running",
        riskLevel: specialist.defaultRiskLevel,
        startedAt: new Date(),
      },
    });
  } catch (err) {
    console.error("[orchestrator] task create failed:", err);
    // Synthesize an empty task id so we can still report back.
    task = { id: "unknown" };
  }

  // --- 2. Invoke the specialist --------------------------------------
  const agentInput: AgentInput = {
    ...input,
    task: { id: task.id },
  };

  let output: AgentOutput;
  try {
    output = await specialist.execute(agentInput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[orchestrator] specialist '${specialist.agent}' threw:`,
      err
    );
    output = {
      success: false,
      result: { error: `specialist threw: ${message}` },
    };
  }

  // --- 3. Persist the result -----------------------------------------
  try {
    await db.task.update({
      where: { id: task.id },
      data: {
        status: output.success ? "success" : "failed",
        output: JSON.stringify(output.result),
        completedAt: new Date(),
        qualityScore: output.qualityScore ?? null,
      },
    });
  } catch (err) {
    console.error("[orchestrator] task update failed:", err);
  }

  await logEvent(
    "orchestrator",
    output.success ? "info" : "warn",
    output.success ? "specialist_dispatched" : "specialist_failed",
    {
      opportunityId,
      taskId: task.id,
      agent: specialist.agent,
      objective,
      nextAgent: output.nextAgent ?? null,
      qualityScore: output.qualityScore ?? null,
    },
    { taskId: task.id, opportunityId }
  );

  return { taskId: task.id, output };
}

// ---------------------------------------------------------------------------
// selectNextOpportunity
// ---------------------------------------------------------------------------

/**
 * Pick the next opportunity to process. Prefers opportunities in
 * `discovered` or `verified` status, ordered by `riskAdjustedHourly DESC`
 * (the economics engine's headline ranking score). Returns `null` if no
 * suitable opportunity exists.
 *
 * If an opportunity is already mid-flight (`researching`, `planning`,
 * `executing`, `awaiting_payment`), the orchestrator should resume it
 * rather than start a new one — that takes priority.
 *
 * The `strategyFilter` may be:
 *   - `null` / `undefined` — no filter, pick from any category.
 *   - a single `string` — exact match on `category` (legacy behaviour).
 *   - an array of strings — `category IN (...)` match (Phase 3 §36 — used
 *     by the strategy-family selector so we can pick any opportunity whose
 *     category rolls up into the selected family).
 */
export async function selectNextOpportunity(
  strategyFilter?: string | string[] | null
): Promise<string | null> {
  try {
    // 1. Resume any mid-flight opportunity first — EXCEPT ones the retry
    //    governor has put on cooldown (v0.5.1): a cooling-down opportunity
    //    already failed its specialist recently; re-running it now would
    //    just burn budget. It becomes selectable again once nextRetryAt
    //    passes (or immediately if a new cycle of successes resets it).
    const midflight = await db.opportunity.findFirst({
      where: {
        status: {
          in: [
            "researching",
            "planning",
            // Queued opportunities are mid-flight too: queueForExecution
            // runs mid-processOpportunity, so a crash/restart between the
            // queue step and the coding step used to orphan them forever
            // (nothing ever selected status "queued"). Resume them here.
            "queued",
            "approved",
            "executed",
            // NOTE (v0.5.1 starvation fix): "submitted" is deliberately NOT
            // resumed here. decideNextSpecialist("submitted") returns null —
            // the PR monitor (monitorSubmittedPRs, loop step 9b) owns that
            // status and runs EVERY cycle regardless of selection. Resuming
            // a submitted opportunity here just burns the cycle's single
            // selection on a guaranteed no-op (processOpportunity breaks
            // immediately), starving every other mid-flight opportunity for
            // the days/weeks the PR waits for review. "awaiting_payment"
            // stays — the payment agent does real work there.
            "awaiting_payment",
            "needs_improvement",
          ],
        },
        OR: [
          { nextRetryAt: null },
          { nextRetryAt: { lte: new Date() } },
        ],
      },
      orderBy: { updatedAt: "asc" },
      select: { id: true },
    });
    if (midflight) return midflight.id;

    // 2. Pick the highest-ranked `verified` opportunity (economics already
    //    computed) or a `discovered` opportunity that hasn't been processed
    //    yet.
    const where: Record<string, unknown> = {
      status: { in: ["discovered", "verified"] },
    };
    if (Array.isArray(strategyFilter) && strategyFilter.length > 0) {
      where.category = { in: strategyFilter };
    } else if (typeof strategyFilter === "string" && strategyFilter.length > 0) {
      where.category = strategyFilter;
    }
    const top = await db.opportunity.findFirst({
      where: where as never,
      orderBy: { riskAdjustedHourly: "desc" },
      select: { id: true },
    });
    return top?.id ?? null;
  } catch (err) {
    console.error("[orchestrator] selectNextOpportunity failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// tick — one unit of work
// ---------------------------------------------------------------------------

/**
 * Run ONE unit of work: select the next opportunity + process it.
 *
 * Used by the autonomous loop (`runCycle`) to advance one opportunity
 * through its lifecycle per cycle. Returns a `TickResult` summarising what
 * happened (or why nothing happened).
 */
export async function tick(): Promise<TickResult> {
  await refreshKillSwitchState();
  const gate = await canRun();
  if (!gate.canRun) {
    return { processed: null, selectedOpportunityId: null, reason: gate.reason };
  }

  const opportunityId = await selectNextOpportunity();
  if (!opportunityId) {
    return {
      processed: null,
      selectedOpportunityId: null,
      reason: "no opportunities ready to process",
    };
  }

  try {
    const processed = await processOpportunity(opportunityId);
    return {
      processed,
      selectedOpportunityId: opportunityId,
      reason: "ok",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[orchestrator] tick crashed:", err);
    await logEvent(
      "orchestrator",
      "error",
      "tick_crashed",
      { opportunityId, error: message },
      { opportunityId }
    );
    return {
      processed: null,
      selectedOpportunityId: opportunityId,
      reason: `tick crashed: ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Helper: queue an opportunity for execution (used by the orchestrator
// when economics + verification look good but the opportunity hasn't been
// queued yet). Exposed for the autonomous loop's approval-gate step.
// ---------------------------------------------------------------------------

/**
 * Transition a VERIFIED opportunity to QUEUED, record an expected earning
 * (spec §14), and decide whether the execution path needs human approval.
 *
 * Returns the policy verdict — if `requiredLevel >= 2`, the orchestrator
 * should create an Approval row and wait.
 */
export async function queueForExecution(
  opportunityId: string
): Promise<{ queued: boolean; requiresApproval: boolean; reason: string }> {
  try {
    const op = await db.opportunity.findUnique({
      where: { id: opportunityId },
    });
    if (!op) {
      return { queued: false, requiresApproval: false, reason: "opportunity not found" };
    }
    if (op.status !== "verified" && op.status !== "discovered") {
      return {
        queued: false,
        requiresApproval: false,
        reason: `opportunity status '${op.status}' is not queueable`,
      };
    }

    // Spec §11 — evaluate the policy verdict for this opportunity.
    // P0-5 fix: pass the agent's actual autonomyMode so the verdict matches
    // what `assertPolicy` would return at execution time. Without this,
    // queueForExecution always defaults to "observe" mode (evaluateRisk's
    // default) which forces requiredLevel=3 for every opportunity with
    // riskScore > 0 — even when the agent is in "full" autonomy. That
    // created a mismatch: queueForExecution wrote a level-3 Approval row
    // while assertPolicy (called later by the execution agent) returned
    // requiredLevel=2 in full autonomy, so the dashboard showed the wrong
    // risk tier for pending approvals.
    const agentState = await getState();
    const verdict = evaluateRisk(op as unknown as Opportunity, {
      autonomyMode: agentState.autonomyMode,
    });
    if (!verdict.allowed) {
      // Mark the opportunity as rejected if the policy hard-rejects it.
      await db.opportunity.update({
        where: { id: opportunityId },
        data: { status: "rejected" },
      });
      await logEvent(
        "orchestrator",
        "warn",
        "opportunity_policy_rejected",
        { opportunityId, reason: verdict.reason, requiredLevel: verdict.requiredLevel },
        { opportunityId }
      );
      return {
        queued: false,
        requiresApproval: false,
        reason: verdict.reason,
      };
    }

    // Transition to queued.
    await db.opportunity.update({
      where: { id: opportunityId },
      data: { status: "queued" },
    });

    // Record an expected earning (spec §14).
    await recordExpected(op as unknown as Opportunity);

    // Strategy stat: this is a "discovered → attempted" transition.
    await recordStrategyOutcome(op.category, {
      attempted: true,
    });

    // Spec §11 + §25 — when the policy verdict requires level 2+ (moderate
    // or high risk), persist a PENDING Approval row so the operator can
    // approve/reject via the dashboard. Without this row, the execution
    // agent's approval gate (execution-agent.ts:163-200) blocks forever
    // because no `status: "approved"` row ever exists. We create the row
    // here (idempotently — if a pending row already exists for this
    // opportunity, we reuse it rather than creating a duplicate).
    if (verdict.requiredLevel >= 2) {
      const riskLevel =
        verdict.requiredLevel >= 3
          ? op.capitalRequired
            ? "financial"
            : "high"
          : "moderate";
      const executionLevel = verdict.requiredLevel as 2 | 3;

      // Reuse an existing pending approval for the same opportunity to
      // avoid stacking duplicate rows if queueForExecution runs twice.
      const existingPending = await db.approval.findFirst({
        where: { opportunityId, status: "pending" },
        orderBy: { createdAt: "desc" },
      });
      if (!existingPending) {
        const approval = await db.approval.create({
          data: {
            opportunityId,
            riskLevel,
            executionLevel,
            reason: verdict.reason,
            status: "pending",
          },
        });
        await logEvent(
          "orchestrator",
          "info",
          "approval_requested",
          {
            opportunityId,
            approvalId: approval.id,
            requiredLevel: verdict.requiredLevel,
            riskLevel,
          },
          { opportunityId }
        );
      }
    }

    await logEvent(
      "orchestrator",
      "info",
      "opportunity_queued",
      {
        opportunityId,
        requiredLevel: verdict.requiredLevel,
        expectedValue: op.expectedValue,
        expectedHourly: op.expectedHourly,
        riskAdjustedHourly: op.riskAdjustedHourly,
      },
      { opportunityId }
    );

    return {
      queued: true,
      requiresApproval: verdict.requiredLevel >= 2,
      reason: verdict.reason,
    };
  } catch (err) {
    console.error("[orchestrator] queueForExecution failed:", err);
    return {
      queued: false,
      requiresApproval: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// normalizeArtifact — extract a minimal IterationArtifact shape from a
// specialist agent's AgentOutput.result. Used when the orchestrator
// records a deliverable onto the latest TaskIteration row (Phase 3 §7).
// ---------------------------------------------------------------------------

function normalizeArtifact(
  result: Record<string, unknown>
): {
  approach: string;
  files: Array<{
    path: string;
    language: string;
    content: string;
    safety?: unknown;
  }>;
  tests: Array<{ path: string; framework: string; content: string }>;
  diff?: string;
  safety?: unknown;
  testsPassed?: boolean;
  testResults?: unknown;
  model?: string;
} {
  const approach =
    typeof result.approach === "string" ? result.approach : "";
  const filesRaw = Array.isArray(result.files) ? result.files : [];
  const files: Array<{
    path: string;
    language: string;
    content: string;
    safety?: unknown;
  }> = [];
  for (const f of filesRaw) {
    if (typeof f !== "object" || f === null) continue;
    const file = f as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path : "";
    const language = typeof file.language === "string" ? file.language : "";
    const content = typeof file.content === "string" ? file.content : "";
    if (!path || !content) continue;
    files.push({ path, language, content, safety: file.safety });
  }

  const testsRaw = Array.isArray(result.tests) ? result.tests : [];
  const tests: Array<{ path: string; framework: string; content: string }> = [];
  for (const t of testsRaw) {
    if (typeof t !== "object" || t === null) continue;
    const test = t as Record<string, unknown>;
    tests.push({
      path: typeof test.path === "string" ? test.path : "",
      framework: typeof test.framework === "string" ? test.framework : "",
      content: typeof test.content === "string" ? test.content : "",
    });
  }

  return {
    approach,
    files,
    tests,
    diff: typeof result.diff === "string" ? result.diff : undefined,
    safety: result.safety,
    testsPassed:
      typeof result.testsPassed === "boolean" ? result.testsPassed : undefined,
    testResults: result.testResults,
    model: typeof result.model === "string" ? result.model : undefined,
  };
}
