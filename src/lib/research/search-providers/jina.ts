// Jina Reader adapter (Phase-2 §13, §14, P1-4).
//
// Jina exposes two endpoints the agent uses:
//
//   1. https://s.jina.ai/{query}  — SEARCH endpoint. Returns plain text
//      with one block per result, each block prefixed by "Title:", "URL:",
//      "Snippet:". Auth via `Authorization: Bearer $JINA_API_KEY` is
//      OPTIONAL — without a key the agent runs at a lower rate limit.
//
//   2. https://r.jina.ai/{url}    — READER endpoint. Returns a single
//      page's content as plain text. Used by http-fetch as an alternative
//      HTML→text extraction path (the default is the regex stripper).
//
// This adapter implements ONLY the SEARCH side (the reader is wired
// directly into `http-fetch.ts`). Never throws — `search()` returns `[]`
// on any failure.

import type { SearchProvider, SearchOpts } from "@/lib/research/search-providers/types";
import type { SearchResult } from "@/lib/research/types";
import { fetchJsonWithBudget, truncateText } from "@/lib/research/search-providers/_http";

const SEARCH_ENDPOINT = "https://s.jina.ai/";
const DEFAULT_MAX = 5;
const DEFAULT_TIMEOUT = 10_000;
const SNIPPET_MAX = 300;

/**
 * Parse Jina's plain-text response format. Each result is a block of the
 * form:
 *
 *   Title: Example Title
 *   URL Source: https://example.com
 *   Markdown Content:
 *   ... snippet text ...
 *
 * We split on "Title:" boundaries and parse each block defensively.
 */
function parseJinaSearch(text: string, max: number): SearchResult[] {
  if (!text) return [];
  // Split on "Title:" at the start of a line.
  const blocks = text.split(/\n(?=Title:\s)/i).filter((b) => b.trim().length > 0);
  const out: SearchResult[] = [];
  for (const block of blocks) {
    const titleMatch = block.match(/^Title:\s*(.+?)\s*$/im);
    const urlMatch = block.match(/^URL Source:\s*(\S+)\s*$/im);
    const snippetMatch = block.match(/^(?:Markdown Content|Content|Snippet):\s*([\s\S]+?)$/im);
    const url = urlMatch?.[1];
    if (!url) continue;
    out.push({
      title: (titleMatch?.[1] ?? "(untitled)").trim(),
      url,
      snippet: truncateText((snippetMatch?.[1] ?? "").trim(), SNIPPET_MAX),
      source: "jina",
    });
    if (out.length >= max) break;
  }
  return out;
}

export const JinaSearchProvider: SearchProvider = {
  name: "jina",
  displayName: "Jina Reader (s.jina.ai)",

  isConfigured(): boolean {
    // Jina works WITHOUT an API key (at a lower rate limit), so we report
    // configured=true always — the caller can decide whether to prefer
    // other providers first.
    return true;
  },

  async search(
    query: string,
    opts: SearchOpts = {}
  ): Promise<SearchResult[]> {
    const maxResults = opts.maxResults ?? DEFAULT_MAX;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

    // Jina's search endpoint encodes the query in the URL path. The body
    // is returned as plain text — we don't try to parse it as JSON.
    const url = `${SEARCH_ENDPOINT}${encodeURIComponent(query)}`;
    const headers: Record<string, string> = {
      Accept: "text/plain",
    };
    const key = process.env.JINA_API_KEY;
    if (typeof key === "string" && key.trim().length > 0) {
      headers.Authorization = `Bearer ${key}`;
    }

    const res = await fetchJsonWithBudget(
      url,
      { method: "GET", headers },
      timeoutMs
    );

    // Jina returns text, not JSON. If `text` is empty, fall back to the
    // JSON-shaped response some endpoints emit.
    if (res.text) {
      const parsed = parseJinaSearch(res.text, maxResults);
      if (parsed.length > 0) return parsed;
    }
    if (res.ok && res.json && typeof res.json === "object") {
      const obj = res.json as { data?: Array<{ title?: string; url?: string; content?: string }> };
      const data = obj?.data;
      if (Array.isArray(data)) {
        const out: SearchResult[] = [];
        for (const r of data) {
          if (!r || !r.url) continue;
          out.push({
            title: r.title ?? "(untitled)",
            url: r.url,
            snippet: truncateText(r.content ?? "", SNIPPET_MAX),
            source: "jina",
          });
          if (out.length >= maxResults) break;
        }
        return out;
      }
    }
    return [];
  },
};
