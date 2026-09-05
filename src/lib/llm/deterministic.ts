// LEVEL 1 deterministic tools (spec §4G — "no LLM needed").
//
// The router classifies some tasks as routing_level=1 — meaning the work can
// be done deterministically without burning an LLM call. These are the
// functions the router hands off to instead of calling `callLLM`.
//
// All functions here are PURE and SYNCHRONOUS (or async only because the
// underlying wallet adapter is async). They never invoke an LLM, never log
// agent events, and never throw — they always return a typed result so the
// caller can route on `success` without try/catch.
//
// Spec §8 explicitly forbids letting the LLM do final arithmetic. This module
// is the implementation of that rule for the most common arithmetic-shaped
// tasks (JSON validation, arithmetic, wallet balance checks).

import { getWalletSummary } from "@/lib/wallet/monitor";
import { computeEconomics, type EconomicsInput } from "@/lib/economics/engine";
import type { EconomicsEstimate } from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// Wallet balance (spec §4G — deterministic routing target)
// ---------------------------------------------------------------------------

/** Result of `deterministicWalletBalance()`. */
export interface WalletBalanceResult {
  success: boolean;
  totalUsd: number;
  fetchedAt: string;
  /** Number of wallets in the snapshot (including failed RPCs). */
  count: number;
  /** Optional error if the snapshot could not be fetched. */
  error?: string;
}

/**
 * Fetch a deterministic wallet-balance summary. Spec §4G routes "wallet
 * balance" tasks here instead of calling an LLM — the LLM cannot produce a
 * trustworthy balance and the real value lives in the wallet adapters.
 *
 * Returns a small, dashboard-friendly summary; the full per-wallet detail
 * stays in the wallet monitor snapshot.
 */
export async function deterministicWalletBalance(): Promise<WalletBalanceResult> {
  try {
    const summary = await getWalletSummary();
    return {
      success: true,
      totalUsd: summary.totalUsd,
      fetchedAt: summary.fetchedAt,
      count: summary.wallets.length,
    };
  } catch (err) {
    return {
      success: false,
      totalUsd: 0,
      fetchedAt: new Date().toISOString(),
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Safe arithmetic (spec §4G — "arithmetic")
// ---------------------------------------------------------------------------

/** Result of `deterministicArithmetic()`. */
export interface ArithmeticResult {
  success: boolean;
  expression: string;
  result?: number;
  error?: string;
}

/**
 * Evaluate a simple arithmetic expression consisting only of numbers and the
 * four basic operators `+ - * /` (plus parentheses and whitespace). NEVER
 * uses `eval` or `Function()` — we hand-tokenise so the function is safe to
 * call on untrusted input.
 *
 * Spec §4G — the LLM is forbidden from doing final arithmetic; this is the
 * deterministic replacement the router routes "arithmetic" tasks to.
 *
 * Examples:
 *   deterministicArithmetic("2 + 3 * 4")      → 14
 *   deterministicArithmetic("(2 + 3) * 4")    → 20
 *   deterministicArithmetic("10 / 4")         → 2.5
 *   deterministicArithmetic("1 + ")           → { success: false, error: ... }
 *
 * Returns `{ success: false, error }` on any parse or runtime failure.
 */
export function deterministicArithmetic(expr: string): ArithmeticResult {
  if (typeof expr !== "string" || expr.trim() === "") {
    return { success: false, expression: String(expr ?? ""), error: "empty expression" };
  }
  // Reject anything outside the allowed character set (digits, operators,
  // parentheses, decimal points, whitespace). This is a hard whitelist —
  // there is no path for any other character (including letters, semicolons,
  // or other shell metacharacters) to reach the evaluator.
  if (!/^[0-9+\-*/().\s]+$/.test(expr)) {
    return { success: false, expression: expr, error: "invalid characters in expression" };
  }

  try {
    const tokens = tokenize(expr);
    const parser = new Parser(tokens);
    const value = parser.parseExpression();
    if (!parser.atEnd()) {
      return { success: false, expression: expr, error: "unexpected trailing tokens" };
    }
    if (!Number.isFinite(value)) {
      return { success: false, expression: expr, error: "result is not finite (div by zero?)" };
    }
    return { success: true, expression: expr, result: value };
  } catch (err) {
    return {
      success: false,
      expression: expr,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- tiny recursive-descent parser for + - * / ( ) -------------------------

type Token = { kind: "num"; value: number } | { kind: "op"; value: string };

function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "(" || c === ")") {
      tokens.push({ kind: "op", value: c });
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let num = "";
      while (i < s.length && /[0-9.]/.test(s[i])) {
        num += s[i];
        i += 1;
      }
      const value = Number(num);
      if (!Number.isFinite(value)) {
        throw new Error(`invalid number literal: ${num}`);
      }
      tokens.push({ kind: "num", value });
      continue;
    }
    // Should be unreachable because of the regex guard at the top, but be
    // defensive anyway.
    throw new Error(`unexpected character: ${c}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error("unexpected end of expression");
    this.pos += 1;
    return t;
  }

  // Grammar:
  //   expression := term (('+' | '-') term)*
  //   term       := factor (('*' | '/') factor)*
  //   factor     := number | '(' expression ')' | '-' factor
  parseExpression(): number {
    let left = this.parseTerm();
    while (true) {
      const t = this.peek();
      if (t && t.kind === "op" && (t.value === "+" || t.value === "-")) {
        this.consume();
        const right = this.parseTerm();
        left = t.value === "+" ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parseFactor();
    while (true) {
      const t = this.peek();
      if (t && t.kind === "op" && (t.value === "*" || t.value === "/")) {
        this.consume();
        const right = this.parseFactor();
        if (t.value === "*") {
          left = left * right;
        } else {
          if (right === 0) throw new Error("division by zero");
          left = left / right;
        }
      } else {
        break;
      }
    }
    return left;
  }

  private parseFactor(): number {
    const t = this.consume();
    if (t.kind === "num") return t.value;
    if (t.kind === "op") {
      if (t.value === "(") {
        const inner = this.parseExpression();
        const close = this.consume();
        if (close.kind !== "op" || close.value !== ")") {
          throw new Error("expected closing parenthesis");
        }
        return inner;
      }
      if (t.value === "-") {
        return -this.parseFactor();
      }
      if (t.value === "+") {
        return this.parseFactor();
      }
    }
    throw new Error(`unexpected token: ${JSON.stringify(t)}`);
  }
}

// ---------------------------------------------------------------------------
// JSON validation (spec §4G — "JSON validation")
// ---------------------------------------------------------------------------

/** Result of `validateJSON()`. */
export interface JSONValidationResult {
  valid: boolean;
  parsed?: unknown;
  error?: string;
}

/**
 * Try to parse `text` as JSON. Returns `{ valid: true, parsed }` on success
 * or `{ valid: false, error }` on failure. Never throws.
 *
 * Spec §4G routes "JSON validation" tasks here — no need to spend an LLM
 * call on something `JSON.parse` can answer authoritatively.
 */
export function validateJSON(text: string): JSONValidationResult {
  if (typeof text !== "string") {
    return { valid: false, error: "input is not a string" };
  }
  if (text.trim() === "") {
    return { valid: false, error: "input is empty" };
  }
  try {
    const parsed = JSON.parse(text);
    return { valid: true, parsed };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// HTML safety validation (spec §6, §7 — used by Security agent)
// ---------------------------------------------------------------------------

/** Result of `validateHTMLSafety()`. */
export interface HTMLSafetyResult {
  safe: boolean;
  /** Individual dangerous patterns detected, in priority order. */
  flags: string[];
  /** Optional notes explaining why each flag fired. */
  notes: string[];
}

/**
 * Validate a string of HTML for dangerous patterns. Used by the Security
 * agent (spec §6, §7) to gate LLM-generated content before it is rendered
 * or persisted.
 *
 * The check is pattern-based (not a full HTML parser) — it is deliberately
 * conservative and will flag suspicious-but-harmless constructs. False
 * positives are preferred over false negatives here; the Security agent
 * always escalates any `safe: false` result for human review.
 *
 * Flags:
 *   - script_tag           — `<script>` element
 *   - inline_event_handler — on* attributes (onclick, onerror, ...)
 *   - javascript_uri       — `javascript:` URIs in href/src
 *   - data_uri_html        — `data:text/html` URIs
 *   - iframe_srcdoc        — `<iframe srcdoc=...>` (scriptable iframe)
 *   - object_embed         — `<object>`, `<embed>`, `<applet>`
 *   - base_tag             — `<base href>` (can hijack relative URLs)
 *   - meta_refresh         — `<meta http-equiv="refresh">` (redirect)
 *   - expression_eval      — CSS `expression(...)` (legacy IE RCE)
 *   - import_tag           — `<link rel="import">` (HTML import — removed from
 *                            browsers but still flagged for safety)
 */
export function validateHTMLSafety(html: string): HTMLSafetyResult {
  const flags: string[] = [];
  const notes: string[] = [];

  if (typeof html !== "string" || html.length === 0) {
    return { safe: true, flags, notes };
  }

  // Lower-case the input for case-insensitive pattern matching. We keep the
  // original around for the notes.
  const lower = html.toLowerCase();

  if (/<\s*script[\s>]/i.test(html) || /<\s*\/\s*script\s*>/i.test(html)) {
    flags.push("script_tag");
    notes.push("Found a <script> element — inline script execution is forbidden.");
  }

  // on* event-handler attributes. We require an `=` after the attribute
  // name to avoid false positives on words like "online" or "ontology".
  if (/\son[a-z]+\s*=/i.test(html)) {
    flags.push("inline_event_handler");
    notes.push("Found an inline event-handler attribute (on*=).");
  }

  if (/javascript:\s*[^"'\s]/i.test(html)) {
    flags.push("javascript_uri");
    notes.push("Found a `javascript:` URI — script-execution vector.");
  }

  if (/data:\s*text\/html/i.test(lower)) {
    flags.push("data_uri_html");
    notes.push("Found a `data:text/html` URI — can carry scriptable HTML.");
  }

  if (/<\s*iframe[^>]*srcdoc\s*=/i.test(html)) {
    flags.push("iframe_srcdoc");
    notes.push("Found an `<iframe srcdoc=...>` — scriptable inline iframe.");
  }

  if (/<\s*(object|embed|applet)\b/i.test(html)) {
    flags.push("object_embed");
    notes.push("Found a plugin element (<object>/<embed>/<applet>).");
  }

  if (/<\s*base\b[^>]*href\s*=/i.test(html)) {
    flags.push("base_tag");
    notes.push("Found a `<base href=...>` — can hijack relative URLs.");
  }

  if (/<\s*meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(html)) {
    flags.push("meta_refresh");
    notes.push("Found a `<meta http-equiv='refresh'>` — automatic redirect.");
  }

  if (/expression\s*\(/i.test(lower)) {
    flags.push("expression_eval");
    notes.push("Found a CSS `expression(...)` — legacy script-execution vector.");
  }

  if (/<\s*link\b[^>]*rel\s*=\s*["']?import/i.test(html)) {
    flags.push("import_tag");
    notes.push("Found a `<link rel='import'>` — HTML import (legacy).");
  }

  return { safe: flags.length === 0, flags, notes };
}

// ---------------------------------------------------------------------------
// Economics — re-export from the deterministic engine (spec §8)
// ---------------------------------------------------------------------------

export type { EconomicsEstimate, EconomicsInput };

/**
 * Convenience wrapper around the pure economic engine (spec §8). The LLM is
 * NEVER given a path to do this arithmetic — `computeEconomics` is the
 * deterministic source of truth for every dollar value the agent cites.
 */
export function computeEconomicsDeterministic(input: EconomicsInput): EconomicsEstimate {
  return computeEconomics(input);
}

// ---------------------------------------------------------------------------
// File operation result (spec §4G — "file operation")
// ---------------------------------------------------------------------------

/** Result of `deterministicFileOp()`. */
export interface FileOpResult {
  success: boolean;
  op: string;
  path?: string;
  bytes?: number;
  error?: string;
}

/**
 * Spec §4G routes "file operation" tasks here. We do NOT expose a generic
 * file API (the agent should use the dedicated scanner / writer modules for
 * persistence); this function returns a structured "no-op" result so the
 * router has a deterministic target to route to without crashing.
 *
 * Phase-3 fix: previously this stub returned `success: true` even though
 * no file operation was performed — a caller that trusted the result
 * would believe "files written" when nothing happened. We now return
 * `success: false` with a clear error explaining that this is a routing
 * stub, NOT a real file operation. Concrete file operations are
 * implemented by their dedicated modules (e.g. `src/lib/wallet/monitor.ts`,
 * `src/lib/economics/ledger.ts`, `src/lib/coding/workspace.ts`).
 *
 * Callers that genuinely need to read/write files should use
 * `CodingWorkspace.readFile` / `writeFile` (src/lib/coding/workspace.ts),
 * which uses the `fs` module and returns real success/failure.
 */
export function deterministicFileOp(
  op: string,
  path?: string
): FileOpResult {
  return {
    success: false,
    op,
    path,
    bytes: 0,
    error:
      "deterministicFileOp is a routing stub, not a real file operation. " +
      "Use CodingWorkspace.readFile/writeFile (src/lib/coding/workspace.ts) " +
      "for actual file I/O.",
  };
}
