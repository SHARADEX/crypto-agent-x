// Shared HTTP helpers for source adapters (Phase-2 spec §18, §21).
//
// Every adapter needs the same plumbing:
//
//   1. Record `BudgetManager.recordWebRequest()` BEFORE the fetch (so an
//      over-budget state is caught before the request goes out).
//   2. AbortController timeout (default 10s — spec §5).
//   3. Run external content through `sanitizeExternalContent` (§21) — the
//      sanitiser's RISK SCORE gates whether content is dropped, but the
//      adapter parses the RAW body (not the LLM-wrapped form). The
//      wrapping is for LLM consumption; structured JSON/XML parsing needs
//      the raw bytes.
//   4. NEVER throw — return `null` on any failure (caller decides `[]`).
//
// Consolidating these here keeps each adapter focused on the per-source
// mapping logic. The helper is intentionally tiny — no retry, no caching,
// no robots.txt (adapters hit first-party JSON APIs that explicitly want
// machine traffic, not arbitrary web pages).

import { BudgetManager } from "@/lib/budget/manager";
import { sanitizeExternalContent } from "@/lib/security/prompt-injection";
import { validateUrl } from "@/lib/security/url-validator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SafeFetchJsonResult<T> {
  ok: boolean;
  status: number;
  /** Parsed JSON object, when the body parsed successfully. */
  json: T | null;
  /** Error message when `ok === false`. */
  error?: string;
  /** Round-trip latency in ms. */
  latencyMs: number;
}

export interface SafeFetchTextResult {
  ok: boolean;
  status: number;
  /** Raw text body (used by RSS / XML adapters for regex parsing). */
  text: string;
  /** Response Content-Type header (lower-cased). */
  contentType: string;
  error?: string;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_SOURCE_TIMEOUT_MS = 10_000;
export const DEFAULT_SOURCE_MAX_BYTES = 1 * 1024 * 1024; // 1 MB
export const SOURCE_USER_AGENT =
  "CryptoEarn-Agent/0.3 (sources; +https://github.com/cryptoearn/agent)";

/**
 * When the sanitiser's riskScore exceeds this threshold the helper drops the
 * response body entirely (treats it as a fetch failure). Below this
 * threshold the body is returned for the adapter to parse — the sanitiser
 * has already confirmed the content does not contain active prompt-injection
 * payloads.
 *
 * Mirrors `DANGEROUS_THRESHOLD` from prompt-injection.ts (we import the
 * constant directly to avoid drift).
 */
import { DANGEROUS_THRESHOLD } from "@/lib/security/prompt-injection";

// ---------------------------------------------------------------------------
// fetchJsonSafe — for REST/GraphQL adapters (Gitcoin, Devpost, OnlyDust, …)
// ---------------------------------------------------------------------------

/**
 * Fetch a URL with timeout + budget + content-sanitisation and parse the
 * body as JSON. NEVER throws — returns `{ ok: false, error }` on any
 * failure (network, timeout, parse error, non-2xx status, sanitiser drop).
 *
 * Spec §21: external content is sanitised BEFORE being parsed. The
 * sanitiser's RISK SCORE decides whether the body is dropped — adapters
 * parse the RAW body, not the LLM-wrapped form (the wrapping delimiters
 * would break JSON.parse).
 *
 * @param url     the URL to fetch
 * @param init    fetch init (method, headers, body for POST GraphQL)
 * @param opts    timeoutMs, maxBytes
 */
export async function fetchJsonSafe<T = unknown>(
  url: string,
  init?: RequestInit,
  opts: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<SafeFetchJsonResult<T>> {
  const start = Date.now();
  const validation = validateUrl(url);
  if (!validation.valid || !validation.safe) {
    return {
      ok: false,
      status: 0,
      json: null,
      error: `URL rejected: ${validation.reasons.join("; ")}`,
      latencyMs: Date.now() - start,
    };
  }

  // Budget pre-record.
  try {
    await BudgetManager.getInstance().recordWebRequest();
  } catch (err) {
    console.warn("[sources/_http] recordWebRequest failed:", err);
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_SOURCE_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let status = 0;
  let rawText = "";

  try {
    const res = await fetch(validation.normalized, {
      ...init,
      headers: {
        "User-Agent": SOURCE_USER_AGENT,
        Accept: "application/json,application/graphql+json,text/plain;q=0.5",
        ...(init?.headers ?? {}),
      },
      redirect: "follow",
      signal: controller.signal,
    });
    status = res.status;

    // Streamed read with maxBytes cap.
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
        rawText += decoder.decode(value, { stream: true });
      }
      rawText += decoder.decode();
      if (aborted) {
        return {
          ok: false,
          status,
          json: null,
          error: `response exceeded maxBytes=${maxBytes}`,
          latencyMs: Date.now() - start,
        };
      }
    } else {
      rawText = await res.text();
      if (rawText.length > maxBytes) rawText = rawText.slice(0, maxBytes);
    }

    if (!res.ok) {
      return {
        ok: false,
        status,
        json: null,
        error: `HTTP ${status} ${res.statusText}`,
        latencyMs: Date.now() - start,
      };
    }

    // Sanitise the raw text (spec §21). The sanitiser's RISK SCORE decides
    // whether we drop the content entirely. We parse the RAW text (not the
    // LLM-wrapped form) as JSON — the wrapping delimiters would break
    // JSON.parse.
    const sanitized = sanitizeExternalContent(rawText, `sources:${url}`);
    if (!sanitized.safe || sanitized.riskScore > DANGEROUS_THRESHOLD) {
      return {
        ok: false,
        status,
        json: null,
        error: `content dropped by sanitizer (risk=${sanitized.riskScore}, patterns=${sanitized.detectedPatterns.join(",")})`,
        latencyMs: Date.now() - start,
      };
    }

    let json: T | null = null;
    try {
      json = JSON.parse(rawText) as T;
    } catch {
      return {
        ok: false,
        status,
        json: null,
        error: "response body was not valid JSON",
        latencyMs: Date.now() - start,
      };
    }

    return {
      ok: true,
      status,
      json,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const msg = isAbort
      ? `timeout after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return {
      ok: false,
      status,
      json: null,
      error: msg,
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// fetchTextSafe — for RSS / HTML adapters
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and return its raw text body. NEVER throws.
 *
 * The response is still passed through the sanitiser for the RISK-SCORE
 * gate; the adapter receives the RAW text (XML / RSS / HTML) because the
 * LLM-wrapped form would break regex-based XML parsing.
 *
 * Used by the RSS adapter (parses XML via regex) and as a fallback for
 * Hashnode (HTML when the GraphQL endpoint is unreachable).
 */
export async function fetchTextSafe(
  url: string,
  init?: RequestInit,
  opts: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<SafeFetchTextResult> {
  const start = Date.now();
  const validation = validateUrl(url);
  if (!validation.valid || !validation.safe) {
    return {
      ok: false,
      status: 0,
      text: "",
      contentType: "",
      error: `URL rejected: ${validation.reasons.join("; ")}`,
      latencyMs: Date.now() - start,
    };
  }

  try {
    await BudgetManager.getInstance().recordWebRequest();
  } catch (err) {
    console.warn("[sources/_http] recordWebRequest failed:", err);
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_SOURCE_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let status = 0;
  let contentType = "";
  let rawText = "";

  try {
    const res = await fetch(validation.normalized, {
      ...init,
      headers: {
        "User-Agent": SOURCE_USER_AGENT,
        Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,text/html;q=0.5,*/*;q=0.3",
        ...(init?.headers ?? {}),
      },
      redirect: "follow",
      signal: controller.signal,
    });
    status = res.status;
    contentType = (res.headers.get("content-type") ?? "").toLowerCase();

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
        rawText += decoder.decode(value, { stream: true });
      }
      rawText += decoder.decode();
      if (aborted) {
        return {
          ok: false,
          status,
          text: "",
          contentType,
          error: `response exceeded maxBytes=${maxBytes}`,
          latencyMs: Date.now() - start,
        };
      }
    } else {
      rawText = await res.text();
      if (rawText.length > maxBytes) rawText = rawText.slice(0, maxBytes);
    }

    if (!res.ok) {
      return {
        ok: false,
        status,
        text: "",
        contentType,
        error: `HTTP ${status} ${res.statusText}`,
        latencyMs: Date.now() - start,
      };
    }

    // Sanitiser risk-score gate (spec §21). Raw text returned for XML parsing.
    const sanitized = sanitizeExternalContent(rawText, `sources:${url}`);
    if (!sanitized.safe || sanitized.riskScore > DANGEROUS_THRESHOLD) {
      return {
        ok: false,
        status,
        text: "",
        contentType,
        error: `content dropped by sanitizer (risk=${sanitized.riskScore})`,
        latencyMs: Date.now() - start,
      };
    }

    return {
      ok: true,
      status,
      text: rawText,
      contentType,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const msg = isAbort
      ? `timeout after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return {
      ok: false,
      status,
      text: "",
      contentType,
      error: msg,
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Clamp a number to [min, max], NaN → fallback. */
export function clampNum(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

/** Coerce to a trimmed string, fallback when empty. */
export function toStr(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v.trim();
  if (v === null || v === undefined) return fallback;
  return String(v).trim();
}
