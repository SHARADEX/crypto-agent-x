// Shared HTTP helper for search providers (Phase-2 P1-4).
//
// Each search provider adapter needs to do the same thing: fire a
// `fetch()` with an `AbortController` timeout, record the budget for
// the web request, parse the JSON body, and return either the parsed
// object or `null` on any failure. This helper centralises that flow so
// the per-provider files stay ~30 lines of pure adapter logic.

import { BudgetManager } from "@/lib/budget/manager";

export interface FetchJsonResult {
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
  error?: string;
}

/**
 * Fetch a URL with an `AbortController` timeout, record the web request
 * against the agent's free-tier budget, and parse the body as JSON.
 * Never throws — returns a discriminated result object.
 */
export async function fetchJsonWithBudget(
  url: string,
  init: RequestInit,
  timeoutMs = 10_000
): Promise<FetchJsonResult> {
  // Record the request against the budget BEFORE the fetch so the daily
  // cap is enforced even when the provider hangs and the AbortController
  // has to fire.
  try {
    await BudgetManager.getInstance().recordWebRequest();
  } catch (err) {
    // Budget recording should never throw, but we don't want a failed
    // budget upsert to block the actual fetch.
    console.error("[search] recordWebRequest threw:", err);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON — leave null
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      json,
      text,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      json: null,
      text: "",
      error: isAbort ? `timeout after ${timeoutMs}ms` : (err instanceof Error ? err.message : String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Truncate a string to `max` chars, appending "…" if shortened. Used to
 * keep search snippets at a reasonable length for the LLM context.
 */
export function truncateText(text: string, max: number): string {
  if (typeof text !== "string" || text.length <= max) return text ?? "";
  return text.slice(0, max) + "…";
}
