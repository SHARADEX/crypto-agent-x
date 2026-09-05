// Research Agent (spec §4B, Phase-2 §12, §13, §14, §15, §21, P1-1).
//
// Deep-researches an opportunity: understand the requirements, identify
// eligibility, estimate competition, surface dependencies, and assess
// evidence quality. Returns STRUCTURED research findings (spec §4B:
// "It should return structured research rather than uncontrolled prose.")
//
// Phase-2 pipeline (the live web research upgrade):
//   1. Sanitize the opportunity's description via `sanitizeExternalContent`
//      (anti-prompt-injection — spec §21).
//   2. Build a research context bundle:
//      a. FETCH the opportunity's `sourceUrl` via `researchTool.fetchUrl()`
//         (with URL validation, robots.txt awareness, timeout, max-bytes,
//         HTML→text extraction, content sanitisation).
//      b. Extract 3-5 relevant links from the fetched source page.
//      c. SEARCH the web for the opportunity's title + organization via
//         `researchTool.search()` (multi-vendor fallback).
//      d. FETCH up to 3 of the top search results (with budget + timeout
//         caps).
//      e. Track every fetched URL + every search snippet via
//         `CitationTracker` so the LLM's citations can be validated.
//   3. Route the research task via the LLM router (Phase-2 §8
//      hierarchical classifier) to pick a research-capable model.
//   4. Call `callLLM` with a research prompt that passes the FULL bundle
//      (opportunity fields + fetched source content + search snippets +
//      citation list) as context, and constrains the model to return
//      strict JSON with a `citations[]` array.
//   5. Validate the JSON response via `validateJSON`.
//   6. Validate the LLM's citations against the tracker — DROP any
//      citation not in the fetched set (spec §15 — anti-hallucination).
//   7. If web access fails (no search provider configured, fetch timeout,
//      robots.txt disallow), fall back to the existing heuristic
//      (opportunity-fields-only) with `evidence_quality=3` and a note.
//   8. Persist the findings + validated citations on the Task output.
//
// Side effects:
//   - Updates the opportunity's status: "researching" → "verified".
//   - Logs every fetch + search via `logEvent("research", …)`.
//   - Never throws — failures return `{ success: false, result: { error } }`.

import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import { callLLM } from "@/lib/llm/provider";
import { route } from "@/lib/llm/router";
import { validateJSON } from "@/lib/llm/deterministic";
import { sanitizeExternalContent } from "@/lib/security/prompt-injection";
import { getResearchTool } from "@/lib/research/research-tool";
import {
  CitationTracker,
  extractCitedUrls,
} from "@/lib/research/source-citation";
import type { FetchResult, SearchResult } from "@/lib/research/types";
import type { AgentInput, AgentOutput } from "@/lib/agents/types";
import { fail, fieldStringArray, ok } from "@/lib/agents/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResearchFindings {
  requirements_summary: string;
  eligibility_assessment: string;
  competition_level: number; // 1..10
  estimated_hours_realistic: number;
  dependencies: string[];
  evidence_quality: number; // 1..10
  source_url?: string;
  notes: string[];
  /** Phase-2 §15: validated citation URLs (subset of fetched set). */
  citations: string[];
  /** Phase-2 §13: short prose summary of what the web research found. */
  web_research_summary?: string;
  /** Whether the research pass actually fetched live web content. */
  web_research_attempted: boolean;
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

/**
 * Deep-research an opportunity. See module docstring.
 */
export async function execute(input: AgentInput): Promise<AgentOutput> {
  const taskId = (input.task?.id as string | undefined) ?? undefined;
  const opportunityId =
    (input.opportunity?.id as string | undefined) ?? undefined;

  if (!opportunityId) {
    return fail("research agent requires an opportunity id");
  }

  try {
    // Load the opportunity fresh from the DB. The orchestrator may pass a
    // partial shape; we want every field the research prompt references.
    const op = await db.opportunity.findUnique({
      where: { id: opportunityId },
    });
    if (!op) {
      return fail(`opportunity ${opportunityId} not found`);
    }

    // Mark the opportunity as researching.
    await db.opportunity
      .update({
        where: { id: opportunityId },
        data: { status: "researching" },
      })
      .catch((err) => {
        console.error("[research-agent] status update failed:", err);
      });

    await logEvent(
      "research",
      "info",
      "research_started",
      {
        opportunityId,
        title: op.title,
        category: op.category,
        source: op.source,
      },
      { taskId, opportunityId }
    );

    // --- 1. Sanitize the description ----------------------------------------
    const sanitize = sanitizeExternalContent(
      op.description ?? "",
      `opportunity:${opportunityId}:description`
    );
    if (!sanitize.safe) {
      await logEvent(
        "research",
        "warn",
        "research_prompt_injection_detected",
        {
          opportunityId,
          riskScore: sanitize.riskScore,
          detectedPatterns: sanitize.detectedPatterns,
        },
        { taskId, opportunityId }
      );
    }
    const safeDescription = sanitize.sanitized || (op.description ?? "");

    // --- 2. Live web research (Phase-2 §12, §13, §14, P1-1) ----------------
    const researchTool = getResearchTool();
    const tracker = new CitationTracker();
    const fetchedPages: Array<{ url: string; title?: string; text: string }> = [];
    let searchResultsCount = 0;
    let webResearchAttempted = false;
    let webResearchError: string | undefined;

    // 2a. Fetch the opportunity's source URL (if it's a real URL).
    const sourceUrl = op.sourceUrl ?? "";
    if (sourceUrl && typeof sourceUrl === "string" && sourceUrl.startsWith("http")) {
      webResearchAttempted = true;
      const sourceValidation = researchTool.validateUrl(sourceUrl);
      if (sourceValidation.valid && sourceValidation.safe) {
        await logEvent(
          "research",
          "info",
          "research_fetch_source_url",
          { opportunityId, url: sourceUrl },
          { taskId, opportunityId }
        );
        const fetched = await researchTool.fetchUrl(sourceUrl, {
          timeoutMs: 10_000,
          maxBytes: 2 * 1024 * 1024,
        });
        if (fetched.ok && fetched.text) {
          tracker.addFetch(fetched, {
            title: op.title,
            snippet: op.description ?? undefined,
          });
          fetchedPages.push({
            url: fetched.url,
            title: op.title,
            text: fetched.text,
          });

          // 2b. Extract 3-5 relevant links from the fetched source page.
          if (fetched.raw) {
            const links = researchTool.extractLinks(
              fetched.raw,
              fetched.url
            );
            // We don't fetch these inline — they're recorded as
            // opportunities to fetch later if the search step misses them.
            // For now, just take the first 5 as candidate citations.
            for (const linkUrl of links.slice(0, 5)) {
              tracker.add({
                url: linkUrl,
                fetchedAt: fetched.fetchedAt,
                source: "search", // tagged "search" because not directly fetched
              });
            }
          }
        } else {
          await logEvent(
            "research",
            "warn",
            "research_fetch_source_url_failed",
            {
              opportunityId,
              url: sourceUrl,
              error: fetched.error ?? `HTTP ${fetched.status}`,
            },
            { taskId, opportunityId }
          );
          webResearchError = fetched.error ?? `source fetch failed: HTTP ${fetched.status}`;
        }
      } else {
        await logEvent(
          "research",
          "warn",
          "research_source_url_validation_failed",
          {
            opportunityId,
            url: sourceUrl,
            reasons: sourceValidation.reasons,
          },
          { taskId, opportunityId }
        );
        webResearchError = `source URL failed validation: ${sourceValidation.reasons.join("; ")}`;
      }
    }

    // 2c. Search the web for the opportunity's title + organization.
    if (op.title) {
      webResearchAttempted = true;
      const query = `${op.title}${op.organization ? ` ${op.organization}` : ""}`.slice(0, 200);
      await logEvent(
        "research",
        "info",
        "research_search_query",
        { opportunityId, query },
        { taskId, opportunityId }
      );
      const searchResults = await researchTool.search(query, {
        maxResults: 5,
        timeoutMs: 10_000,
      });
      searchResultsCount = searchResults.length;
      if (searchResults.length === 0) {
        await logEvent(
          "research",
          "warn",
          "research_search_no_results",
          { opportunityId, query },
          { taskId, opportunityId }
        );
        if (!webResearchError) {
          webResearchError = "search returned no results (no provider configured or all providers failed)";
        }
      }

      // 2d. Fetch up to 3 of the top search results.
      const topResults = searchResults.slice(0, 3);
      for (const result of topResults) {
        // Skip if this URL is the same as the opportunity's source URL —
        // we already fetched it.
        if (result.url === sourceUrl) continue;
        // Skip if the URL was already fetched via the link-extraction step.
        if (fetchedPages.some((p) => p.url === result.url)) continue;

        const v = researchTool.validateUrl(result.url);
        if (!v.valid || !v.safe) continue;

        await logEvent(
          "research",
          "info",
          "research_fetch_search_result",
          {
            opportunityId,
            url: result.url,
            title: result.title,
            source: result.source,
          },
          { taskId, opportunityId }
        );
        const fetched = await researchTool.fetchUrl(result.url, {
          timeoutMs: 10_000,
          maxBytes: 2 * 1024 * 1024,
        });
        if (fetched.ok && fetched.text) {
          tracker.addFetch(fetched, {
            title: result.title,
            snippet: result.snippet,
          });
          fetchedPages.push({
            url: fetched.url,
            title: result.title,
            text: fetched.text,
          });
        } else {
          // The fetch failed — record the search snippet as a citation
          // anyway, so the LLM has the search-engine summary available.
          tracker.addSearchResult(result);
        }
      }

      // 2e. Add the remaining (un-fetched) search snippets as citations
      // so the LLM has them as corroborating signals.
      for (const result of searchResults) {
        if (!fetchedPages.some((p) => p.url === result.url)) {
          tracker.addSearchResult(result);
        }
      }
    }

    // --- 3. Route to a research-capable model -------------------------------
    const description = `${op.title}. ${op.description ?? ""}`.slice(0, 800);
    const routeResult = await route(description, {
      domain: "research",
      riskLevel: "low",
    });
    const model =
      routeResult.models[0]?.model_id ?? "zai/glm-4.6";

    // --- 4. Call the LLM with the full research context bundle --------------
    const findings = await callResearchLLM(
      model,
      {
        id: op.id,
        title: op.title,
        description: safeDescription,
        source: op.source,
        sourceUrl: op.sourceUrl,
        organization: op.organization,
        category: op.category,
        rewardAmount: op.rewardAmount,
        rewardCurrency: op.rewardCurrency,
        estimatedHours: op.estimatedHours,
        difficulty: op.difficulty,
        competition: op.competition,
        requirements: fieldStringArray(
          { requirements: op.requirements },
          "requirements"
        ),
        eligibility: fieldStringArray(
          { eligibility: op.eligibility },
          "eligibility"
        ),
        skillsRequired: fieldStringArray(
          { skillsRequired: op.skillsRequired },
          "skillsRequired"
        ),
        paymentMethod: op.paymentMethod,
      },
      {
        fetchedPages,
        searchResultsCount,
        webResearchAttempted,
        webResearchError,
        tracker,
      },
      { taskId, opportunityId }
    );

    // --- 5. Persist the findings + transition status -----------------------
    const nextStatus: "verified" = "verified";

    try {
      await db.opportunity.update({
        where: { id: opportunityId },
        data: {
          status: nextStatus,
        },
      });
    } catch (err) {
      console.error("[research-agent] status transition failed:", err);
    }

    await logEvent(
      "research",
      "info",
      "research_completed",
      {
        opportunityId,
        model,
        evidenceQuality: findings.evidence_quality,
        competitionLevel: findings.competition_level,
        realisticHours: findings.estimated_hours_realistic,
        dependencies: findings.dependencies,
        nextStatus,
        webResearchAttempted: findings.web_research_attempted,
        citationsCount: findings.citations.length,
        searchResultsCount,
        fetchedPagesCount: fetchedPages.length,
      },
      { taskId, opportunityId }
    );

    return ok(
      {
        findings,
        nextStatus,
        model,
        citations: findings.citations,
        bibliography: tracker.toMarkdown(),
      } as unknown as Record<string, unknown>,
      {
        qualityScore: clamp(findings.evidence_quality, 0, 10),
        nextAgent: "verification",
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[research-agent] execute threw:", err);
    await logEvent(
      "research",
      "error",
      "research_failed",
      { opportunityId, error: message },
      { taskId, opportunityId }
    );
    return fail(`research agent crashed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

interface LlmInput {
  id: string;
  title: string;
  description: string;
  source: string;
  sourceUrl: string;
  organization: string;
  category: string;
  rewardAmount: number;
  rewardCurrency: string;
  estimatedHours: number;
  difficulty: number;
  competition: number;
  requirements: string[];
  eligibility: string[];
  skillsRequired: string[];
  paymentMethod: string;
}

interface ResearchContext {
  fetchedPages: Array<{ url: string; title?: string; text: string }>;
  searchResultsCount: number;
  webResearchAttempted: boolean;
  webResearchError?: string;
  tracker: CitationTracker;
}

async function callResearchLLM(
  modelId: string,
  op: LlmInput,
  ctx: ResearchContext,
  logCtx: { taskId?: string; opportunityId?: string }
): Promise<ResearchFindings> {
  const citationList = ctx.tracker
    .list()
    .map((c, i) => `${i + 1}. ${c.url}${c.title ? ` — ${c.title}` : ""}`)
    .join("\n");

  const systemPrompt = [
    "You are the Research Agent for an autonomous crypto-earning system.",
    "Analyse the opportunity below + the fetched web context and return STRICT JSON with this exact shape:",
    "{",
    '  "requirements_summary": string,',
    '  "eligibility_assessment": string,',
    '  "competition_level": number (1..10),',
    '  "estimated_hours_realistic": number,',
    '  "dependencies": string[],',
    '  "evidence_quality": number (1..10),',
    '  "notes": string[],',
    '  "web_research_summary": string,  // what the fetched web pages corroborated',
    '  "citations": string[]  // URLs you actually used (must be from the list below)',
    "}",
    "",
    "Citation rule (CRITICAL): every URL in citations[] MUST come from the",
    "list of fetched/search URLs provided below. Do NOT invent URLs.",
    "Be conservative. Do not invent facts not supported by the opportunity or the fetched pages.",
    "If the fetched pages contradict the opportunity fields, note it in `notes`.",
    "Return ONLY the JSON object — no preamble, no markdown fences.",
  ].join("\n");

  const fetchedContextBlock = ctx.fetchedPages.length > 0
    ? ctx.fetchedPages
        .map(
          (p, i) =>
            `--- Fetched page ${i + 1}: ${p.url} ---\nTitle: ${p.title ?? "(untitled)"}\nContent:\n${p.text.slice(0, 8000)}`
        )
        .join("\n\n")
    : "(no pages were fetched — use the opportunity fields only)";

  const userPrompt = [
    `Title: ${op.title}`,
    `Source: ${op.source} (${op.sourceUrl})`,
    `Organization: ${op.organization}`,
    `Category: ${op.category}`,
    `Reward: ${op.rewardAmount} ${op.rewardCurrency}`,
    `Scanner-estimated hours: ${op.estimatedHours}`,
    `Difficulty (1-10): ${op.difficulty}`,
    `Competition (1-10): ${op.competition}`,
    `Payment method: ${op.paymentMethod}`,
    `Requirements: ${op.requirements.join("; ") || "(none listed)"}`,
    `Eligibility: ${op.eligibility.join("; ") || "(none listed)"}`,
    `Skills required: ${op.skillsRequired.join(", ") || "(none listed)"}`,
    `Description:\n${op.description}`,
    "",
    "=== Live web research context ===",
    `web_research_attempted: ${ctx.webResearchAttempted}`,
    `search_results_count: ${ctx.searchResultsCount}`,
    `fetched_pages_count: ${ctx.fetchedPages.length}`,
    ctx.webResearchError ? `web_research_error: ${ctx.webResearchError}` : "",
    "",
    "=== Citations available (use ONLY these in citations[]) ===",
    citationList || "(no citations available)",
    "",
    "=== Fetched page contents ===",
    fetchedContextBlock,
  ]
    .filter((line) => line !== undefined && line !== "")
    .join("\n");

  let llmContent = "";
  try {
    const result = await callLLM({
      modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      maxTokens: 1200,
      temperature: 0.3,
      responseFormat: "json",
      taskType: "research",
      estimatedTokens: 3500,
      taskId: logCtx.taskId,
      opportunityId: logCtx.opportunityId,
    });
    if (result.success) {
      llmContent = result.content;
    } else {
      await logEvent(
        "research",
        "warn",
        "research_llm_failed_fallback_to_heuristics",
        {
          opportunityId: logCtx.opportunityId,
          model: modelId,
          error: result.error,
          fallbackAction: result.fallback_action,
        },
        logCtx
      );
    }
  } catch (err) {
    console.error("[research-agent] callLLM threw:", err);
  }

  if (llmContent) {
    const validated = validateJSON(llmContent);
    if (validated.valid && validated.parsed && typeof validated.parsed === "object") {
      const parsed = validated.parsed as Record<string, unknown>;
      const findings = parseFindings(parsed, op, ctx);
      if (findings) return findings;
    }
    await logEvent(
      "research",
      "warn",
      "research_llm_invalid_json_fallback",
      { opportunityId: logCtx.opportunityId, model: modelId },
      logCtx
    );
  }

  // --- Deterministic fallback (spec §29 failure handling) ----------------
  return heuristicFindings(op, ctx);
}

// ---------------------------------------------------------------------------
// Parsers + heuristics
// ---------------------------------------------------------------------------

function parseFindings(
  obj: Record<string, unknown>,
  op: LlmInput,
  ctx: ResearchContext
): ResearchFindings | null {
  try {
    const requirements_summary =
      typeof obj.requirements_summary === "string"
        ? obj.requirements_summary
        : "";
    const eligibility_assessment =
      typeof obj.eligibility_assessment === "string"
        ? obj.eligibility_assessment
        : "";
    const competition_level = clampInt(
      typeof obj.competition_level === "number"
        ? obj.competition_level
        : op.competition,
      1,
      10
    );
    const estimated_hours_realistic =
      typeof obj.estimated_hours_realistic === "number" &&
      Number.isFinite(obj.estimated_hours_realistic)
        ? Math.max(0.5, obj.estimated_hours_realistic)
        : op.estimatedHours;
    const dependencies = Array.isArray(obj.dependencies)
      ? obj.dependencies.filter((x): x is string => typeof x === "string")
      : [];
    const evidence_quality = clampInt(
      typeof obj.evidence_quality === "number"
        ? obj.evidence_quality
        : ctx.webResearchAttempted
          ? 4
          : 3,
      1,
      10
    );
    const notes = Array.isArray(obj.notes)
      ? obj.notes.filter((x): x is string => typeof x === "string")
      : [];
    const web_research_summary =
      typeof obj.web_research_summary === "string"
        ? obj.web_research_summary
        : undefined;

    // --- Validate citations against the tracker (spec §15) ----------------
    const rawCitations = Array.isArray(obj.citations)
      ? obj.citations.filter((x): x is string => typeof x === "string")
      : [];
    // Also extract any URLs cited inline in the summary / notes text.
    const inlineUrls = extractCitedUrls(
      [web_research_summary ?? "", ...notes].join("\n")
    );
    const allCited = Array.from(new Set([...rawCitations, ...inlineUrls]));
    const { valid: validCitations, invalid: invalidCitations } =
      ctx.tracker.validateCitations(allCited);

    if (invalidCitations.length > 0) {
      // Log dropped citations — they are likely LLM hallucinations.
      // We don't include them in the findings.citations[] field.
      void logEvent(
        "research",
        "warn",
        "research_llm_dropped_invalid_citations",
        {
          opportunityId: op.id,
          dropped: invalidCitations,
        },
        {}
      ).catch(() => null);
    }

    return {
      requirements_summary,
      eligibility_assessment,
      competition_level,
      estimated_hours_realistic,
      dependencies,
      evidence_quality,
      source_url: op.sourceUrl,
      notes,
      citations: validCitations,
      web_research_summary,
      web_research_attempted: ctx.webResearchAttempted,
    };
  } catch {
    return null;
  }
}

/**
 * Deterministic fallback when the LLM fails or returns invalid JSON.
 * Derives a conservative research summary from the opportunity's own fields.
 *
 * Phase-2 §29: when the LLM stack is unreachable, fall back to a
 * deterministic heuristic so the orchestrator can still advance the
 * opportunity. The evidence_quality is lowered (3 instead of 5) when
 * web research was attempted but couldn't produce LLM findings — we have
 * the fetched pages but no LLM analysis of them.
 */
function heuristicFindings(
  op: LlmInput,
  ctx: ResearchContext
): ResearchFindings {
  const requirements = op.requirements ?? [];
  const eligibility = op.eligibility ?? [];
  const skills = op.skillsRequired ?? [];

  const notes = [
    "LLM research unavailable — using deterministic heuristics from the opportunity's own fields.",
  ];
  if (ctx.webResearchError) {
    notes.push(`Web research failed: ${ctx.webResearchError}`);
  }
  if (ctx.webResearchAttempted && ctx.fetchedPages.length > 0) {
    notes.push(
      `Fetched ${ctx.fetchedPages.length} web page(s) but could not analyse them via LLM.`
    );
  }

  return {
    requirements_summary:
      requirements.length > 0
        ? `Requires: ${requirements.slice(0, 5).join("; ")}.`
        : "No explicit requirements listed in the opportunity source.",
    eligibility_assessment:
      eligibility.length > 0
        ? `Eligibility: ${eligibility.slice(0, 5).join("; ")}.`
        : "Eligibility not explicitly stated — review the source.",
    competition_level: clampInt(op.competition, 1, 10),
    estimated_hours_realistic: Math.max(0.5, op.estimatedHours),
    dependencies: skills.length > 0 ? [...skills] : [],
    evidence_quality: ctx.webResearchAttempted ? 3 : 5,
    source_url: op.sourceUrl,
    notes,
    citations: ctx.tracker.urls(),
    web_research_summary: undefined,
    web_research_attempted: ctx.webResearchAttempted,
  };
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// ---------------------------------------------------------------------------
// Re-exports for callers that need them
// ---------------------------------------------------------------------------

export type { FetchResult, SearchResult };
