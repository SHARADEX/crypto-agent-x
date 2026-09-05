// Benchmark suite — pure deterministic graders (Phase-2 §7 / P2-4 / P1-7).
//
// Every grader here is PURE: no I/O, no network, no LLM judging, no Math.random.
// They take a model's text response + the expected value and return a
// `BenchmarkGrade` (0..1 score + pass/fail + human-readable detail).
//
// The graders are defensive — they never throw. A response that doesn't parse
// as JSON, doesn't contain a function, or doesn't match a regex just scores 0
// with a helpful detail string. The runner (`runner.ts`) wraps everything in
// try/catch as well, so even a buggy grader can't crash the benchmark.
//
// Spec §7: "Do NOT score everything through another LLM" — these functions
// are the implementation of that rule.

import type { BenchmarkGrade } from "./types";
import { z } from "zod";

// ---------------------------------------------------------------------------
// JSON extraction + schema validation
// ---------------------------------------------------------------------------

/**
 * Try hard to extract a JSON value from a model's text response.
 *
 * Strategies, in order:
 *   1. `JSON.parse(response)` — model emitted bare JSON.
 *   2. Fenced ```json ... ``` code block.
 *   3. Fenced ``` ... ``` code block (no language tag).
 *   4. First balanced `{ ... }` or `[ ... ]` substring.
 *
 * Returns `{ ok: true, value }` on success or `{ ok: false, error }` on miss.
 * NEVER throws.
 */
export function extractJson(
  response: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!response || typeof response !== "string") {
    return { ok: false, error: "empty response" };
  }

  // 1. bare JSON
  try {
    return { ok: true, value: JSON.parse(response) };
  } catch {
    // fall through
  }

  // 2. fenced json code block
  const fencedJson = response.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJson?.[1]) {
    try {
      return { ok: true, value: JSON.parse(fencedJson[1].trim()) };
    } catch (err) {
      return { ok: false, error: `fenced-json parse: ${msg(err)}` };
    }
  }

  // 3. fenced plain code block (no language tag)
  const fencedPlain = response.match(/```\s*([\s\S]*?)```/);
  if (fencedPlain?.[1]) {
    const inner = fencedPlain[1].trim();
    if (inner.startsWith("{") || inner.startsWith("[")) {
      try {
        return { ok: true, value: JSON.parse(inner) };
      } catch (err) {
        return { ok: false, error: `fenced-plain parse: ${msg(err)}` };
      }
    }
  }

  // 4. first balanced object or array substring
  const balanced = extractFirstBalanced(response);
  if (balanced) {
    try {
      return { ok: true, value: JSON.parse(balanced) };
    } catch (err) {
      return { ok: false, error: `balanced-substring parse: ${msg(err)}` };
    }
  }

  return { ok: false, error: "no JSON found in response" };
}

/**
 * Find the first balanced `{...}` or `[...]` substring. Handles nested
 * braces / brackets / strings with escape sequences. Returns null if no
 * balanced run is found.
 */
function extractFirstBalanced(s: string): string | null {
  const openIdx = s.search(/[[{]/);
  if (openIdx < 0) return null;
  const open = s[openIdx];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr: string | null = null;
  let escaped = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(openIdx, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

/**
 * Grade a JSON response against a zod schema.
 *
 *   pass   -> 1.0
 *   parse-fail / wrong shape -> 0
 *
 * No partial score for JSON — either it parses and matches or it doesn't.
 */
export function gradeJsonSchema(
  response: string,
  schema: z.ZodType
): BenchmarkGrade {
  const extracted = extractJson(response);
  if (!extracted.ok) {
    return {
      score: 0,
      passed: false,
      details: `json-extraction failed: ${extracted.error}`,
    };
  }
  const parsed = schema.safeParse(extracted.value);
  if (parsed.success) {
    return {
      score: 1,
      passed: true,
      details: "json valid + matches schema",
    };
  }
  // Partial credit: parsed as JSON but didn't match the schema. If the
  // value at least has the right top-level shape, give 0.5.
  const topOk = hasRightShape(extracted.value, schema);
  return {
    score: topOk ? 0.5 : 0,
    passed: false,
    details: `schema mismatch: ${parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")}`,
  };
}

/**
 * Loose shape check — returns true if `value` is an object/array matching
 * the top-level kind of the zod schema (used for partial credit only).
 */
function hasRightShape(value: unknown, schema: z.ZodType): boolean {
  try {
    const def = (schema as unknown as { _def?: { typeName?: string } })._def;
    const tn = def?.typeName ?? "";
    if (
      tn === "ZodObject" &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      return true;
    }
    if (tn === "ZodArray" && Array.isArray(value)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Number extraction
// ---------------------------------------------------------------------------

/**
 * Extract the numeric answer from a model response. Strategy:
 *
 *   1. Look for an "Answer: <number>" or "Result: <number>" line — the model
 *      explicitly tagged its final answer. Take that number.
 *   2. Otherwise, take the LAST numeric token in the response (LLMs typically
 *      show working before the final answer, so the last number is the
 *      answer).
 *
 * Handles negative numbers, decimals, scientific notation, and thousands
 * separators ("57,933"). Returns NaN if no number is found.
 */
export function extractNumber(response: string): number {
  if (!response) return NaN;

  // 1. Look for an explicit "Answer: <n>" line. We accept colons (Western)
  //    and full-width colons (CJK), case-insensitive.
  const ansMatch = response.match(
    /(?:answer|result|final answer|the answer is)\s*[:]\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/i
  );
  if (ansMatch?.[1]) {
    return Number(ansMatch[1].replace(/,/g, ""));
  }

  // 2. Take the LAST numeric token in the response. Use a global regex so
  //    matchAll gives us every match; the last one is the answer.
  const re = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi;
  const matches = [...response.matchAll(re)];
  if (matches.length === 0) return NaN;
  return Number(matches[matches.length - 1][0].replace(/,/g, ""));
}

/**
 * Grade an arithmetic / numeric answer.
 *
 *   exact match -> 1.0
 *   within +/-1% of expected -> 0.5 (small numerical drift)
 *   otherwise -> 0
 */
export function gradeNumber(
  response: string,
  expected: number
): BenchmarkGrade {
  const got = extractNumber(response);
  if (!Number.isFinite(got)) {
    return { score: 0, passed: false, details: "no number found in response" };
  }
  if (got === expected) {
    return {
      score: 1,
      passed: true,
      details: `exact match (got=${got}, expected=${expected})`,
    };
  }
  const tol = Math.max(1, Math.abs(expected) * 0.01);
  if (Math.abs(got - expected) <= tol) {
    return {
      score: 0.5,
      passed: false,
      details: `within 1% (got=${got}, expected=${expected})`,
    };
  }
  return {
    score: 0,
    passed: false,
    details: `wrong number (got=${got}, expected=${expected})`,
  };
}

// ---------------------------------------------------------------------------
// Label extraction (classification)
// ---------------------------------------------------------------------------

/**
 * Extract a classification label from the response. The label set is
 * provided as a list of allowed labels (case-insensitive). The first label
 * that appears as a whole word in the response wins. Returns "" if none of
 * the labels appear.
 */
export function extractLabel(
  response: string,
  allowed: readonly string[]
): string {
  if (!response) return "";
  const lower = response.toLowerCase();
  const head = lower.slice(0, 80);
  for (const label of allowed) {
    const l = label.toLowerCase();
    if (head.includes(l)) return label;
  }
  for (const label of allowed) {
    const l = label.toLowerCase();
    const re = new RegExp(`\\b${escapeRegex(l)}\\b`, "i");
    if (re.test(response)) return label;
  }
  return "";
}

/**
 * Grade a classification case — exact label match (case-insensitive).
 */
export function gradeLabel(
  response: string,
  expected: { allowed: readonly string[]; answer: string }
): BenchmarkGrade {
  const got = extractLabel(response, expected.allowed);
  if (!got) {
    return {
      score: 0,
      passed: false,
      details: `no allowed label found (allowed: ${expected.allowed.join(", ")})`,
    };
  }
  if (got.toLowerCase() === expected.answer.toLowerCase()) {
    return {
      score: 1,
      passed: true,
      details: `correct label: ${got}`,
    };
  }
  return {
    score: 0,
    passed: false,
    details: `wrong label: got=${got}, expected=${expected.answer}`,
  };
}

// ---------------------------------------------------------------------------
// Keyword / answer extraction (reasoning, debugging, security, web3)
// ---------------------------------------------------------------------------

/**
 * Extract a short answer following common patterns:
 *   - "Answer: X"
 *   - "The answer is X"
 *   - "X." at the start of the response
 * Returns the first ~200 chars of the response if no pattern matches.
 */
export function extractShortAnswer(response: string): string {
  if (!response) return "";
  const patterns = [
    /answer\s*[:]\s*([^\n]+)/i,
    /the\s+answer\s+is\s*[:]?\s*([^\n.]+)/i,
    /final\s+answer\s*[:]\s*([^\n]+)/i,
    /result\s*[:]\s*([^\n]+)/i,
  ];
  for (const re of patterns) {
    const m = response.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return response.trim().slice(0, 200);
}

/**
 * Grade by checking that the response mentions a specific keyword/phrase
 * (case-insensitive). Used for "what's the bug?" / "what's the Solidity
 * keyword?" cases where there's one canonical answer term.
 */
export function gradeKeyword(
  response: string,
  expected: { keywords: string[]; requireAll?: boolean }
): BenchmarkGrade {
  const lower = response.toLowerCase();
  const hits = expected.keywords.map((k) => lower.includes(k.toLowerCase()));
  const matches = hits.filter(Boolean).length;
  if (expected.requireAll) {
    if (matches === expected.keywords.length) {
      return {
        score: 1,
        passed: true,
        details: `all keywords found: ${expected.keywords.join(", ")}`,
      };
    }
    return {
      score: matches / expected.keywords.length,
      passed: false,
      details: `partial: ${matches}/${expected.keywords.length} keywords (${expected.keywords
        .filter((_, i) => hits[i])
        .join(", ")})`,
    };
  }
  if (matches > 0) {
    const found = expected.keywords.find((k) =>
      lower.includes(k.toLowerCase())
    );
    return {
      score: 1,
      passed: true,
      details: `keyword found: ${found}`,
    };
  }
  return {
    score: 0,
    passed: false,
    details: `none of [${expected.keywords.join(", ")}] found in response`,
  };
}

// ---------------------------------------------------------------------------
// Function extraction (coding cases)
// ---------------------------------------------------------------------------

/**
 * Extract a TypeScript / JavaScript function definition from the model's
 * response and evaluate it inside a `new Function()` sandbox (NO
 * require/import allowed — only pure JS).
 *
 * The grader is robust to common LLM-output quirks:
 *   - Strips TypeScript type annotations (`: number`, `: string`, etc.) so
 *     that `function isPrime(n: number): boolean { ... }` evaluates as
 *     `function isPrime(n) { ... }` in the JS sandbox.
 *   - Strips ES module keywords (`export`, `default`) — they're invalid in
 *     `new Function`.
 *   - Tries the fenced code block first; falls back to the whole response.
 *
 * Returns `{ ok: true, fn }` if the function was extracted and the
 * `fnName` symbol is callable, or `{ ok: false, error }`.
 */
export function extractFunction(
  response: string,
  fnName: string
):
  | { ok: true; fn: (...args: unknown[]) => unknown }
  | { ok: false; error: string } {
  if (!response || !fnName) {
    return { ok: false, error: "missing response or fnName" };
  }

  const fence = response.match(
    /```(?:ts|js|typescript|javascript)?\s*([\s\S]*?)```/i
  );
  const raw = fence?.[1] ?? response;

  // Normalize the code so `new Function` (which is JS-only) can compile it.
  const code = stripTypeScriptAnnotations(raw);

  try {
    const factory = new Function(
      '"use strict";\n' +
        code +
        `\n; return typeof ${fnName} === "function" ? ${fnName} : null;`
    ) as () => ((...args: unknown[]) => unknown) | null;
    const fn = factory();
    if (typeof fn === "function") {
      return { ok: true, fn };
    }
    return {
      ok: false,
      error: `function "${fnName}" not defined after eval (typeof=${typeof fn})`,
    };
  } catch (err) {
    return { ok: false, error: `eval failed: ${msg(err)}` };
  }
}

/**
 * Run a candidate function against a list of test cases.
 *
 *   all pass -> 1.0
 *   partial  -> passCount / total (capped at 0.5 — partial credit only)
 *   none pass / exception -> 0
 */
export function gradeFunction(
  response: string,
  expected: {
    fnName: string;
    tests: { args: unknown[]; want: unknown }[];
  }
): BenchmarkGrade {
  const extracted = extractFunction(response, expected.fnName);
  if (!extracted.ok) {
    return {
      score: 0,
      passed: false,
      details: `extract: ${extracted.error}`,
    };
  }
  const fn = extracted.fn;
  let passed = 0;
  const failures: string[] = [];
  for (const t of expected.tests) {
    try {
      const got = fn(...t.args);
      if (deepEqual(got, t.want)) {
        passed += 1;
      } else {
        failures.push(
          `f(${t.args.map((a) => JSON.stringify(a)).join(", ")}) = ${JSON.stringify(got)} (want ${JSON.stringify(t.want)})`
        );
      }
    } catch (err) {
      failures.push(
        `f(${t.args.map((a) => JSON.stringify(a)).join(", ")}) threw: ${msg(err)}`
      );
    }
  }
  const total = expected.tests.length;
  if (passed === total) {
    return {
      score: 1,
      passed: true,
      details: `all ${total} tests passed`,
    };
  }
  if (passed > 0) {
    return {
      score: Math.min(0.5, passed / total),
      passed: false,
      details: `${passed}/${total} passed: ${failures.slice(0, 2).join("; ")}`,
    };
  }
  return {
    score: 0,
    passed: false,
    details: `0/${total} passed: ${failures[0] ?? "no tests"}`,
  };
}

// ---------------------------------------------------------------------------
// Constraint checking (instruction-following cases)
// ---------------------------------------------------------------------------

export interface Constraint {
  /** Human-readable label for the constraint. */
  name: string;
  /** Returns true if the constraint is satisfied. */
  check: (response: string) => boolean;
}

/**
 * Grade an instruction-following case by checking each constraint. Score =
 * fraction of constraints satisfied. Pass = ALL satisfied.
 */
export function checkConstraints(
  response: string,
  constraints: Constraint[]
): BenchmarkGrade {
  if (!response) {
    return { score: 0, passed: false, details: "empty response" };
  }
  const results = constraints.map((c) => ({
    name: c.name,
    ok: c.check(response),
  }));
  const okCount = results.filter((r) => r.ok).length;
  const score = okCount / constraints.length;
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  return {
    score,
    passed: okCount === constraints.length,
    details:
      okCount === constraints.length
        ? `all ${constraints.length} constraints satisfied`
        : `${okCount}/${constraints.length} satisfied (failed: ${failed.join(", ")})`,
  };
}

// ---------------------------------------------------------------------------
// Tool-call structure validation (tool_use cases)
// ---------------------------------------------------------------------------

// The literal tool-call tags are built via string concatenation so the
// source never contains the literal closing-tag substring (which would
// confuse the parameter parser when this file is written).
const TC_TAG_NAME = "tool_call";
const TC_OPEN_TAG = "<" + TC_TAG_NAME + ">";
const TC_CLOSE_TAG = "<" + "/" + TC_TAG_NAME + ">";

/**
 * Grade a tool-use response. Looks for a JSON object with `tool`/`name` and
 * `args`/`parameters` keys. Returns 1.0 for a fully valid structure, 0.5 for
 * partial (has a name but missing args), 0 otherwise.
 *
 * Some models emit pseudo-XML tool-call wrappers (built here via string
 * concatenation); those are also accepted.
 */
export function gradeToolCall(
  response: string,
  _expected: unknown
): BenchmarkGrade {
  void _expected;
  const extracted = extractJson(response);
  if (!extracted.ok) {
    const tcRegex = new RegExp(
      escapeRegex(TC_OPEN_TAG) + "\\s*([\\s\\S]*?)\\s*" + escapeRegex(TC_CLOSE_TAG),
      "i"
    );
    const toolCallMatch = response.match(tcRegex);
    if (toolCallMatch?.[1]) {
      try {
        const v = JSON.parse(toolCallMatch[1]);
        return gradeToolCallObject(v);
      } catch (err) {
        return {
          score: 0,
          passed: false,
          details: `tool_call parse: ${msg(err)}`,
        };
      }
    }
    return {
      score: 0,
      passed: false,
      details: `no JSON found: ${extracted.error}`,
    };
  }
  const value = Array.isArray(extracted.value)
    ? extracted.value[0]
    : extracted.value;
  return gradeToolCallObject(value);
}

function gradeToolCallObject(v: unknown): BenchmarkGrade {
  if (typeof v !== "object" || v === null) {
    return { score: 0, passed: false, details: "tool call is not an object" };
  }
  const obj = v as Record<string, unknown>;
  const name = obj.tool ?? obj.name ?? obj.function;
  const innerFn =
    typeof obj.function === "object" && obj.function !== null
      ? (obj.function as Record<string, unknown>).name
      : undefined;
  const effectiveName = name ?? innerFn;
  const args = obj.args ?? obj.parameters ?? obj.input ?? obj.arguments;
  if (
    typeof effectiveName === "string" &&
    typeof args === "object" &&
    args !== null
  ) {
    return {
      score: 1,
      passed: true,
      details: `valid tool call: name=${effectiveName}, args=${JSON.stringify(args).slice(0, 60)}`,
    };
  }
  if (typeof effectiveName === "string") {
    return {
      score: 0.5,
      passed: false,
      details: `tool name=${effectiveName} but no args/parameters object`,
    };
  }
  return {
    score: 0,
    passed: false,
    details: `tool-call object missing name/tool/function key (keys: ${Object.keys(obj).join(",")})`,
  };
}

// ---------------------------------------------------------------------------
// Sentence / length utilities (research-summarization, instruction-following)
// ---------------------------------------------------------------------------

/**
 * Count "sentences" in a response. Splits on `.!?` followed by whitespace
 * or end-of-string. Filters out empty fragments (e.g. trailing periods).
 */
export function countSentences(response: string): number {
  if (!response) return 0;
  const trimmed = response.trim();
  if (!trimmed) return 0;
  const parts = trimmed
    .split(/[.!?]+(?:\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0 && trimmed.length > 0) return 1;
  return parts.length;
}

/**
 * Count words (whitespace-separated tokens, ignoring punctuation-only tokens).
 */
export function countWords(response: string): number {
  if (!response) return 0;
  return response
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /[A-Za-z0-9]/.test(s)).length;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function msg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Loose deep-equal for grading — treats `1` and `"1"` as equal (a common
 * model output drift), and does recursive structural comparison for arrays
 * and plain objects.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  if (typeof a !== typeof b) {
    if (
      (typeof a === "number" || typeof a === "string") &&
      (typeof b === "number" || typeof b === "string")
    ) {
      return String(a) === String(b) || Number(a) === Number(b);
    }
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k]
      )
    );
  }
  return false;
}

/**
 * Strip TypeScript-specific syntax so a fenced TS code block can be evaluated
 * inside `new Function()` (which is pure JS). What gets stripped:
 *
 *   - `export` / `export default` / `default` keywords (invalid inside a
 *     function body / outside a module).
 *   - Parameter type annotations: `function f(a: number, b: string)` → `f(a, b)`.
 *   - Return type annotations: `function f(): boolean` → `function f()`.
 *   - Variable type annotations: `const x: number = 5` → `const x = 5`.
 *   - Generic type parameters: `function f<T>(...)` → `function f(...)`.
 *   - `interface`, `type`, `import`, `as` casts (line-level — removed entirely).
 *
 * Conservative: only strips what we commonly see from LLM-generated TS code.
 * Doesn't try to parse — pure regex substitution.
 */
function stripTypeScriptAnnotations(code: string): string {
  let out = code;
  // Remove `interface X { ... }` blocks.
  out = out.replace(/^\s*interface\s+\w+\s*[\{<][\s\S]*?\n\}/gm, "");
  // Remove `type X = ...;` lines.
  out = out.replace(/^\s*type\s+\w+\s*=[\s\S]*?;\s*$/gm, "");
  // Remove `import ...` lines.
  out = out.replace(/^\s*import[\s\S]*?;\s*$/gm, "");
  // Remove `export ` / `export default ` / `default ` keywords.
  out = out.replace(/\bexport\s+default\s+/g, "");
  out = out.replace(/\bexport\s+/g, "");
  // Remove generic type parameters like `<T>`, `<T, U>`, `<T extends X>`.
  out = out.replace(/function\s+(\w+)\s*<[^>]*>/g, "function $1");
  // Remove return-type annotations: `function f(...): Type {` → `function f(...) {`.
  // The pattern matches `)`, `:`, the type name, and trailing whitespace, with
  // a lookahead requiring `{` or `=` (so we don't accidentally strip ternary
  // colons in expressions). The replacement is `) ` (close-paren + space, NO
  // colon) — preserving the colon would leave a stale `:` after the param
  // list which is invalid JS.
  out = out.replace(/\)\s*:\s*[A-Za-z_][\w\[\]<>|&,\s]*\s*(?=[{=])/g, ") ");
  // Remove parameter type annotations: `: Type` after a parameter name.
  // Pattern: `(name: Type, ...)` — capture name, drop `: Type`.
  // We do this carefully to avoid stripping object-literal colons (which
  // have a value after them, not just `,` or `)`).
  out = out.replace(
    /(\b[A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_][\w\[\]<>|&.\s,]*?(?=[,)=])/g,
    "$1"
  );
  // Remove `as Type` casts.
  out = out.replace(/\s+as\s+[A-Za-z_][\w\[\]<>|&.]*/g, "");
  // Remove non-null assertion operator (`x!`).
  out = out.replace(/(\w)!/g, "$1");
  // Remove standalone angle-bracket casts: `<Type>expr`.
  out = out.replace(/<[A-Za-z_][\w\[\]<>|&.]*>\s*(?=[A-Za-z_(])/g, "");
  return out;
}
