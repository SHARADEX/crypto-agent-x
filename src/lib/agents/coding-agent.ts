// Coding Agent (spec §4B, Phase-2 §20 — REAL sandboxed software worker).
//
// What this agent does (Phase-2 §20 pipeline):
//
//   1. Load the opportunity + sanitize its description (spec §21).
//   2. Create an isolated CodingWorkspace under `os.tmpdir()`.
//   3. If the opportunity's `sourceUrl` is a GitHub repo / issue / PR,
//      shallow-clone it into the workspace. Otherwise, initialise an
//      empty git repo so `createDiff` works.
//   4. Inspect the workspace (list files, read package.json + README) —
//      pass that as context to the LLM.
//   5. Optionally fetch additional context via the Research Agent's tools
//      (fetchUrl, search) when the repo is empty or the issue body is short.
//   6. Call `callLLM` with a coding prompt and ask for strict JSON:
//        { approach, files: [{path, content, language}],
//          tests: [{path, content, framework}], dependencies: [...] }.
//   7. Write each generated file to the workspace via `workspace.writeFile`.
//   8. Run `inspectGeneratedCode` on every file — ABORT if any file is unsafe.
//   9. Install dependencies (if package.json changed).
//  10. Run the generated tests via `workspace.runTests()`.
//  11. If tests fail, do ONE iteration: pass the failures back to the LLM,
//      ask for a fix, re-write, re-run. (Spec §20 step 9: "iterate".)
//  12. Generate a diff/patch via `workspace.createDiff()`.
//  13. Run a final safety check on the patch.
//  14. Persist the full result on the Task output.
//  15. ALWAYS clean up the workspace (try/finally via `withWorkspace`).
//
// The orchestrator NEVER auto-pushes or submits — the patch + test results
// are stored on the Task row and a human approval is required before any
// PR submission (spec §20: "Do not automatically push or submit unless
// policy allows it").
//
// NEVER throws out of `execute` — returns `{ success: false, result: { error } }`.
// Budget-aware (every LLM call + git clone goes through the budget tracker).

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import { callLLM } from "@/lib/llm/provider";
import { route } from "@/lib/llm/router";
import { validateJSON } from "@/lib/llm/deterministic";
import { inspectGeneratedCode } from "@/lib/security/code-safety";
import { sanitizeExternalContent } from "@/lib/security/prompt-injection";
import { validateUrl } from "@/lib/security/url-validator";
import { getResearchTool } from "@/lib/research/research-tool";
import {
  withWorkspace,
  CodingWorkspace,
  type TestResult,
  type ExecResult,
} from "@/lib/coding";
import type { AgentInput, AgentOutput } from "@/lib/agents/types";
import { fail, fieldStringArray, ok } from "@/lib/agents/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One file produced by the LLM (raw + post-safety). */
export interface CodingFile {
  path: string;
  language: string;
  content: string;
  safety?: {
    safe: boolean;
    riskScore: number;
    findings: Array<{ id: string; severity: string; detail: string }>;
  };
}

/** One test file produced by the LLM. */
export interface CodingTestFile {
  path: string;
  content: string;
  framework: string;
}

/** Persisted to `Task.output` as JSON. Consumed by the Review Agent + dashboard. */
export interface CodingSolutionOutline {
  approach: string;
  files: CodingFile[];
  tests: CodingTestFile[];
  dependencies: string[];
  estimated_hours: number;
  safety: {
    safe: boolean;
    riskScore: number;
    findings: Array<{ id: string; severity: string; detail: string }>;
  };
  /** True iff `runTests()` reported `ok === true`. */
  testsPassed: boolean;
  /** Parsed pass/fail counts + raw runner output (truncated). */
  testResults?: {
    framework: string;
    passed: number;
    failed: number;
    ok: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    iterations: number;
  };
  /** The diff (unified patch) of the workspace vs HEAD, ready to submit
   *  for human review. Empty when no repo was cloned/initialised. */
  diff: string;
  /** `git status --short` output at the time the patch was generated. */
  diffStatus: string;
  /** Where the workspace came from: "cloned" (gitClone succeeded) |
   *  "empty" (no repo URL or clone failed; initialised an empty git repo). */
  workspaceOrigin: "cloned" | "empty" | "failed_clone";
  /** The repo URL that was cloned (empty if none). */
  repoUrl: string;
  /** The model that produced the solution. */
  model: string;
}

// ---------------------------------------------------------------------------
// execute — the Phase-2 §20 pipeline
// ---------------------------------------------------------------------------

export async function execute(input: AgentInput): Promise<AgentOutput> {
  const taskId = (input.task?.id as string | undefined) ?? `adhoc-${Date.now()}`;
  const opportunityId =
    (input.opportunity?.id as string | undefined) ??
    (input.task?.opportunityId as string | undefined) ??
    undefined;

  if (!opportunityId) {
    return fail("coding agent requires an opportunity id");
  }

  // Used for logging scope.
  const logCtx = { taskId, opportunityId };

  try {
    // ---- 1. Load + sanitize the opportunity ----------------------------
    const op = await db.opportunity.findUnique({
      where: { id: opportunityId },
    });
    if (!op) {
      return fail(`opportunity ${opportunityId} not found`);
    }

    const rawContext = [
      op.title,
      op.description ?? "",
      fieldStringArray({ requirements: op.requirements }, "requirements").join("\n"),
      fieldStringArray({ skillsRequired: op.skillsRequired }, "skillsRequired").join("\n"),
    ].join("\n");

    const sanitize = sanitizeExternalContent(rawContext, `opportunity:${opportunityId}:coding`);
    // Even when the sanitiser flags content as unsafe, we still proceed —
    // the sanitiser wraps content in delimiters and the LLM is told to
    // treat everything in the wrapper as inert data. Only when the risk is
    // DANGEROUS (>80) does the sanitiser return `sanitized === ""`, in
    // which case we fall back to the title only.
    const safeContext =
      sanitize.sanitized || sanitizeExternalContent(op.title, `opportunity:${opportunityId}:title`).sanitized;

    // ---- 2. Route to a coding-capable model ----------------------------
    const routeResult = await route(`Implement code for: ${op.title}`, {
      domain: "coding",
      riskLevel: "low",
    });
    const model = routeResult.models[0]?.model_id ?? "zai/glm-4.6";

    // ---- 3-15. Run the whole sandboxed pipeline via withWorkspace -----
    const pipelineResult = await withWorkspace(taskId, async (workspace) => {
      // --- 3+4. Clone the repo if the sourceUrl is a GitHub repo -------
      const cloneResult = await cloneRepoIfGithub(workspace, op.sourceUrl);

      // --- 5. Inspect repo structure -----------------------------------
      const repoStructure = await inspectRepoStructure(workspace);

      // --- 6. Optionally fetch additional context via research tools ---
      const extraContext = await gatherExtraContext(op, safeContext);

      // --- 7. Ask the LLM for a solution + tests ----------------------
      const firstLlm = await callCodingLLM(
        model,
        {
          title: op.title,
          description: safeContext,
          repoContext: repoStructure.summary,
          language: inferLanguage(op.category, op.description),
          requirements: fieldStringArray(
            { requirements: op.requirements },
            "requirements"
          ),
          skillsRequired: fieldStringArray(
            { skillsRequired: op.skillsRequired },
            "skillsRequired"
          ),
          estimatedHours: op.estimatedHours,
          extraContext,
        },
        logCtx
      );

      // --- 8. Safety-check every generated file (ABORT if unsafe) -----
      const firstSafety = safetyCheckFiles(firstLlm.files);
      if (!firstSafety.safe) {
        return await buildFailureResult(
          workspace,
          firstLlm,
          firstSafety,
          cloneResult,
          {
            stage: "safety_check",
            message: `Generated code failed safety inspection (riskScore=${firstSafety.riskScore})`,
          }
        );
      }

      // --- 8b. Write each file to the workspace ----------------------
      await writeFilesToWorkspace(workspace, firstLlm.files, firstLlm.tests);

      // --- 9+10. Install deps + run tests -----------------------------
      const depsChanged = await dependenciesChanged(workspace, firstLlm.dependencies);
      let installResult: ExecResult | null = null;
      if (depsChanged) {
        installResult = await workspace.installDeps();
      }

      let testResult = await workspace.runTests();

      // --- 11. ONE iteration if tests failed -------------------------
      let iterations = 1;
      // Snapshot the LLM-chosen files + their safety metadata. When the
      // fix iteration runs, we build a NEW outline object rather than
      // mutating `firstLlm` so the original attempt stays pristine for
      // audit-log reconstruction.
      let finalFiles = firstLlm.files.map((f, idx) => ({
        ...f,
        safety: safetyForFile(firstSafety, idx),
      }));
      let finalTests = firstLlm.tests;
      let finalApproach = firstLlm.approach;
      let finalDeps = firstLlm.dependencies;
      let finalHours = firstLlm.estimated_hours;
      let finalSafetyAggregate = firstSafety;
      if (!testResult.ok && firstLlm.files.length > 0) {
        iterations = 2;
        const fixLlm = await callCodingLLM(
          model,
          {
            title: op.title,
            description: safeContext,
            repoContext: repoStructure.summary,
            language: inferLanguage(op.category, op.description),
            requirements: fieldStringArray(
              { requirements: op.requirements },
              "requirements"
            ),
            skillsRequired: fieldStringArray(
              { skillsRequired: op.skillsRequired },
              "skillsRequired"
            ),
            estimatedHours: op.estimatedHours,
            extraContext,
            previousAttempt: {
              approach: firstLlm.approach,
              files: firstLlm.files.map((f) => ({
                path: f.path,
                language: f.language,
                content: f.content,
              })),
              tests: firstLlm.tests.map((t) => ({
                path: t.path,
                framework: t.framework,
                content: t.content,
              })),
              testOutput: truncateForLLM(
                `${testResult.stdout}\n--- stderr ---\n${testResult.stderr}`
              ),
              testExitCode: testResult.exitCode,
              framework: testResult.framework,
            },
          },
          logCtx
        );

        // Safety-check the fix too.
        const fixSafety = safetyCheckFiles(fixLlm.files);
        if (fixSafety.safe) {
          // Rewrite files + re-run.
          await writeFilesToWorkspace(workspace, fixLlm.files, fixLlm.tests);
          if (depsChanged || fixLlm.dependencies.length > 0) {
            await workspace.installDeps();
          }
          testResult = await workspace.runTests();
          finalFiles = fixLlm.files.map((f, idx) => ({
            ...f,
            safety: safetyForFile(fixSafety, idx),
          }));
          finalTests = fixLlm.tests;
          finalApproach = fixLlm.approach;
          finalDeps = fixLlm.dependencies;
          finalHours = fixLlm.estimated_hours;
          finalSafetyAggregate = fixSafety;
        } else {
          // Keep the original attempt; the fix was worse.
          await logEvent(
            "coding",
            "warn",
            "coding_fix_iteration_unsafe",
            { opportunityId, taskId, riskScore: fixSafety.riskScore },
            logCtx
          );
        }
      }

      // --- 12. Generate diff/patch -----------------------------------
      const { patch, status } = await workspace.createDiff();

      // --- 13. Final safety check on the patch -----------------------
      const patchSafety = inspectGeneratedCode(patch, "shell");
      const safe =
        finalSafetyAggregate.safe &&
        patchSafety.safe &&
        testResult.ok;

      // --- 14. Build the result object -------------------------------
      const outline: CodingSolutionOutline = {
        approach: finalApproach,
        files: finalFiles,
        tests: finalTests,
        dependencies: finalDeps,
        estimated_hours: finalHours,
        safety: {
          safe,
          riskScore: Math.max(finalSafetyAggregate.riskScore, patchSafety.riskScore),
          findings: [
            ...finalSafetyAggregate.findings,
            ...patchSafety.findings.map((f) => ({
              id: `patch:${f.id}`,
              severity: f.severity,
              detail: f.detail,
            })),
          ],
        },
        testsPassed: testResult.ok,
        testResults: {
          framework: testResult.framework,
          passed: testResult.passed,
          failed: testResult.failed,
          ok: testResult.ok,
          exitCode: testResult.exitCode,
          stdout: truncateForLLM(testResult.stdout),
          stderr: truncateForLLM(testResult.stderr),
          iterations,
        },
        diff: patch,
        diffStatus: status,
        workspaceOrigin: cloneResult.origin,
        repoUrl: cloneResult.repoUrl,
        model,
      };

      await logEvent(
        "coding",
        safe ? "info" : "warn",
        safe ? "coding_solution_generated" : "coding_solution_unsafe",
        {
          opportunityId,
          taskId,
          model,
          fileCount: outline.files.length,
          testCount: outline.tests.length,
          testsPassed: outline.testsPassed,
          framework: outline.testResults?.framework,
          testPassed: outline.testResults?.passed,
          testFailed: outline.testResults?.failed,
          iterations,
          workspaceOrigin: outline.workspaceOrigin,
          repoUrl: outline.repoUrl,
          patchRiskScore: patchSafety.riskScore,
          codeRiskScore: firstSafety.riskScore,
          safe,
        },
        logCtx
      );

      // Stash installResult for the caller's audit log (not persisted on
      // the outline itself — it would bloat the JSON column).
      void installResult;

      const safetyBundle: SafetyBundle = {
        safe,
        firstSafety: finalSafetyAggregate,
        patchSafety: {
          safe: patchSafety.safe,
          riskScore: patchSafety.riskScore,
          findings: patchSafety.findings.map((f) => ({
            id: f.id,
            severity: f.severity,
            detail: f.detail,
          })),
        },
      };
      return { outline, testResult, safety: safetyBundle };
    });

    // ---- 14b. Persist the outline to the Task row ---------------------
    const outline = pipelineResult.outline;
    if (taskId && !taskId.startsWith("adhoc-")) {
      try {
        await db.task.update({
          where: { id: taskId },
          data: {
            output: JSON.stringify(outline),
            modelId: model,
            qualityScore: outline.safety.safe && outline.testsPassed ? 8 : 3,
          },
        });
      } catch (err) {
        console.error("[coding-agent] task output persist failed:", err);
      }
    }

    // ---- 15. Return success IFF tests pass AND safety checks pass -----
    if (outline.safety.safe && outline.testsPassed) {
      return ok(outline as unknown as Record<string, unknown>, {
        qualityScore: 8,
        nextAgent: "review",
        notes: [
          `tests: ${outline.testResults?.passed ?? 0} passed / ${outline.testResults?.failed ?? 0} failed (${outline.testResults?.framework}, ${outline.testResults?.iterations} iteration(s))`,
          `workspace: ${outline.workspaceOrigin} (${outline.repoUrl || "no repo"})`,
          `files: ${outline.files.length}`,
          "Awaiting human approval before PR submission (spec §20).",
        ],
      });
    }
    return fail(
      `coding agent did not produce a green result (safe=${outline.safety.safe}, testsPassed=${outline.testsPassed})`,
      outline as unknown as Record<string, unknown>
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[coding-agent] execute threw:", err);
    await logEvent(
      "coding",
      "error",
      "coding_failed",
      { opportunityId, error: message },
      { taskId, opportunityId }
    );
    return fail(`coding agent crashed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Clone helper
// ---------------------------------------------------------------------------

interface CloneOutcome {
  origin: "cloned" | "empty" | "failed_clone";
  repoUrl: string;
}

/**
 * If `sourceUrl` is a GitHub repo / issue / PR URL, derive the canonical
 * `https://github.com/owner/repo.git` URL and shallow-clone it into the
 * workspace. Otherwise, `git init` an empty repo so `createDiff` works.
 *
 * Never throws — returns an outcome descriptor.
 */
async function cloneRepoIfGithub(
  workspace: CodingWorkspace,
  sourceUrl: string
): Promise<CloneOutcome> {
  const empty: CloneOutcome = { origin: "empty", repoUrl: "" };
  if (!sourceUrl || typeof sourceUrl !== "string") {
    await workspace.gitInit().catch(() => null);
    return empty;
  }

  const repoUrl = deriveGithubRepoUrl(sourceUrl);
  if (!repoUrl) {
    // Not a GitHub URL — initialise an empty repo so createDiff works.
    await workspace.gitInit().catch(() => null);
    return empty;
  }

  // Validate the derived URL once more (defence in depth — deriveGithubRepoUrl
  // already restricts to github.com, but a non-public hostname slipped
  // through would be caught here).
  const validation = validateUrl(repoUrl, { allowedSchemes: ["https:"] });
  if (!validation.valid || !validation.safe) {
    await workspace.gitInit().catch(() => null);
    return empty;
  }

  const cloneResult = await workspace.gitClone(repoUrl, { depth: 1 });
  if (cloneResult.exitCode !== 0) {
    // Clone failed — fall back to an empty workspace so the agent can still
    // produce a self-contained patch.
    await logEvent(
      "coding",
      "warn",
      "coding_git_clone_failed",
      {
        repoUrl,
        exitCode: cloneResult.exitCode,
        stderr: truncateForLLM(cloneResult.stderr),
      },
      { taskId: workspace.taskId }
    ).catch(() => null);
    await workspace.gitInit().catch(() => null);
    return { origin: "failed_clone", repoUrl };
  }

  return { origin: "cloned", repoUrl };
}

/**
 * Convert a GitHub URL (issue, PR, or repo root) into a canonical
 * `https://github.com/owner/repo.git` clone URL. Returns `""` if the
 * URL is not a GitHub URL or doesn't match the expected path shape.
 *
 * Examples accepted:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/issues/123
 *   https://github.com/owner/repo/pull/45
 *   https://github.com/owner/repo/tree/main/src
 *   https://github.com/owner/repo.git
 */
export function deriveGithubRepoUrl(sourceUrl: string): string {
  if (!sourceUrl || typeof sourceUrl !== "string") return "";
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return "";

  // Path shape: /owner/repo/...
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return "";
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) return "";
  // Strip trailing `.git` if present.
  const cleanRepo = repo.replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(cleanRepo)) {
    return "";
  }
  return `https://github.com/${owner}/${cleanRepo}.git`;
}

// ---------------------------------------------------------------------------
// Repo inspection
// ---------------------------------------------------------------------------

interface RepoInspection {
  summary: string;
}

/**
 * Build a compact summary of the workspace's file tree + key files
 * (package.json, README, pyproject.toml, go.mod, Cargo.toml) so the LLM
 * has context without us dumping the entire repo into the prompt.
 */
async function inspectRepoStructure(
  workspace: CodingWorkspace
): Promise<RepoInspection> {
  const files = await workspace.listFiles();
  if (files.length === 0) {
    return { summary: "(empty workspace — no files yet)" };
  }

  // Cap the file list to keep the prompt manageable.
  const cap = 200;
  const truncated = files.length > cap;
  const listed = truncated ? files.slice(0, cap) : files;
  const tree = listed.join("\n") + (truncated ? `\n…(${files.length - cap} more)` : "");

  // Read up to 4 key files (cap each at 4 KB).
  const keyFiles = [
    "package.json",
    "README.md",
    "readme.md",
    "pyproject.toml",
    "go.mod",
    "Cargo.toml",
  ];
  const readables: string[] = [];
  for (const rel of keyFiles) {
    const content = await workspace.readFile(rel);
    if (content) {
      const capped = content.length > 4096 ? content.slice(0, 4096) + "\n…[truncated]" : content;
      readables.push(`--- ${rel} ---\n${capped}`);
    }
  }

  const summary = [
    `Files (first ${listed.length} of ${files.length}):`,
    tree,
    "",
    ...readables,
  ].join("\n");
  return { summary };
}

// ---------------------------------------------------------------------------
// Extra context (Research Agent's fetchUrl + search)
// ---------------------------------------------------------------------------

/**
 * Fetch additional context for the coding prompt. We do this ONLY when
 * the opportunity's description is short (< 200 chars) — long descriptions
 * usually carry enough context. We fetch the sourceUrl (when it's a web
 * page, not a repo) and run one web search for the opportunity's title.
 *
 * Budget-aware: every fetch + search goes through `recordWebRequest`.
 */
async function gatherExtraContext(
  op: { title: string; description: string | null; sourceUrl: string },
  sanitizedDescription: string
): Promise<string> {
  // If the sanitised description is long enough, skip extra fetching to
  // conserve the web-request budget.
  if (sanitizedDescription.length > 800) return "";

  const tool = getResearchTool();
  const parts: string[] = [];

  // Fetch the source URL if it's a web page (not a github.com repo —
  // repos are cloned, not fetched).
  if (op.sourceUrl && !/github\.com/i.test(op.sourceUrl)) {
    try {
      const fetch = await tool.fetchUrl(op.sourceUrl, {
        timeoutMs: 8000,
        maxBytes: 64_000,
      });
      if (fetch.ok && fetch.text) {
        parts.push(
          `--- fetched source (${fetch.url}) ---\n${truncateForLLM(fetch.text, 4000)}`
        );
      }
    } catch (err) {
      console.warn("[coding-agent] fetchUrl failed:", err);
    }
  }

  // Run a single web search for the opportunity title (cap 3 results).
  try {
    const results = await tool.search(op.title, { maxResults: 3, timeoutMs: 8000 });
    if (results.length > 0) {
      const snippets = results
        .map((r, i) => `  ${i + 1}. ${r.title}\n     ${r.url}\n     ${truncateForLLM(r.snippet, 300)}`)
        .join("\n");
      parts.push(`--- web search results ---\n${snippets}`);
    }
  } catch (err) {
    console.warn("[coding-agent] search failed:", err);
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

interface LlmInput {
  title: string;
  description: string;
  repoContext: string;
  language: string;
  requirements: string[];
  skillsRequired: string[];
  estimatedHours: number;
  extraContext?: string;
  previousAttempt?: {
    approach: string;
    files: Array<{ path: string; language: string; content: string }>;
    tests: Array<{ path: string; framework: string; content: string }>;
    testOutput: string;
    testExitCode: number;
    framework: string;
  };
}

interface LlmOutline {
  approach: string;
  files: CodingFile[];
  tests: CodingTestFile[];
  dependencies: string[];
  estimated_hours: number;
}

async function callCodingLLM(
  modelId: string,
  op: LlmInput,
  ctx: { taskId?: string; opportunityId?: string }
): Promise<LlmOutline> {
  const isFix = !!op.previousAttempt;
  const systemPrompt = isFix
    ? [
        "You are the Coding Agent for an autonomous crypto-earning system.",
        "A previous attempt at this bounty was generated and its tests failed.",
        "Diagnose the failure from the test output, then produce a FIXED set of files.",
        "Return STRICT JSON with this exact shape:",
        "{",
        '  "approach": string,',
        '  "files": [{"path": string, "language": string, "content": string}],',
        '  "tests": [{"path": string, "framework": string, "content": string}],',
        '  "dependencies": string[],',
        '  "estimated_hours": number',
        "}",
        "",
        "Rules:",
        "- Do NOT include shell commands, network exfiltration, or eval/Function calls.",
        "- Do NOT include hardcoded secrets / API keys / private keys.",
        "- Address the SPECIFIC test failures shown below — do not rewrite from scratch.",
        "- Return ONLY the JSON object — no preamble, no markdown fences.",
      ].join("\n")
    : [
        "You are the Coding Agent for an autonomous crypto-earning system.",
        "Generate a working solution for the bounty below, plus a test file",
        "that proves the solution works. The tests MUST be runnable with",
        "the project's detected framework (jest/vitest/bun test/pytest/go/cargo).",
        "Return STRICT JSON with this exact shape:",
        "{",
        '  "approach": string,',
        '  "files": [{"path": string, "language": string, "content": string}],',
        '  "tests": [{"path": string, "framework": string, "content": string}],',
        '  "dependencies": string[],',
        '  "estimated_hours": number',
        "}",
        "",
        "Rules:",
        "- Do NOT include shell commands, network exfiltration, or eval/Function calls.",
        "- Do NOT include hardcoded secrets / API keys / private keys.",
        "- The tests MUST pass on the first run; do NOT write tests that depend",
        "  on network access or env vars that are not set.",
        "- Keep code minimal but complete — no TODO stubs.",
        "- Return ONLY the JSON object — no preamble, no markdown fences.",
      ].join("\n");

  const userPrompt = [
    `Title: ${op.title}`,
    `Language: ${op.language}`,
    `Estimated hours: ${op.estimatedHours}`,
    `Skills required: ${op.skillsRequired.join(", ") || "(none)"}`,
    `Requirements: ${op.requirements.join("; ") || "(none)"}`,
    op.repoContext ? `Repo context:\n${op.repoContext}` : "",
    op.extraContext ? `Extra context:\n${op.extraContext}` : "",
    `Description:\n${op.description}`,
    op.previousAttempt
      ? [
          "",
          "--- PREVIOUS ATTEMPT (tests failed) ---",
          `Approach: ${op.previousAttempt.approach}`,
          `Files:`,
          ...op.previousAttempt.files.map(
            (f) => `  ${f.path} (${f.language}):\n${truncateForLLM(f.content, 1500)}`
          ),
          `Tests:`,
          ...op.previousAttempt.tests.map(
            (t) => `  ${t.path} (${t.framework}):\n${truncateForLLM(t.content, 1000)}`
          ),
          `Test framework: ${op.previousAttempt.framework}`,
          `Test exit code: ${op.previousAttempt.testExitCode}`,
          `Test output:`,
          op.previousAttempt.testOutput,
          "",
          "Produce the FIXED files + tests that make the suite pass.",
        ].join("\n")
      : "",
  ]
    .filter((x) => x.length > 0)
    .join("\n");

  try {
    const result = await callLLM({
      modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      maxTokens: 2400,
      temperature: 0.4,
      responseFormat: "json",
      taskType: "coding",
      estimatedTokens: 3000,
      taskId: ctx.taskId,
      opportunityId: ctx.opportunityId,
    });

    if (result.success && result.content) {
      const parsed = parseOutline(result.content);
      if (parsed) return parsed;
    }

    await logEvent(
      "coding",
      "warn",
      "coding_llm_failed_no_outline",
      {
        opportunityId: ctx.opportunityId,
        model: modelId,
        error: result.error,
        fixIteration: isFix,
      },
      ctx
    );
  } catch (err) {
    console.error("[coding-agent] callLLM threw:", err);
  }

  // Empty outline — the pipeline will treat this as a failure.
  return {
    approach: isFix
      ? "Fix iteration produced no usable output."
      : "LLM produced no usable code — opportunity should be routed to human review.",
    files: [],
    tests: [],
    dependencies: [],
    estimated_hours: op.estimatedHours,
  };
}

function parseOutline(raw: string): LlmOutline | null {
  const validated = validateJSON(raw);
  if (!validated.valid || !validated.parsed || typeof validated.parsed !== "object") {
    return null;
  }
  const obj = validated.parsed as Record<string, unknown>;
  const approach = typeof obj.approach === "string" ? obj.approach : "";
  const filesRaw = Array.isArray(obj.files) ? obj.files : [];
  const files: CodingFile[] = filesRaw
    .map((f): CodingFile | null => {
      if (typeof f !== "object" || f === null) return null;
      const file = f as Record<string, unknown>;
      return {
        path: typeof file.path === "string" ? file.path : "untitled",
        language: typeof file.language === "string" ? file.language : "typescript",
        content: typeof file.content === "string" ? file.content : "",
      };
    })
    .filter((f): f is CodingFile => f !== null);

  const testsRaw = Array.isArray(obj.tests) ? obj.tests : [];
  const tests: CodingTestFile[] = testsRaw
    .map((t): CodingTestFile | null => {
      if (typeof t !== "object" || t === null) return null;
      const test = t as Record<string, unknown>;
      return {
        path: typeof test.path === "string" ? test.path : "test.spec.ts",
        framework: typeof test.framework === "string" ? test.framework : "node",
        content: typeof test.content === "string" ? test.content : "",
      };
    })
    .filter((t): t is CodingTestFile => t !== null);

  const dependencies = Array.isArray(obj.dependencies)
    ? obj.dependencies.filter((x): x is string => typeof x === "string")
    : [];

  const estimatedHours =
    typeof obj.estimated_hours === "number" && Number.isFinite(obj.estimated_hours)
      ? Math.max(0.5, obj.estimated_hours)
      : 1;

  return { approach, files, tests, dependencies, estimated_hours: estimatedHours };
}

// ---------------------------------------------------------------------------
// Safety helpers
// ---------------------------------------------------------------------------

interface FileSafetyAggregate {
  safe: boolean;
  riskScore: number;
  findings: Array<{ id: string; severity: string; detail: string }>;
  perFile: Array<{
    safe: boolean;
    riskScore: number;
    findings: Array<{ id: string; severity: string; detail: string }>;
  }>;
}

/**
 * Bundle returned from the withWorkspace pipeline — combines the
 * file-level safety aggregate with the final patch-level inspection so
 * the outer `execute` can decide what to persist on the Task row.
 */
interface SafetyBundle {
  safe: boolean;
  firstSafety: FileSafetyAggregate;
  patchSafety: {
    safe: boolean;
    riskScore: number;
    findings: Array<{ id: string; severity: string; detail: string }>;
  };
}

/**
 * Run `inspectGeneratedCode` on every file. Returns the worst-case
 * riskScore, all findings, and per-file safety objects (so we can stash
 * them back onto each `CodingFile.safety` field).
 */
function safetyCheckFiles(files: CodingFile[]): FileSafetyAggregate {
  let worstRisk = 0;
  const allFindings: FileSafetyAggregate["findings"] = [];
  const perFile: FileSafetyAggregate["perFile"] = [];
  for (const file of files) {
    const inspection = inspectGeneratedCode(file.content, file.language);
    worstRisk = Math.max(worstRisk, inspection.riskScore);
    for (const f of inspection.findings) {
      allFindings.push({
        id: f.id,
        severity: f.severity,
        detail: f.detail,
      });
    }
    perFile.push({
      safe: inspection.safe,
      riskScore: inspection.riskScore,
      findings: inspection.findings.map((f) => ({
        id: f.id,
        severity: f.severity,
        detail: f.detail,
      })),
    });
  }
  return {
    safe: worstRisk < 50,
    riskScore: worstRisk,
    findings: allFindings,
    perFile,
  };
}

function safetyForFile(
  aggregate: FileSafetyAggregate,
  idx: number
): CodingFile["safety"] | undefined {
  return aggregate.perFile[idx];
}

// ---------------------------------------------------------------------------
// Workspace writing
// ---------------------------------------------------------------------------

async function writeFilesToWorkspace(
  workspace: CodingWorkspace,
  files: CodingFile[],
  tests: CodingTestFile[]
): Promise<void> {
  for (const file of files) {
    await workspace.writeFile(file.path, file.content);
  }
  for (const test of tests) {
    await workspace.writeFile(test.path, test.content);
  }
}

async function dependenciesChanged(
  workspace: CodingWorkspace,
  declaredDeps: string[]
): Promise<boolean> {
  if (declaredDeps.length > 0) return true;
  // If package.json was written by the LLM, we should still install.
  const pkg = await workspace.readFile("package.json");
  return !!pkg;
}

// ---------------------------------------------------------------------------
// Failure result builder
// ---------------------------------------------------------------------------

async function buildFailureResult(
  workspace: CodingWorkspace,
  llm: LlmOutline,
  safety: FileSafetyAggregate,
  clone: CloneOutcome,
  failure: { stage: string; message: string }
): Promise<{
  outline: CodingSolutionOutline;
  testResult: TestResult;
  safety: SafetyBundle;
}> {
  const emptyTest: TestResult = {
    exitCode: 1,
    stdout: "",
    stderr: failure.message,
    timedOut: false,
    durationMs: 0,
    command: [],
    framework: "unknown",
    passed: 0,
    failed: 0,
    ok: false,
  };

  // Best-effort diff — even on failure, capture what was written so a
  // human reviewer can see what the LLM tried to do. If git init / diff
  // failed (e.g. workspace was never initialised), we get empty strings.
  let diff = "";
  let diffStatus = "";
  try {
    const diffResult = await workspace.createDiff();
    diff = diffResult.patch;
    diffStatus = diffResult.status;
  } catch (err) {
    console.warn("[coding-agent] createDiff failed during failure path:", err);
  }

  const outline: CodingSolutionOutline = {
    approach: llm.approach,
    files: llm.files.map((f, idx) => ({
      ...f,
      safety: safetyForFile(safety, idx),
    })),
    tests: llm.tests,
    dependencies: llm.dependencies,
    estimated_hours: llm.estimated_hours,
    safety: {
      safe: false,
      riskScore: safety.riskScore,
      findings: safety.findings,
    },
    testsPassed: false,
    testResults: {
      framework: "unknown",
      passed: 0,
      failed: 0,
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: failure.message,
      iterations: 0,
    },
    diff,
    diffStatus,
    workspaceOrigin: clone.origin,
    repoUrl: clone.repoUrl,
    model: "",
  };
  return {
    outline,
    testResult: emptyTest,
    safety: {
      safe: false,
      firstSafety: safety,
      patchSafety: { safe: true, riskScore: 0, findings: [] },
    },
  };
}

// ---------------------------------------------------------------------------
// Language inference + tiny helpers
// ---------------------------------------------------------------------------

function inferLanguage(category: string, description: string): string {
  const hay = `${category} ${description}`.toLowerCase();
  if (/solidity|smart contract|erc20|erc721|defi|web3/.test(hay)) {
    return "solidity";
  }
  if (/python/.test(hay)) return "python";
  if (/rust/.test(hay)) return "rust";
  if (/\bgo\b/.test(hay)) return "go";
  return "typescript";
}

function truncateForLLM(s: string, max = 3500): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…[truncated]";
}
