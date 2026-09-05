// Research tools — public types (Phase-2 spec §12, §13, §14, §15).
//
// The Research Agent needs three concrete capabilities to do live web
// research instead of just handing the opportunity's fields to the LLM:
//
//   1. fetchUrl     — fetch a single URL with timeout, max-bytes cap,
//                     robots.txt awareness, HTML→text extraction, and a
//                     1-hour in-memory cache (so a single research pass
//                     doesn't re-fetch the same page). Implemented in
//                     `src/lib/research/http-fetch.ts`.
//   2. search       — run a search-engine query through a pluggable
//                     SearchProvider abstraction (Brave, Tavily, Serper,
//                     Exa, Jina) so the agent never couples to a single
//                     vendor. Implemented in
//                     `src/lib/research/search-providers/`.
//   3. extractText  /  extractLinks  — regex-based HTML → text + link
//                     extraction. Used both internally by `fetchUrl` and
//                     exposed on the `ResearchTool` so callers can re-use
//                     the stripper on HTML they fetched some other way.
//
// `ResearchTool` is the unified interface every specialist agent uses.
// `ResearchToolImpl` (in `research-tool.ts`) wires together http-fetch +
// search-providers + the security URL validator + BudgetManager +
// sanitizeExternalContent. The Research Agent uses the singleton
// `getResearchTool()`.
//
// Spec §21 hard rule: every byte of external content fetched by these
// tools MUST be passed through `sanitizeExternalContent` before it is
// sent to the LLM. The implementation enforces this in `fetchUrl` so
// callers don't have to remember.

// ---------------------------------------------------------------------------
// Fetch result
// ---------------------------------------------------------------------------

export interface FetchResult {
  /** The URL that was fetched (post-validation, post-normalisation). */
  url: string;
  /** Did the fetch succeed and return usable text? */
  ok: boolean;
  /** HTTP status code (0 for network / parse errors). */
  status: number;
  /** Content-Type header from the response (lower-cased). */
  contentType: string;
  /** Extracted main-text content (HTML → text). Sanitised before return. */
  text: string;
  /** Raw HTML body (only when `keepRaw: true` was passed). */
  raw?: string;
  /** Number of bytes received. */
  bytes: number;
  /** ISO timestamp of when the fetch completed. */
  fetchedAt: string;
  /** Error message when `ok === false`. */
  error?: string;
  /** True when the result came from the in-memory cache. */
  fromCache?: boolean;
}

// ---------------------------------------------------------------------------
// Search result
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Which provider produced this result ("brave" | "tavily" | …). */
  source: string;
  /** Optional relevance score in [0,1] (provider-specific normalisation). */
  score?: number;
}

// ---------------------------------------------------------------------------
// The unified research-tool interface (impl lives in research-tool.ts)
// ---------------------------------------------------------------------------

export interface ResearchTool {
  /** Canonical name (used in logs / dashboards). */
  readonly name: string;
  /**
   * Fetch a single URL and return its main-text content.
   *
   * Spec §12: respects robots.txt, runs with an AbortController timeout,
   * caps the response at `maxBytes`, extracts main text via a regex-based
   * HTML stripper, sanitises the result via `sanitizeExternalContent`
   * (spec §21), and records the request via `BudgetManager.recordWebRequest`.
   *
   * Cached in-memory for 1 hour keyed by URL.
   */
  fetchUrl(
    url: string,
    opts?: { timeoutMs?: number; maxBytes?: number; keepRaw?: boolean }
  ): Promise<FetchResult>;
  /**
   * Run a search query through the configured search provider(s).
   * Records each call via `BudgetManager.recordWebRequest`.
   * Returns `[]` (never throws) when no provider is configured or all
   * providers fail.
   */
  search(
    query: string,
    opts?: { maxResults?: number; timeoutMs?: number }
  ): Promise<SearchResult[]>;
  /** HTML → text (regex-based stripper — no DOM parser dependency). */
  extractText(html: string): string;
  /** Extract all href URLs from an HTML document, resolved against `baseUrl`. */
  extractLinks(html: string, baseUrl: string): string[];
  /**
   * Validate a URL against the agent's security policy. Delegates to
   * `validateUrl` from `src/lib/security/url-validator.ts` (spec §7, §32).
   */
  validateUrl(url: string): {
    valid: boolean;
    safe: boolean;
    reasons: string[];
  };
}

// ---------------------------------------------------------------------------
// Fetch / search options
// ---------------------------------------------------------------------------

export interface FetchUrlOpts {
  /** AbortController timeout in ms. Default 10000. */
  timeoutMs?: number;
  /** Maximum response size — aborts the stream if exceeded. Default 2MB. */
  maxBytes?: number;
  /** Keep the raw HTML on the FetchResult (default false). */
  keepRaw?: boolean;
  /**
   * Skip robots.txt check (useful for trusted first-party URLs like the
   * opportunity's own sourceUrl). Default false.
   */
  skipRobots?: boolean;
}

export interface SearchOpts {
  /** Maximum results to return. Default 5. */
  maxResults?: number;
  /** AbortController timeout per provider. Default 10000. */
  timeoutMs?: number;
}
