// Tavily Search API adapter (Phase-2 §13, P1-4).
//
// https://api.tavily.com/search
// POST body: { api_key, query, max_results }
// Parses `results[]` from the response.
//
// Never throws — `search()` returns `[]` on any failure.

import type { SearchProvider, SearchOpts } from "@/lib/research/search-providers/types";
import type { SearchResult } from "@/lib/research/types";
import { fetchJsonWithBudget, truncateText } from "@/lib/research/search-providers/_http";

const ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_MAX = 5;
const DEFAULT_TIMEOUT = 10_000;
const SNIPPET_MAX = 300;

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

export const TavilySearchProvider: SearchProvider = {
  name: "tavily",
  displayName: "Tavily Search API",

  isConfigured(): boolean {
    const key = process.env.TAVILY_API_KEY;
    return typeof key === "string" && key.trim().length > 0;
  },

  async search(
    query: string,
    opts: SearchOpts = {}
  ): Promise<SearchResult[]> {
    if (!this.isConfigured()) return [];
    const maxResults = opts.maxResults ?? DEFAULT_MAX;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

    const body = JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: maxResults,
      // Tavily supports an "answer" summary — we don't want it; we want
      // raw hits so the LLM can draw its own conclusions.
      include_answer: false,
    });

    const res = await fetchJsonWithBudget(
      ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
      },
      timeoutMs
    );

    if (!res.ok || !res.json) return [];
    const body2 = res.json as TavilyResponse;
    const results = body2?.results;
    if (!Array.isArray(results)) return [];

    const out: SearchResult[] = [];
    for (const r of results) {
      if (!r || !r.url) continue;
      out.push({
        title: r.title ?? "(untitled)",
        url: r.url,
        snippet: truncateText(r.content ?? "", SNIPPET_MAX),
        source: "tavily",
        score: typeof r.score === "number" ? r.score : undefined,
      });
      if (out.length >= maxResults) break;
    }
    return out;
  },
};
