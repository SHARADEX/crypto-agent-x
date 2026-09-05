// Brave Search API adapter (Phase-2 §13, P1-4).
//
// https://api.search.brave.com/res/v1/web/search
// Auth: X-Subscription-Token: $BRAVE_API_KEY
// Parses `web.results[]` from the response.
//
// Never throws — `search()` returns `[]` on any failure.

import type { SearchProvider, SearchOpts } from "@/lib/research/search-providers/types";
import type { SearchResult } from "@/lib/research/types";
import { fetchJsonWithBudget, truncateText } from "@/lib/research/search-providers/_http";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_MAX = 5;
const DEFAULT_TIMEOUT = 10_000;
const SNIPPET_MAX = 300;

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
  extra_snippets?: string[];
}

interface BraveResponse {
  web?: { results?: BraveResult[] };
}

export const BraveSearchProvider: SearchProvider = {
  name: "brave",
  displayName: "Brave Search API",

  isConfigured(): boolean {
    const key = process.env.BRAVE_API_KEY;
    return typeof key === "string" && key.trim().length > 0;
  },

  async search(
    query: string,
    opts: SearchOpts = {}
  ): Promise<SearchResult[]> {
    if (!this.isConfigured()) return [];
    const maxResults = opts.maxResults ?? DEFAULT_MAX;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

    const url = new URL(ENDPOINT);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(maxResults));
    // summary=false → don't ask Brave to summarise; we want raw hits.
    url.searchParams.set("summary", "false");

    const res = await fetchJsonWithBudget(
      url.toString(),
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": process.env.BRAVE_API_KEY ?? "",
        },
      },
      timeoutMs
    );

    if (!res.ok || !res.json) return [];
    const body = res.json as BraveResponse;
    const results = body?.web?.results;
    if (!Array.isArray(results)) return [];

    const out: SearchResult[] = [];
    for (const r of results) {
      if (!r || !r.url) continue;
      out.push({
        title: r.title ?? "(untitled)",
        url: r.url,
        snippet: truncateText(
          r.description ??
            (Array.isArray(r.extra_snippets) ? r.extra_snippets.join(" ") : "") ??
            "",
          SNIPPET_MAX
        ),
        source: "brave",
      });
      if (out.length >= maxResults) break;
    }
    return out;
  },
};
