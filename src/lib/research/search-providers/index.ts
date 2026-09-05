// Search-provider registry + fallback selection (Phase-2 §13, §14, P1-4).
//
// Exports:
//   - `SEARCH_PROVIDERS`                  — array of one instance of each.
//   - `getConfiguredSearchProviders()`     — only the ones with env vars set.
//   - `selectSearchProvider()`             — pick the best configured provider.
//   - `searchWithFallback(query, opts?)`   — try each configured provider in
//                                            order until one returns results.
//
// Selection priority (spec §14 "single best source"):
//   1. Brave / Tavily / Serper / Exa — paid APIs with rich snippets. Prefer
//      in that order (rough latency/quality trade-off).
//   2. Jina — works without an API key; last-resort fallback.
//
// `searchWithFallback` records each attempted provider via `logEvent` so
// the operator can see which search backend produced the result.

import { logEvent } from "@/lib/agent/events";
import type { SearchProvider, SearchOpts } from "@/lib/research/search-providers/types";
import type { SearchResult } from "@/lib/research/types";
import { BraveSearchProvider } from "@/lib/research/search-providers/brave";
import { TavilySearchProvider } from "@/lib/research/search-providers/tavily";
import { SerperSearchProvider } from "@/lib/research/search-providers/serper";
import { ExaSearchProvider } from "@/lib/research/search-providers/exa";
import { JinaSearchProvider } from "@/lib/research/search-providers/jina";

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

export const SEARCH_PROVIDERS: SearchProvider[] = [
  BraveSearchProvider,
  TavilySearchProvider,
  SerperSearchProvider,
  ExaSearchProvider,
  JinaSearchProvider, // configured=true even without a key (last resort)
];

/**
 * Lookup by canonical name.
 */
export function getSearchProvider(name: string): SearchProvider | undefined {
  return SEARCH_PROVIDERS.find((p) => p.name === name);
}

/**
 * Return only the providers whose env vars are set (or which work without
 * an env var — Jina).
 */
export function getConfiguredSearchProviders(): SearchProvider[] {
  return SEARCH_PROVIDERS.filter((p) => p.isConfigured());
}

/**
 * Status snapshot for the dashboard.
 */
export function getSearchProviderStatuses(): Array<{
  name: string;
  displayName: string;
  configured: boolean;
}> {
  return SEARCH_PROVIDERS.map((p) => ({
    name: p.name,
    displayName: p.displayName,
    configured: p.isConfigured(),
  }));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Pick the best single search provider to use for the next query.
 *
 * Preference order: brave → tavily → serper → exa → jina.
 * Returns `null` when no provider is configured (the caller should fall
 * back to opportunity-fields-only heuristics in that case).
 */
export function selectSearchProvider(): SearchProvider | null {
  const configured = getConfiguredSearchProviders();
  // Explicit priority order.
  const order = ["brave", "tavily", "serper", "exa", "jina"];
  for (const name of order) {
    const p = configured.find((c) => c.name === name);
    if (p) return p;
  }
  return configured[0] ?? null;
}

// ---------------------------------------------------------------------------
// searchWithFallback — try each configured provider until results come back
// ---------------------------------------------------------------------------

/**
 * Run a search query through the configured providers, trying each in
 * priority order until one returns non-empty results. Returns `[]` (never
 * throws) when no provider is configured or all providers fail.
 *
 * Every attempt is logged via `logEvent("research", "info", "search_*")`
 * so the operator can audit which backend produced the result.
 */
export async function searchWithFallback(
  query: string,
  opts: SearchOpts = {}
): Promise<SearchResult[]> {
  const configured = getConfiguredSearchProviders();
  if (configured.length === 0) {
    await logEvent(
      "research",
      "warn",
      "search_no_provider_configured",
      { query },
      {}
    ).catch(() => null);
    return [];
  }

  // Try each provider in priority order (Brave → Tavily → Serper → Exa → Jina).
  const order = ["brave", "tavily", "serper", "exa", "jina"];
  const ordered = order
    .map((n) => configured.find((p) => p.name === n))
    .filter((p): p is SearchProvider => Boolean(p));

  for (const provider of ordered) {
    try {
      const results = await provider.search(query, opts);
      if (results.length > 0) {
        await logEvent(
          "research",
          "info",
          "search_succeeded",
          {
            provider: provider.name,
            query,
            count: results.length,
          },
          {}
        ).catch(() => null);
        return results;
      }
      await logEvent(
        "research",
        "debug",
        "search_provider_empty",
        { provider: provider.name, query },
        {}
      ).catch(() => null);
    } catch (err) {
      // Should never happen — providers don't throw — but be defensive.
      await logEvent(
        "research",
        "warn",
        "search_provider_error",
        {
          provider: provider.name,
          query,
          error: err instanceof Error ? err.message : String(err),
        },
        {}
      ).catch(() => null);
    }
  }

  await logEvent(
    "research",
    "warn",
    "search_all_providers_empty",
    { query, providersTried: ordered.map((p) => p.name) },
    {}
  ).catch(() => null);
  return [];
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { SearchProvider, SearchOpts } from "@/lib/research/search-providers/types";
export {
  BraveSearchProvider,
  TavilySearchProvider,
  SerperSearchProvider,
  ExaSearchProvider,
  JinaSearchProvider,
};
