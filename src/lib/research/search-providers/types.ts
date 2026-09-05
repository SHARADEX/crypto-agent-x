// Search-provider abstraction (Phase-2 spec §13, §14, P1-4).
//
// Every concrete search backend (Brave, Tavily, Serper, Exa, Jina)
// implements this interface. The `ResearchTool` talks ONLY through this
// interface — there is no `if (provider === "brave")` branching anywhere
// in the research code path.
//
// Implementations MUST:
//   - Never throw out of `search()` — return `[]` on any failure.
//   - Use `fetch()` with an `AbortController` timeout on every HTTP call.
//   - Record `BudgetManager.recordWebRequest()` BEFORE every HTTP call so
//     the agent's free-tier web-request budget is respected.
//   - Map provider-specific response shapes into the normalised
//     `SearchResult` shape defined in `src/lib/research/types.ts`.
//   - Return their canonical name via `name` for log/dashboard tagging.

import type { SearchResult } from "@/lib/research/types";

export interface SearchOpts {
  /** Maximum results to return. Default 5. */
  maxResults?: number;
  /** AbortController timeout in ms. Default 10000. */
  timeoutMs?: number;
}

export interface SearchProvider {
  /** Canonical provider id ("brave" | "tavily" | "serper" | "exa" | "jina"). */
  readonly name: string;
  /** Human-friendly label for dashboards. */
  readonly displayName: string;
  /** Returns true iff the env var(s) this provider needs are set. */
  isConfigured(): boolean;
  /**
   * Run a search query. Returns `[]` (never throws) on any failure —
   * timeouts, 4xx / 5xx, rate limits, malformed responses all collapse to
   * an empty array so the `searchWithFallback` caller can move on to the
   * next provider without try/catching.
   */
  search(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
}

export type { SearchResult };
