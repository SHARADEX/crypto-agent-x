// Exa (formerly Metaphor) adapter (Phase-2 §13, P1-4).
//
// https://api.exa.ai/search
// POST body: { query, numResults, contents: { text: true } }
// Auth: x-api-key: $EXA_API_KEY
// Parses `results[]` from the response.
//
// Never throws — `search()` returns `[]` on any failure.

import type { SearchProvider, SearchOpts } from "@/lib/research/search-providers/types";
import type { SearchResult } from "@/lib/research/types";
import { fetchJsonWithBudget, truncateText } from "@/lib/research/search-providers/_http";

const ENDPOINT = "https://api.exa.ai/search";
const DEFAULT_MAX = 5;
const DEFAULT_TIMEOUT = 10_000;
const SNIPPET_MAX = 300;

interface ExaResult {
  title?: string;
  url?: string;
  text?: string;
  score?: number;
}

interface ExaResponse {
  results?: ExaResult[];
}

export const ExaSearchProvider: SearchProvider = {
  name: "exa",
  displayName: "Exa Search API",

  isConfigured(): boolean {
    const key = process.env.EXA_API_KEY;
    return typeof key === "string" && key.trim().length > 0;
  },

  async search(
    query: string,
    opts: SearchOpts = {}
  ): Promise<SearchResult[]> {
    if (!this.isConfigured()) return [];
    const maxResults = opts.maxResults ?? DEFAULT_MAX;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

    // Ask Exa for `text: true` so we get a snippet we can pass to the LLM
    // without a separate fetch. The `maxCharacters` cap on the snippet
    // keeps the payload small.
    const body = JSON.stringify({
      query,
      numResults: maxResults,
      contents: { text: { maxCharacters: SNIPPET_MAX } },
    });

    const res = await fetchJsonWithBudget(
      ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.EXA_API_KEY ?? "",
          Accept: "application/json",
        },
        body,
      },
      timeoutMs
    );

    if (!res.ok || !res.json) return [];
    const body2 = res.json as ExaResponse;
    const results = body2?.results;
    if (!Array.isArray(results)) return [];

    const out: SearchResult[] = [];
    for (const r of results) {
      if (!r || !r.url) continue;
      out.push({
        title: r.title ?? "(untitled)",
        url: r.url,
        snippet: truncateText(r.text ?? "", SNIPPET_MAX),
        source: "exa",
        score: typeof r.score === "number" ? r.score : undefined,
      });
      if (out.length >= maxResults) break;
    }
    return out;
  },
};
