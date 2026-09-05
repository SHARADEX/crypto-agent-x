// HTTP fetcher for the Research Agent (Phase-2 spec §12, §13, §14, P1-1).
//
// `fetchUrl` is the single entry point. It fetches a URL with:
//
//   - AbortController timeout (default 10s).
//   - Max-bytes cap (default 2MB — aborts the stream if exceeded).
//   - User-Agent identifying the agent.
//   - robots.txt awareness — fetches `/robots.txt` for the host, caches for
//     1 hour, skips the fetch when disallowed. Override with `skipRobots: true`
//     for trusted first-party URLs.
//   - HTML → text extraction via a regex-based stripper. The goal is
//     "good enough text for the LLM", not a full DOM parse. <script> /
//     <style> blocks are stripped entirely; the rest has tags removed and
//     entities decoded.
//   - In-memory 1-hour cache keyed by URL — a single research pass often
//     re-fetches the same page (search snippet → page → search result link)
//     and we don't want to burn the daily web-request budget on duplicates.
//
// Returns `FetchResult`. NEVER throws.

import { BudgetManager } from "@/lib/budget/manager";
import { validateUrl } from "@/lib/security/url-validator";
import { sanitizeExternalContent } from "@/lib/security/prompt-injection";
import type { FetchResult } from "@/lib/research/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const USER_AGENT =
  "CryptoEarn-Agent/0.3 (research; +https://github.com/cryptoearn/agent)";
const MAX_TEXT_LENGTH = 50_000; // truncate the extracted text so it fits in LLM context.

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  result: FetchResult;
  expiresAt: number;
}

const fetchCache = new Map<string, CacheEntry>();

/**
 * Clear the fetch cache. Exported for tests + the smoke script; production
 * callers should let the 1-hour TTL handle expiry.
 */
export function clearFetchCache(): void {
  fetchCache.clear();
}

function getCached(url: string): FetchResult | null {
  const entry = fetchCache.get(url);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    fetchCache.delete(url);
    return null;
  }
  return { ...entry.result, fromCache: true };
}

function setCached(url: string, result: FetchResult): void {
  fetchCache.set(url, {
    result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// ---------------------------------------------------------------------------
// robots.txt cache
// ---------------------------------------------------------------------------

interface RobotsCacheEntry {
  allowed: boolean;
  reason?: string;
  fetchedAt: number;
  expiresAt: number;
}

const robotsCache = new Map<string, RobotsCacheEntry>();
const ROBOTS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Check robots.txt for the host of `url`. Returns `{ allowed, reason }`.
 *
 * Fetches `${origin}/robots.txt` (cached for 1 hour per host), parses it
 * for `User-agent: *` + `Disallow:` rules, and returns `allowed: false`
 * when the requested path is disallowed.
 *
 * On any fetch / parse error, returns `allowed: true` (fail-open) — the
 * fetcher's job is to err on the side of getting the page, and the URL
 * validator + content sanitiser are the actual safety nets. The robots
 * check is best-effort politeness, not a security boundary.
 */
export async function checkRobots(url: string): Promise<{
  allowed: boolean;
  reason?: string;
}> {
  try {
    const parsed = new URL(url);
    const host = parsed.origin;
    const path = parsed.pathname + parsed.search;

    // Check cache.
    const cached = robotsCache.get(host);
    if (cached && cached.expiresAt > Date.now()) {
      return { allowed: cached.allowed, reason: cached.reason };
    }

    // Fetch robots.txt with a short timeout — never block the caller on a
    // slow robots.txt response.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    let robotsText = "";
    try {
      const res = await fetch(`${host}/robots.txt`, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/plain" },
        signal: controller.signal,
        redirect: "follow",
      });
      if (res.ok) {
        robotsText = await res.text();
      } else {
        // No robots.txt = everything allowed.
        const entry: RobotsCacheEntry = {
          allowed: true,
          reason: `robots.txt HTTP ${res.status}`,
          fetchedAt: Date.now(),
          expiresAt: Date.now() + ROBOTS_CACHE_TTL_MS,
        };
        robotsCache.set(host, entry);
        return { allowed: true, reason: entry.reason };
      }
    } catch (err) {
      // Network / timeout — fail open.
      const entry: RobotsCacheEntry = {
        allowed: true,
        reason: `robots.txt fetch failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        fetchedAt: Date.now(),
        expiresAt: Date.now() + ROBOTS_CACHE_TTL_MS,
      };
      robotsCache.set(host, entry);
      return { allowed: true, reason: entry.reason };
    } finally {
      clearTimeout(timer);
    }

    const { allowed, reason } = parseRobots(robotsText, path);
    robotsCache.set(host, {
      allowed,
      reason,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + ROBOTS_CACHE_TTL_MS,
    });
    return { allowed, reason };
  } catch (err) {
    // URL parse error — fail open (the URL validator will catch this).
    return {
      allowed: true,
      reason: `robots check parse error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * Minimal robots.txt parser. Considers ONLY `User-agent: *` rules. Honors
 * `Disallow:` and `Allow:` lines. Returns `{ allowed, reason }`.
 *
 * The parser is deliberately conservative: any rule it can't interpret
 * (including `Crawl-delay`, `Sitemap:`) is ignored. We only need enough
 * to be a good citizen, not a full RFC 9309 implementation.
 */
function parseRobots(
  text: string,
  path: string
): { allowed: boolean; reason: string } {
  const lines = text.split(/\r?\n/);
  let inStarSection = false;
  let starSectionEnded = false;
  // Collect Allow / Disallow rules from the `User-agent: *` section.
  const rules: Array<{ type: "allow" | "disallow"; pattern: string }> = [];
  for (const raw of lines) {
    const line = (raw ?? "").trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = (match[2] ?? "").trim();
    if (key === "user-agent") {
      if (starSectionEnded) continue;
      if (value === "*") {
        inStarSection = true;
      } else if (inStarSection) {
        // A different user-agent started — close the * section.
        starSectionEnded = true;
        inStarSection = false;
      }
      continue;
    }
    if (!inStarSection || starSectionEnded) continue;
    if (key === "allow") {
      rules.push({ type: "allow", pattern: value });
    } else if (key === "disallow") {
      rules.push({ type: "disallow", pattern: value });
    }
  }

  // Match the longest-prefix rule. Empty `Disallow:` means everything is
  // allowed (the default when there are no rules).
  let bestMatch: { type: "allow" | "disallow"; pattern: string } | null = null;
  for (const r of rules) {
    if (r.pattern === "") continue;
    if (path.startsWith(r.pattern)) {
      if (
        !bestMatch ||
        r.pattern.length > bestMatch.pattern.length
      ) {
        bestMatch = r;
      }
    }
  }
  if (!bestMatch) {
    return { allowed: true, reason: "no matching robots.txt rule" };
  }
  if (bestMatch.type === "allow") {
    return { allowed: true, reason: `robots.txt Allow: ${bestMatch.pattern}` };
  }
  return {
    allowed: false,
    reason: `robots.txt Disallow: ${bestMatch.pattern}`,
  };
}

// ---------------------------------------------------------------------------
// HTML → text extraction (regex-based stripper — no DOM parser dependency)
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags + decode entities into plain text. Removes `<script>` and
 * `<style>` blocks entirely (their content is never useful for the LLM and
 * may contain prompt-injection payloads). Decodes the common named HTML
 * entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&nbsp;`) and
 * numeric `&#NN;` / `&#xNN;` forms.
 *
 * Collapses runs of whitespace so the LLM doesn't see a wall of indented
 * source. Truncates to {@link MAX_TEXT_LENGTH} chars so a giant page
 * doesn't blow through the budget.
 */
export function htmlToText(html: string): string {
  if (typeof html !== "string" || html.length === 0) return "";
  let text = html;
  // Strip script + style blocks entirely (including their content).
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  // Replace block-level closing tags with a newline so the text doesn't
  // collapse onto a single line.
  text = text.replace(/<\/(p|div|section|article|li|h[1-6]|tr|td|th|header|footer|nav|main|aside|blockquote|pre|table|ul|ol)\s*>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Remove all remaining tags.
  text = text.replace(/<[^>]+>/g, "");
  // Decode named entities.
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  // Decode numeric entities (&#NN; and &#xNN;).
  text = text.replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(Number(dec)));
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)));
  // Collapse runs of whitespace.
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n\s*\n\s*\n*/g, "\n\n");
  text = text.trim();
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.slice(0, MAX_TEXT_LENGTH) + "\n…[truncated]";
  }
  return text;
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

/**
 * Extract all href URLs from an HTML document and resolve them against the
 * base URL. Returns absolute URLs (string form) for every `<a href="…">`
 * found. Skips `javascript:`, `data:`, `mailto:`, `tel:` links.
 *
 * Used by the Research Agent to discover corroborating links from a
 * fetched source page.
 */
export function extractLinks(html: string, baseUrl: string): string[] {
  if (typeof html !== "string" || html.length === 0) return [];
  let base: URL | null = null;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const hrefRegex = /<a\s+[^>]*href\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (
      lower.startsWith("javascript:") ||
      lower.startsWith("data:") ||
      lower.startsWith("mailto:") ||
      lower.startsWith("tel:")
    ) {
      continue;
    }
    try {
      const resolved = new URL(raw, base).toString();
      if (!seen.has(resolved)) {
        seen.add(resolved);
        out.push(resolved);
      }
    } catch {
      // skip unparseable
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public: fetchUrl
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

/**
 * Fetch a URL with timeout, max-bytes cap, robots.txt awareness, HTML→text
 * extraction, sanitisation (spec §21), and 1-hour in-memory caching.
 *
 * NEVER throws — always returns a `FetchResult` (with `ok: false` on any
 * failure). The caller can dispatch on `ok` and surface `error` to the LLM
 * as a context note.
 *
 * Budget: records one `BudgetManager.recordWebRequest()` BEFORE the fetch
 * (so the daily web-request cap is enforced even when the provider hangs).
 */
export async function fetchUrl(
  url: string,
  opts: FetchUrlOpts = {}
): Promise<FetchResult> {
  const fetchedAt = new Date().toISOString();

  // --- Validate the URL first (spec §7, §32 — SSRF / homograph guard) ------
  const validation = validateUrl(url);
  if (!validation.valid || !validation.safe) {
    return {
      url,
      ok: false,
      status: 0,
      contentType: "",
      text: "",
      bytes: 0,
      fetchedAt,
      error: `URL rejected: ${validation.reasons.join("; ")}`,
    };
  }
  const safeUrl = validation.normalized;

  // --- Cache lookup -------------------------------------------------------
  const cached = getCached(safeUrl);
  if (cached) return cached;

  // --- robots.txt check (spec §12) ---------------------------------------
  if (!opts.skipRobots) {
    const robots = await checkRobots(safeUrl);
    if (!robots.allowed) {
      const result: FetchResult = {
        url: safeUrl,
        ok: false,
        status: 0,
        contentType: "",
        text: "",
        bytes: 0,
        fetchedAt,
        error: `robots.txt disallows fetch: ${robots.reason ?? "matched Disallow rule"}`,
      };
      setCached(safeUrl, result);
      return result;
    }
  }

  // --- Budget pre-record --------------------------------------------------
  try {
    await BudgetManager.getInstance().recordWebRequest();
  } catch (err) {
    console.error("[http-fetch] recordWebRequest threw:", err);
  }

  // --- Fetch with timeout + max-bytes ------------------------------------
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let status = 0;
  let contentType = "";
  let rawHtml = "";

  try {
    const res = await fetch(safeUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,application/json;q=0.5,*/*;q=0.3",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    status = res.status;
    contentType = (res.headers.get("content-type") ?? "").toLowerCase();

    // Read the body up to maxBytes. The reader is read in chunks so we
    // can abort cleanly if the response exceeds the cap.
    const reader = res.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder("utf-8");
      let received = 0;
      let aborted = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          aborted = true;
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          break;
        }
        rawHtml += decoder.decode(value, { stream: true });
      }
      rawHtml += decoder.decode();
      if (aborted) {
        const result: FetchResult = {
          url: safeUrl,
          ok: false,
          status,
          contentType,
          text: "",
          bytes: received,
          fetchedAt,
          error: `response exceeded maxBytes=${maxBytes}`,
        };
        setCached(safeUrl, result);
        return result;
      }
    } else {
      // No streaming body — read all at once.
      rawHtml = await res.text();
      if (rawHtml.length > maxBytes) {
        rawHtml = rawHtml.slice(0, maxBytes);
      }
    }

    if (!res.ok) {
      const result: FetchResult = {
        url: safeUrl,
        ok: false,
        status,
        contentType,
        text: "",
        bytes: rawHtml.length,
        fetchedAt,
        error: `HTTP ${status} ${res.statusText}`,
      };
      setCached(safeUrl, result);
      return result;
    }

    // --- HTML → text extraction -----------------------------------------
    // For non-HTML content (e.g. JSON, plain text), pass through as-is —
    // the regex stripper is a no-op for content without tags.
    const isHtml =
      contentType.includes("html") ||
      /^\s*<(?:html|head|body|!doctype|div|p|section)/i.test(rawHtml);
    const text = isHtml ? htmlToText(rawHtml) : rawHtml;

    // --- Sanitize (spec §21) -------------------------------------------
    // External content is DATA, not instructions. Wrap in delimiters so
    // the LLM sees it as inert.
    const sanitized = sanitizeExternalContent(
      text,
      `fetch:${safeUrl}`
    );
    const safeText = sanitized.safe ? sanitized.sanitized : "";

    const result: FetchResult = {
      url: safeUrl,
      ok: true,
      status,
      contentType,
      text: safeText,
      bytes: rawHtml.length,
      fetchedAt,
      raw: opts.keepRaw ? rawHtml : undefined,
    };
    setCached(safeUrl, result);
    return result;
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const message = isAbort
      ? `timeout after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    const result: FetchResult = {
      url: safeUrl,
      ok: false,
      status,
      contentType,
      text: "",
      bytes: 0,
      fetchedAt,
      error: message,
    };
    setCached(safeUrl, result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
