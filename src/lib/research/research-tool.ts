// ResearchTool — the unified interface every specialist agent uses (Phase-2
// spec §12, §13, §14, §15, §21, P1-1, P1-4).
//
// `ResearchToolImpl` wires together:
//
//   - http-fetch.fetchUrl          — fetch + sanitise + cache a single URL.
//   - search-providers.searchWithFallback  — multi-vendor search with fallback.
//   - security/url-validator.validateUrl   — SSRF / homograph guard.
//   - security/prompt-injection.sanitizeExternalContent — §21 anti-injection.
//   - budget/manager.recordWebRequest      — free-tier web-request budget.
//
// The Research Agent calls `getResearchTool()` to get the singleton.
//
// All public methods NEVER throw — they always return result objects.

import { BudgetManager } from "@/lib/budget/manager";
import { validateUrl } from "@/lib/security/url-validator";
import { sanitizeExternalContent } from "@/lib/security/prompt-injection";
import { logEvent } from "@/lib/agent/events";
import {
  fetchUrl as httpFetchUrl,
  htmlToText,
  extractLinks,
} from "@/lib/research/http-fetch";
import {
  searchWithFallback,
} from "@/lib/research/search-providers";
import type {
  FetchResult,
  ResearchTool,
  SearchResult,
} from "@/lib/research/types";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ResearchToolImpl implements ResearchTool {
  readonly name = "research-tool";

  // -- fetchUrl ------------------------------------------------------------

  async fetchUrl(
    url: string,
    opts: { timeoutMs?: number; maxBytes?: number; keepRaw?: boolean } = {}
  ): Promise<FetchResult> {
    const fetchedAt = new Date().toISOString();

    // Validate first — validateUrl is the SSRF / homograph guard.
    const validation = validateUrl(url);
    if (!validation.valid || !validation.safe) {
      return {
        url,
        ok: false,
        status: 0,
        contentType: "",
        text: "",
        bytes: 0,
        fetchedAt,
        error: `URL rejected: ${validation.reasons.join("; ")}`,
      };
    }

    // Budget pre-record (http-fetch also records, but we want to count
    // this even if http-fetch's path is skipped due to cache).
    try {
      await BudgetManager.getInstance().recordWebRequest();
    } catch (err) {
      console.error("[research-tool] recordWebRequest threw:", err);
    }

    const result = await httpFetchUrl(url, {
      timeoutMs: opts.timeoutMs,
      maxBytes: opts.maxBytes,
      keepRaw: opts.keepRaw,
    });

    // http-fetch already sanitises the content, but we run it through
    // sanitizeExternalContent ONE MORE TIME on the extracted text —
    // defense in depth, in case the page's content type misled us into
    // skipping the stripper. When http-fetch already marked the content
    // unsafe (sanitize.safe=false → text=""), we propagate that signal
    // as `ok: false` so the caller doesn't pass an empty string to the
    // LLM without realising it was dropped for safety reasons.
    if (result.ok && result.text) {
      const second = sanitizeExternalContent(
        result.text,
        `research-tool:${result.url}`
      );
      if (!second.safe) {
        await logEvent(
          "research",
          "warn",
          "research_fetch_unsafe_content_dropped",
          {
            url: result.url,
            riskScore: second.riskScore,
            detectedPatterns: second.detectedPatterns,
          },
          {}
        ).catch(() => null);
        return {
          ...result,
          ok: false,
          text: "",
          error: `content dropped by sanitizer (risk=${second.riskScore})`,
        };
      }
      return { ...result, text: second.sanitized };
    }
    return result;
  }

  // -- search --------------------------------------------------------------

  async search(
    query: string,
    opts: { maxResults?: number; timeoutMs?: number } = {}
  ): Promise<SearchResult[]> {
    if (!query || typeof query !== "string") return [];
    // Budget pre-record — searchWithFallback also records per-provider,
    // but we want to count the overall search call too.
    try {
      await BudgetManager.getInstance().recordWebRequest();
    } catch (err) {
      console.error("[research-tool] search recordWebRequest threw:", err);
    }

    return searchWithFallback(query, {
      maxResults: opts.maxResults,
      timeoutMs: opts.timeoutMs,
    });
  }

  // -- extractText ---------------------------------------------------------

  extractText(html: string): string {
    return htmlToText(html);
  }

  // -- extractLinks ---------------------------------------------------------

  extractLinks(html: string, baseUrl: string): string[] {
    return extractLinks(html, baseUrl);
  }

  // -- validateUrl ---------------------------------------------------------

  validateUrl(url: string): { valid: boolean; safe: boolean; reasons: string[] } {
    const v = validateUrl(url);
    return {
      valid: v.valid,
      safe: v.safe,
      reasons: v.reasons,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _singleton: ResearchToolImpl | null = null;

/**
 * Get the singleton ResearchTool instance. The Research Agent uses this —
 * one shared instance means the in-memory fetch + robots caches are
 * reused across agents and across research passes.
 */
export function getResearchTool(): ResearchToolImpl {
  if (!_singleton) {
    _singleton = new ResearchToolImpl();
  }
  return _singleton;
}

/**
 * Reset the singleton (for tests). Production callers should use
 * `getResearchTool()` and let the cache TTLs handle expiry.
 */
export function resetResearchTool(): void {
  _singleton = null;
}

export type { FetchResult, ResearchTool, SearchResult };
