// Serper.dev adapter (Phase-2 §13, P1-4).
//
// https://google.serper.dev/search
// POST body: { q, num }
// Auth: X-API-KEY: $SERPER_API_KEY
// Parses `organic[]` from the response.
//
// Never throws — `search()` returns `[]` on any failure.

import type { SearchProvider, SearchOpts } from "@/lib/research/search-providers/types";
import type { SearchResult } from "@/lib/research/types";
import { fetchJsonWithBudget, truncateText } from "@/lib/research/search-providers/_http";

const ENDPOINT = "https://google.serper.dev/search";
const DEFAULT_MAX = 5;
const DEFAULT_TIMEOUT = 10_000;
const SNIPPET_MAX = 300;

interface SerperResult {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

interface SerperResponse {
  organic?: SerperResult[];
}

export const SerperSearchProvider: SearchProvider = {
  name: "serper",
  displayName: "Serper.dev (Google Search)",

  isConfigured(): boolean {
    const key = process.env.SERPER_API_KEY;
    return typeof key === "string" && key.trim().length > 0;
  },

  async search(
    query: string,
    opts: SearchOpts = {}
  ): Promise<SearchResult[]> {
    if (!this.isConfigured()) return [];
    const maxResults = opts.maxResults ?? DEFAULT_MAX;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

    const body = JSON.stringify({ q: query, num: maxResults });

    const res = await fetchJsonWithBudget(
      ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": process.env.SERPER_API_KEY ?? "",
          Accept: "application/json",
        },
        body,
      },
      timeoutMs
    );

    if (!res.ok || !res.json) return [];
    const body2 = res.json as SerperResponse;
    const results = body2?.organic;
    if (!Array.isArray(results)) return [];

    const out: SearchResult[] = [];
    for (const r of results) {
      if (!r || !r.link) continue;
      out.push({
        title: r.title ?? "(untitled)",
        url: r.link,
        snippet: truncateText(r.snippet ?? "", SNIPPET_MAX),
        source: "serper",
        score: typeof r.position === "number"
          ? Math.max(0, 1 - (r.position - 1) / 10)
          : undefined,
      });
      if (out.length >= maxResults) break;
    }
    return out;
  },
};
