// Source citation tracker (Phase-2 spec §14, §15, P1-9).
//
// During a research pass, the Research Agent fetches the opportunity's
// source URL + 0-3 corroborating URLs from search results. The agent
// must be able to:
//
//   1. Collect every URL it actually fetched (so the LLM's citations can
//      be validated against this set — reject any citation not in the set).
//   2. Deduplicate by URL (search results often point to the same page
//      multiple times).
//   3. Render a markdown bibliography the agent can paste into its output.
//
// `CitationTracker` is the small class that owns this. The Research Agent
// creates one per research pass, calls `add()` for every successful fetch,
// and calls `toMarkdown()` / `validateCitations()` at the end.

import type { FetchResult, SearchResult } from "@/lib/research/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Citation {
  url: string;
  title?: string;
  snippet?: string;
  fetchedAt: string;
  /** The source that produced this citation. */
  source: "fetch" | "search" | "opportunity";
  /** Optional: HTTP status from the fetch (only for `source: "fetch"`). */
  status?: number;
}

// ---------------------------------------------------------------------------
// CitationTracker
// ---------------------------------------------------------------------------

export class CitationTracker {
  private readonly byUrl = new Map<string, Citation>();

  /** Number of unique citations currently tracked. */
  get size(): number {
    return this.byUrl.size;
  }

  /** All tracked citations (insertion order preserved). */
  list(): Citation[] {
    return Array.from(this.byUrl.values());
  }

  /** All tracked citation URLs (insertion order preserved). */
  urls(): string[] {
    return Array.from(this.byUrl.keys());
  }

  /**
   * Add a citation from a successful fetch result. Skips fetches with
   * `ok: false` (we don't want to cite a page we couldn't actually read).
   * Deduplicates by URL.
   */
  addFetch(result: FetchResult, opts?: { title?: string; snippet?: string }): Citation | null {
    if (!result || !result.ok || !result.url) return null;
    return this.add({
      url: result.url,
      title: opts?.title,
      snippet: opts?.snippet ?? result.text.slice(0, 280),
      fetchedAt: result.fetchedAt,
      source: "fetch",
      status: result.status,
    });
  }

  /**
   * Add a citation from a search result (the snippet is the search-engine
   * summary; we did NOT fetch the page). Useful when a search result
   * didn't make it into the top-3 fetches but still corroborates a claim.
   */
  addSearchResult(result: SearchResult): Citation | null {
    if (!result || !result.url) return null;
    return this.add({
      url: result.url,
      title: result.title,
      snippet: result.snippet,
      fetchedAt: new Date().toISOString(),
      source: "search",
    });
  }

  /**
   * Add the opportunity's own source URL as a citation (we treat this
   * specially so the LLM knows it's the primary source, not a
   * corroborating one).
   */
  addOpportunitySource(url: string, opts?: { title?: string; snippet?: string }): Citation | null {
    if (!url) return null;
    return this.add({
      url,
      title: opts?.title,
      snippet: opts?.snippet,
      fetchedAt: new Date().toISOString(),
      source: "opportunity",
    });
  }

  /**
   * Low-level add — dedupes by URL, preserves first-insertion metadata.
   * Returns the citation that ended up in the tracker (either the new one
   * or the existing one if a duplicate).
   */
  add(citation: Citation): Citation | null {
    if (!citation || !citation.url) return null;
    const existing = this.byUrl.get(citation.url);
    if (existing) return existing;
    this.byUrl.set(citation.url, citation);
    return citation;
  }

  /**
   * Validate that every URL in a list of LLM-cited URLs is actually in
   * the tracker. Returns `{ valid, invalid }` so the caller can drop or
   * flag the invalid citations deterministically.
   *
   * Spec §15 / §21: hallucinated citations are a known LLM failure mode;
   * this check is the deterministic guard against it.
   */
  validateCitations(citedUrls: string[]): {
    valid: string[];
    invalid: string[];
  } {
    const valid: string[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();
    for (const url of citedUrls ?? []) {
      if (!url || typeof url !== "string") continue;
      if (seen.has(url)) continue;
      seen.add(url);
      if (this.byUrl.has(url)) {
        valid.push(url);
      } else {
        invalid.push(url);
      }
    }
    return { valid, invalid };
  }

  /**
   * Render the citations as a markdown bibliography. The Research Agent
   * pastes this at the end of its findings so the dashboard can show the
   * user exactly which URLs were fetched.
   */
  toMarkdown(): string {
    const items = this.list();
    if (items.length === 0) return "_(no sources fetched)_";
    const lines: string[] = ["## Sources"];
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      const title = c.title?.trim() || c.url;
      const marker =
        c.source === "opportunity"
          ? " (primary source)"
          : c.source === "fetch"
            ? ""
            : " (search snippet — not fetched)";
      const snippet = c.snippet
        ? `\n  > ${c.snippet.replace(/\n/g, " ").slice(0, 280)}`
        : "";
      lines.push(`${i + 1}. [${title}](${c.url})${marker}${snippet}`);
    }
    return lines.join("\n");
  }
}

/**
 * Extract URL-looking strings from an LLM's response. Used by the Research
 * Agent to find citations the model cited in prose / JSON fields so they
 * can be validated against the tracker.
 *
 * Returns a de-duplicated array of URL strings.
 */
export function extractCitedUrls(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // Match markdown link targets [text](url) AND bare http(s) URLs.
  const mdLinkRegex = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = mdLinkRegex.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  const bareUrlRegex = /\b(https?:\/\/[^\s<>"')\]]+)/gi;
  while ((m = bareUrlRegex.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}
