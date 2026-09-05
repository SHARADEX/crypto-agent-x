// Benchmark runner (Phase-2 §7 / P2-4 / P1-7).
//
// The runner is the only file in this package that touches the network or
// the database. For every case it:
//
//   1. Calls `callLLM` with the model id + the case's prompt + (for
//      structured_json) `responseFormat: "json"`.
//   2. Applies the case's `timeoutMs` via a Promise.race against a
//      setTimeout-controlled aborter (the provider layer also has a 30s
//      cap, but benchmark cases can be shorter).
//   3. Grades the response with the case's `grade` function (deterministic
//      — never asks another LLM).
//   4. Records the outcome via `recordModelPerformance(modelId,
//      "benchmark:" + category, ...)` so the router's adaptive scorer can
//      read it back.
//   5. Logs an event `benchmark_case_complete` via `logEvent` for the
//      audit trail.
//   6. Aggregates the per-case results into a `ModelBenchmarkSummary`.
//
// The runner NEVER throws — a failing case is a `BenchmarkResult` with
// `error`, not a crash. A whole-model failure (provider unreachable,
// circuit breaker open) is a summary with zero-sample categories.

import { callLLM } from "@/lib/llm/provider";
import type { CallLLMResult } from "@/lib/llm/provider";
import {
  getModels,
  getModel,
  recordModelPerformance,
  getModelPerformance,
} from "@/lib/llm/registry";
import type { ModelRecord } from "@/lib/agent/types";
import { logEvent } from "@/lib/agent/events";
import { db } from "@/lib/db";

import {
  BENCHMARK_CATEGORIES,
  type BenchmarkCase,
  type BenchmarkCategory,
  type BenchmarkResult,
  type CategoryScore,
  type ModelBenchmarkSummary,
  type RunBenchmarkOpts,
} from "./types";
import { BENCHMARK_CASES } from "./cases";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the benchmark suite for a single model. Iterates every case in every
 * category (or a subset if `opts.categories` is set). NEVER throws.
 *
 * Side effects:
 *   - Calls `callLLM` for each case (consumes budget).
 *   - Writes a `ModelPerformance` row per category (taskType =
 *     `benchmark:<category>`) via `recordModelPerformance`.
 *   - Writes a `model_router` event log row per case.
 *
 * @returns the per-case results + an aggregated `ModelBenchmarkSummary`.
 */
export async function runBenchmarkForModel(
  modelId: string,
  opts: RunBenchmarkOpts = {}
): Promise<{
  results: BenchmarkResult[];
  summary: ModelBenchmarkSummary;
}> {
  const results: BenchmarkResult[] = [];
  const empty: ModelBenchmarkSummary = emptySummary(modelId);

  if (!modelId) {
    return { results, summary: empty };
  }

  // Verify the model exists in the registry. If not, return early with an
  // empty summary — the benchmark can't run on a non-existent model.
  let model: ModelRecord | null = null;
  try {
    model = await getModel(modelId);
  } catch (err) {
    console.error(
      `[benchmark] getModel(${modelId}) threw:`,
      err instanceof Error ? err.message : err
    );
  }
  if (!model) {
    return { results, summary: empty };
  }

  // Filter + cap the case set.
  const cats = opts.categories ?? BENCHMARK_CATEGORIES;
  const cap = opts.casesPerCategory ?? Number.MAX_SAFE_INTEGER;
  const filtered = BENCHMARK_CASES.filter(
    (c) => cats.includes(c.category)
  ).reduce<Record<string, BenchmarkCase[]>>((acc, c) => {
    const list = acc[c.category] ?? [];
    if (list.length < cap) list.push(c);
    acc[c.category] = list;
    return acc;
  }, {});
  const cases: BenchmarkCase[] = Object.values(filtered).flat();

  // Run each case. Sequential — parallel would skew latency measurements
  // and risk hammering the provider's rate limit.
  for (const c of cases) {
    const result = await runOneCase(modelId, c, opts.timeoutMs ?? c.timeoutMs);
    results.push(result);

    // Record the outcome to ModelPerformance so the router's adaptive
    // scorer can read it back. Task type is tagged `benchmark:<category>`.
    try {
      const qualityScore = result.score * 10; // 0..10
      await recordModelPerformance(
        modelId,
        `benchmark:${c.category}`,
        result.passed,
        result.latencyMs,
        result.promptTokens + result.completionTokens,
        qualityScore
      );
    } catch (err) {
      // Recording is best-effort; a DB error here should NOT crash the
      // rest of the benchmark.
      console.error(
        `[benchmark] recordModelPerformance failed for ${modelId}/${c.id}:`,
        err instanceof Error ? err.message : err
      );
    }

    // Audit-trail event log.
    try {
      await logEvent(
        "model_router",
        result.passed ? "info" : "warn",
        "benchmark_case_complete",
        {
          modelId,
          caseId: c.id,
          category: c.category,
          score: result.score,
          passed: result.passed,
          latencyMs: result.latencyMs,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          details: result.details.slice(0, 200),
          error: result.error,
        },
        {}
      );
    } catch (err) {
      console.error(
        `[benchmark] logEvent failed for ${modelId}/${c.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  const summary = aggregateSummary(modelId, results);
  return { results, summary };
}

/**
 * Run the benchmark for every enabled model in the registry. Returns one
 * summary per model (in registry order). NEVER throws — a single model
 * failure is a zero-sample summary, not a crash.
 */
export async function runBenchmarkForAllModels(
  opts: RunBenchmarkOpts = {}
): Promise<ModelBenchmarkSummary[]> {
  let models: ModelRecord[] = [];
  try {
    models = await getModels({ enabled: true });
  } catch (err) {
    console.error(
      "[benchmark] getModels threw:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
  const summaries: ModelBenchmarkSummary[] = [];
  for (const m of models) {
    try {
      const { summary } = await runBenchmarkForModel(m.model_id, opts);
      summaries.push(summary);
    } catch (err) {
      // Shouldn't happen — runBenchmarkForModel doesn't throw — but guard
      // against a stray throw so one bad model doesn't kill the whole run.
      console.error(
        `[benchmark] runBenchmarkForModel(${m.model_id}) threw:`,
        err instanceof Error ? err.message : err
      );
      summaries.push(emptySummary(m.model_id));
    }
  }
  return summaries;
}

/**
 * Read the persisted `ModelPerformance` rows for a model and aggregate the
 * `benchmark:*` task types into a summary. Used by the dashboard / CLI to
 * show the LAST measured capabilities without re-running the benchmark.
 */
export async function getBenchmarkSummary(
  modelId: string
): Promise<ModelBenchmarkSummary> {
  const empty = emptySummary(modelId);
  if (!modelId) return empty;

  let rows: Awaited<ReturnType<typeof getModelPerformance>> = [];
  try {
    rows = await getModelPerformance(modelId);
  } catch (err) {
    console.error(
      `[benchmark] getModelPerformance(${modelId}) threw:`,
      err instanceof Error ? err.message : err
    );
    return empty;
  }

  const byCat: Record<BenchmarkCategory, CategoryScore> = emptyCategories();
  let totalSamples = 0;
  for (const row of rows) {
    if (!row.taskType.startsWith("benchmark:")) continue;
    const cat = row.taskType.slice("benchmark:".length) as BenchmarkCategory;
    if (!BENCHMARK_CATEGORIES.includes(cat)) continue;
    const entry = byCat[cat];
    // The ModelPerformance table records the cumulative attempts/successes
    // + an EMA of the quality score (0..10). Convert to 0..1.
    const score = row.avg_quality / 10;
    entry.samples += row.attempts;
    entry.passRate =
      row.attempts > 0 ? row.successes / row.attempts : entry.passRate;
    entry.score = row.attempts > 0 ? score : entry.score;
    totalSamples += row.attempts;
  }

  const overall = computeOverall(byCat);
  return {
    modelId,
    categories: byCat,
    overallScore: overall,
    totalSamples,
    benchmarkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Persist measured scores back into the model's capabilitiesJson
// ---------------------------------------------------------------------------

/**
 * Persist the measured benchmark scores back into the model's
 * `capabilitiesJson` in the DB. The existing author-supplied `capabilities`
 * block (the prior) is preserved as-is; the measured scores are written
 * under a sibling `benchmark_score` key so the two can be compared
 * (spec §7: "Do NOT score everything through another LLM" — the measured
 * block is the source of truth, the prior is the author estimate).
 *
 * NEVER throws — best-effort write.
 */
export async function persistBenchmarkScores(
  modelId: string,
  summary: ModelBenchmarkSummary
): Promise<boolean> {
  if (!modelId) return false;
  try {
    const row = await db.modelRecord.findUnique({
      where: { modelId },
      select: { capabilitiesJson: true },
    });
    if (!row) return false;
    const prior = safeParse(row.capabilitiesJson, {});
    const measured: Record<string, number> = {};
    for (const cat of BENCHMARK_CATEGORIES) {
      measured[cat] = Math.round(summary.categories[cat].score * 10) / 10;
    }
    const next = {
      ...prior,
      // Clear tag: these are MEASURED benchmark scores (0..10), NOT the
      // author-supplied priors in `prior.*`.
      benchmark_score: measured,
      benchmark_overall: Math.round(summary.overallScore * 10) / 10,
      benchmark_samples: summary.totalSamples,
      benchmarked_at: summary.benchmarkedAt,
    };
    await db.modelRecord.update({
      where: { modelId },
      data: { capabilitiesJson: JSON.stringify(next) },
    });
    return true;
  } catch (err) {
    console.error(
      `[benchmark] persistBenchmarkScores(${modelId}) failed:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function runOneCase(
  modelId: string,
  c: BenchmarkCase,
  timeoutMs: number
): Promise<BenchmarkResult> {
  const startedAt = Date.now();
  const base: BenchmarkResult = {
    modelId,
    category: c.category,
    caseId: c.id,
    score: 0,
    passed: false,
    latencyMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    details: "",
  };

  // Race the callLLM promise against a setTimeout aborter.
  let llm: CallLLMResult | null = null;
  let timedOut = false;
  try {
    llm = await Promise.race<Promise<CallLLMResult>>([
      callLLM({
        modelId,
        messages: [{ role: "user", content: c.prompt }],
        maxTokens: c.maxTokens,
        responseFormat: c.category === "structured_json" ? "json" : "text",
        taskType: `benchmark:${c.category}`,
        temperature: 0.2, // deterministic-ish — minimize creative drift
        estimatedTokens: c.maxTokens + 500,
      }),
      new Promise<CallLLMResult>((resolve) => {
        setTimeout(
          () => {
            timedOut = true;
            resolve({
              success: false,
              content: "",
              usage: { promptTokens: 0, completionTokens: 0 },
              latencyMs: timeoutMs,
              model: modelId,
              provider: "zai",
              retries: 0,
              error: `benchmark timeout (${timeoutMs}ms)`,
            } as CallLLMResult);
          },
          timeoutMs
        );
      }),
    ]);
  } catch (err) {
    return {
      ...base,
      latencyMs: Date.now() - startedAt,
      error: `callLLM threw: ${err instanceof Error ? err.message : String(err)}`,
      details: "callLLM threw before grading",
    };
  }

  if (!llm) {
    return {
      ...base,
      latencyMs: Date.now() - startedAt,
      error: "callLLM returned null",
      details: "no LLM result",
    };
  }

  const latencyMs = llm.latencyMs || Date.now() - startedAt;
  const promptTokens = llm.usage?.promptTokens ?? 0;
  const completionTokens = llm.usage?.completionTokens ?? 0;

  if (!llm.success) {
    return {
      ...base,
      latencyMs,
      promptTokens,
      completionTokens,
      error: llm.error ?? (timedOut ? "timeout" : "callLLM failed"),
      details: `callLLM failure: ${llm.error ?? "unknown"}`,
    };
  }

  // Grade the response — never throws (the grader is pure + defensive).
  try {
    const grade = c.grade(llm.content, c.expected);
    return {
      ...base,
      score: Math.max(0, Math.min(1, grade.score)),
      passed: !!grade.passed,
      latencyMs,
      promptTokens,
      completionTokens,
      details: grade.details.slice(0, 500),
    };
  } catch (err) {
    return {
      ...base,
      latencyMs,
      promptTokens,
      completionTokens,
      error: `grader threw: ${err instanceof Error ? err.message : String(err)}`,
      details: "grader exception — response not graded",
    };
  }
}

function emptyCategories(): Record<BenchmarkCategory, CategoryScore> {
  const out = {} as Record<BenchmarkCategory, CategoryScore>;
  for (const c of BENCHMARK_CATEGORIES) {
    out[c] = { score: 0, samples: 0, passRate: 0 };
  }
  return out;
}

function emptySummary(modelId: string): ModelBenchmarkSummary {
  return {
    modelId,
    categories: emptyCategories(),
    overallScore: 0,
    totalSamples: 0,
    benchmarkedAt: new Date().toISOString(),
  };
}

function aggregateSummary(
  modelId: string,
  results: BenchmarkResult[]
): ModelBenchmarkSummary {
  const byCat = emptyCategories();
  for (const r of results) {
    const entry = byCat[r.category];
    if (!entry) continue;
    // Accumulate the sum; compute the mean at the end.
    entry.score = (entry.score * entry.samples + r.score) / (entry.samples + 1);
    entry.samples += 1;
    entry.passRate = (entry.passRate * (entry.samples - 1) + (r.passed ? 1 : 0)) / entry.samples;
  }
  // Fix floating-point drift in passRate (after the rolling-mean above).
  for (const c of BENCHMARK_CATEGORIES) {
    byCat[c].score = Math.round(byCat[c].score * 1000) / 1000;
    byCat[c].passRate = Math.round(byCat[c].passRate * 1000) / 1000;
  }
  return {
    modelId,
    categories: byCat,
    overallScore: computeOverall(byCat),
    totalSamples: results.length,
    benchmarkedAt: new Date().toISOString(),
  };
}

function computeOverall(
  byCat: Record<BenchmarkCategory, CategoryScore>
): number {
  // Mean of the per-category scores that have at least one sample,
  // scaled to 0..10. Categories with zero samples are excluded.
  const sampled = BENCHMARK_CATEGORIES.filter((c) => byCat[c].samples > 0);
  if (sampled.length === 0) return 0;
  const sum = sampled.reduce((s, c) => s + byCat[c].score, 0);
  return Math.round((sum / sampled.length) * 10 * 10) / 10;
}

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
