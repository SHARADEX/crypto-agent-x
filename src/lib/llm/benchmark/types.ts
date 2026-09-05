// Benchmark suite — types (Phase-2 §7 / P2-4 / P1-7).
//
// The capability numbers in `SEED_MODELS` (src/config/providers.ts) are
// author-supplied priors, NOT measured. This suite grades each configured
// model on real tasks with DETERMINISTIC graders (spec §7: "Do NOT score
// everything through another LLM"). Every case has a known expected answer;
// the grader runs against the model's text response and returns a 0..1 score
// + pass/fail flag + human-readable detail string.
//
// All graders are PURE — no I/O, no network, no LLM judging. The runner
// (`runner.ts`) is the only file that touches the network / DB.

// ---------------------------------------------------------------------------
// Categories (spec §7 / Phase-2 §7 — task families the router scores on)
// ---------------------------------------------------------------------------

export type BenchmarkCategory =
  | "classification"
  | "reasoning"
  | "research_summarization"
  | "structured_json"
  | "coding"
  | "debugging"
  | "web3_understanding"
  | "security_analysis"
  | "tool_use"
  | "instruction_following";

export const BENCHMARK_CATEGORIES: BenchmarkCategory[] = [
  "classification",
  "reasoning",
  "research_summarization",
  "structured_json",
  "coding",
  "debugging",
  "web3_understanding",
  "security_analysis",
  "tool_use",
  "instruction_following",
];

// ---------------------------------------------------------------------------
// A single benchmark case (prompt + expected + deterministic grader)
// ---------------------------------------------------------------------------

export interface BenchmarkGrade {
  /** Score 0..1 (0 = total miss, 0.5 = partial, 1 = fully correct). */
  score: number;
  /** Did the response fully meet the bar for this case? */
  passed: boolean;
  /** Human-readable explanation (never sent to another LLM). */
  details: string;
}

export interface BenchmarkCase {
  /** Stable identifier — used as the row key in the scores table. */
  id: string;
  /** Which capability family the case exercises. */
  category: BenchmarkCategory;
  /** The full user prompt sent to the model. */
  prompt: string;
  /** The deterministic verifier checks against this (schema, answer, etc.). */
  expected: unknown;
  /** Max output tokens for this case. */
  maxTokens: number;
  /** Per-case wall-clock timeout — the runner aborts the callLLM promise. */
  timeoutMs: number;
  /**
   * The deterministic grader — pure, no I/O. Returns 0..1 + pass/fail + detail.
   * NEVER calls another LLM (spec §7).
   */
  grade: (response: string, expected: unknown) => BenchmarkGrade;
}

// ---------------------------------------------------------------------------
// A single measured result (one row per case × model run)
// ---------------------------------------------------------------------------

export interface BenchmarkResult {
  modelId: string;
  category: BenchmarkCategory;
  caseId: string;
  /** 0..1 — the graded score for this case. */
  score: number;
  passed: boolean;
  /** Wall-clock latency of the successful attempt (0 on failure). */
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  /** Human-readable grader output (NOT sent to any LLM). */
  details: string;
  /** Set when the call failed entirely (timeout, provider error, etc.). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Aggregated per-model summary (one row per model)
// ---------------------------------------------------------------------------

export interface CategoryScore {
  /** Mean score 0..1 across the cases that ran for this category. */
  score: number;
  /** Number of cases actually run (may be less than total if aborted). */
  samples: number;
  /** Fraction of cases that passed (passed / samples). */
  passRate: number;
}

export interface ModelBenchmarkSummary {
  modelId: string;
  /** Per-category mean score + sample count + pass-rate. */
  categories: Record<BenchmarkCategory, CategoryScore>;
  /** Overall score 0..10 (mean across categories × 10). */
  overallScore: number;
  /** Total number of cases run across all categories. */
  totalSamples: number;
  /** ISO timestamp of when the benchmark completed. */
  benchmarkedAt: string;
}

// ---------------------------------------------------------------------------
// Runner options
// ---------------------------------------------------------------------------

export interface RunBenchmarkOpts {
  /** Restrict the run to specific categories. Defaults to all 10. */
  categories?: BenchmarkCategory[];
  /** Cap the number of cases per category. Defaults to all. */
  casesPerCategory?: number;
  /** Override the per-case timeout (ms). Defaults to each case's timeoutMs. */
  timeoutMs?: number;
  /** Skip the callLLM budget pre-check? Defaults to false. */
  skipBudgetCheck?: boolean;
}
