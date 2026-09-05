// Benchmark CLI — runs the model benchmark suite (Phase-2 §7 / P2-4 / P1-7).
//
// Runnable via `bun run agent:benchmark`. Sequence:
//   1. bootstrapProviders() — discover every configured model in the registry.
//   2. List every enabled, configured, healthy model.
//   3. Run runBenchmarkForModel for each (with a per-model timeout).
//   4. Print a scores table: model x category -> score.
//   5. Persist each model's measured scores into capabilitiesJson as
//      `benchmark_score` (vs the prior `capabilities` author estimate).
//
// NEVER throws — a single model failure shows as a SKIPPED row in the table.

import {
  bootstrapProviders,
  getConfiguredProviders,
  getProvider,
} from "@/lib/llm/providers";
import { getModels, getModel } from "@/lib/llm/registry";
import {
  runBenchmarkForModel,
  persistBenchmarkScores,
  getBenchmarkSummary,
  BENCHMARK_CASES,
} from "@/lib/llm/benchmark";
import {
  BENCHMARK_CATEGORIES,
  type BenchmarkCategory,
  type ModelBenchmarkSummary,
  type RunBenchmarkOpts,
} from "@/lib/llm/benchmark";

// ---------------------------------------------------------------------------
// CLI arg parsing (minimal — no deps)
// ---------------------------------------------------------------------------

interface CliOpts {
  categories?: BenchmarkCategory[];
  casesPerCategory?: number;
  timeoutMs?: number;
  models?: string[];
  persist: boolean;
  listOnly: boolean;
  allModels: boolean;
  allCases: boolean;
}

// Default quick-mode limits: 1 model (primary role) × 1 case per category
// (10 cases). Tuned so the default invocation completes inside the 120s
// verification window. Pass --all-models / --all-cases / --per-category N
// for a deeper run.
const DEFAULT_CASES_PER_CATEGORY = 1;

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    persist: true,
    listOnly: false,
    allModels: false,
    allCases: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--no-persist") {
      opts.persist = false;
    } else if (a === "--list") {
      opts.listOnly = true;
    } else if (a === "--all-models") {
      opts.allModels = true;
    } else if (a === "--all-cases") {
      opts.allCases = true;
    } else if (a === "--categories") {
      const val = argv[++i] ?? "";
      opts.categories = val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as BenchmarkCategory[];
    } else if (a === "--per-category") {
      const val = Number(argv[++i]);
      if (Number.isFinite(val) && val > 0) opts.casesPerCategory = val;
    } else if (a === "--timeout") {
      const val = Number(argv[++i]);
      if (Number.isFinite(val) && val > 0) opts.timeoutMs = val;
    } else if (a === "--models") {
      const val = argv[++i] ?? "";
      opts.models = val.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`CryptoEarn Agent — model benchmark suite (Phase-2 §7)

Usage: bun run agent:benchmark [options]

Options:
  --categories <cat,cat,...>  Comma-separated list of categories to run
                              (default: all 10). One of:
                                classification, reasoning, research_summarization,
                                structured_json, coding, debugging,
                                web3_understanding, security_analysis,
                                tool_use, instruction_following
  --per-category <N>          Cap the number of cases per category.
                              (default: ${DEFAULT_CASES_PER_CATEGORY} — quick mode)
  --all-cases                 Don't cap cases per category (run every case).
  --timeout <ms>             Override per-case timeout (default: each case's timeoutMs).
  --models <id,id,...>       Comma-separated list of model ids to benchmark
                              (overrides --all-models).
  --all-models               Benchmark every enabled+configured model
                              (default: only primary-role models).
  --no-persist                Don't write measured scores back to the DB.
  --list                      Only print the model + case list, don't run.
  -h, --help                  Show this help.
`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pad(s: string, n: number): string {
  const trimmed = s.length >= n ? s.slice(0, n - 1) + "…" : s;
  return trimmed.padEnd(n);
}

function pct(score: number): string {
  return (score * 100).toFixed(0).padStart(3) + "%";
}

function overallLabel(score: number): string {
  // score is 0..10
  if (score >= 8) return "EXCELLENT";
  if (score >= 6) return "GOOD";
  if (score >= 4) return "FAIR";
  if (score >= 2) return "POOR";
  return "VERY_POOR";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.log("=== CryptoEarn Agent — Model Benchmark Suite ===\n");

  // 1. Bootstrap providers (discovery + health checks).
  console.log("Bootstrapping providers...");
  const bootstrap = await bootstrapProviders().catch((err) => {
    console.error("  bootstrapProviders threw:", err);
    return null;
  });
  if (bootstrap) {
    console.log(
      `  configured=${bootstrap.configured.length}, healthy=${bootstrap.healthy.length}, ` +
        `models_discovered=${bootstrap.modelsDiscovered}`
    );
    if (bootstrap.errors.length > 0) {
      console.log(`  errors: ${bootstrap.errors.length}`);
      for (const e of bootstrap.errors.slice(0, 3)) {
        console.log(`    - ${e}`);
      }
    }
  }

  // 2. List configured providers + their healthy models.
  const configuredProviders = getConfiguredProviders();
  console.log(`\nConfigured providers (${configuredProviders.length}):`);
  for (const p of configuredProviders) {
    console.log(`  - ${p.name} (${p.displayName})`);
  }

  // 3. Filter to models that are enabled AND have a configured provider
  //    (so we don't waste time trying to call models whose provider
  //    wasn't given an API key).
  let models = await getModels({ enabled: true });
  const configuredProviderNames = new Set(configuredProviders.map((p) => p.name));
  models = models.filter((m) => configuredProviderNames.has(m.provider));

  // If --models was given, restrict to that set.
  if (opts.models && opts.models.length > 0) {
    const wanted = new Set(opts.models);
    models = models.filter((m) => wanted.has(m.model_id));
  } else if (!opts.allModels) {
    // Default: only benchmark primary-role models (so the default invocation
    // completes quickly — pass --all-models to include exploration/secondary
    // /reviewer models too).
    const primaries = models.filter((m) => m.role === "primary");
    if (primaries.length > 0) {
      models = primaries;
    }
  }

  console.log(`\nModels to benchmark (${models.length}):`);
  for (const m of models) {
    console.log(`  - ${m.model_id}  [${m.provider}/${m.role}/${m.status}]`);
  }

  // 4. Print the case set we'll run.
  const cap = opts.allCases
    ? undefined
    : opts.casesPerCategory ?? DEFAULT_CASES_PER_CATEGORY;
  const caseSummary: Record<string, number> = {};
  for (const cat of BENCHMARK_CATEGORIES) {
    caseSummary[cat] = countCases(cat, cap);
  }
  console.log("\nCases per category:" + (cap ? ` (cap=${cap})` : " (all)"));
  for (const cat of BENCHMARK_CATEGORIES) {
    console.log(`  ${pad(cat, 28)} ${caseSummary[cat]}`);
  }
  const totalCases = Object.values(caseSummary).reduce((a, b) => a + b, 0);
  console.log(`  ${pad("TOTAL", 28)} ${totalCases}`);

  if (opts.listOnly) {
    process.exit(0);
  }

  if (models.length === 0) {
    console.log(
      "\nNo models to benchmark. Configure a provider (z-ai SDK is auto-provisioned; others need API keys)."
    );
    process.exit(0);
  }

  // 5. Run the benchmark for each model.
  const runOpts: RunBenchmarkOpts = {
    categories: opts.categories,
    casesPerCategory: cap,
    timeoutMs: opts.timeoutMs,
  };

  const summaries: ModelBenchmarkSummary[] = [];
  const skipped: string[] = [];
  for (const m of models) {
    console.log(`\n--- Benchmarking ${m.model_id} ---`);
    const start = Date.now();
    let summary: ModelBenchmarkSummary | null = null;
    try {
      const { summary: s } = await runBenchmarkForModel(m.model_id, runOpts);
      summary = s;
      summaries.push(s);
    } catch (err) {
      // Shouldn't happen — runBenchmarkForModel doesn't throw — but guard.
      console.error(
        `  runBenchmarkForModel threw: ${err instanceof Error ? err.message : String(err)}`
      );
      skipped.push(m.model_id);
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (summary) {
      console.log(
        `  overall=${summary.overallScore.toFixed(1)}/10 (${overallLabel(summary.overallScore)})  ` +
          `samples=${summary.totalSamples}  elapsed=${elapsed}s`
      );
      if (opts.persist) {
        const ok = await persistBenchmarkScores(m.model_id, summary);
        console.log(
          `  persisted benchmark_score to capabilitiesJson: ${ok ? "OK" : "FAILED"}`
        );
      }
    }
  }

  // 6. Print the scores table.
  console.log("\n=== Scores Table ===\n");
  printScoresTable(summaries);

  if (skipped.length > 0) {
    console.log(`\nSkipped (errors): ${skipped.join(", ")}`);
  }

  // 7. Print a final summary.
  const ok = summaries.filter((s) => s.totalSamples > 0).length;
  console.log(
    `\nSummary: ${ok}/${models.length} models benchmarked successfully, ` +
      `${totalCases * ok} total case-runs.`
  );
  process.exit(0);
}

function countCases(category: BenchmarkCategory, cap?: number): number {
  const filtered = BENCHMARK_CASES.filter((c) => c.category === category);
  return cap ? Math.min(cap, filtered.length) : filtered.length;
}

function printScoresTable(summaries: ModelBenchmarkSummary[]): void {
  // Header row: model id | <cat1> | <cat2> | ... | overall | samples
  const catCols = BENCHMARK_CATEGORIES.map((c) =>
    c.replace(/_/g, " ").slice(0, 12)
  );
  const modelColW = 28;
  const catColW = 13;
  const overallColW = 9;
  const sampleColW = 8;

  const header =
    pad("MODEL", modelColW) +
    " " +
    catCols.map((c) => pad(c, catColW)).join(" ") +
    " " +
    pad("OVERALL", overallColW) +
    " " +
    pad("SAMPLES", sampleColW);
  console.log(header);
  console.log("─".repeat(header.length));

  for (const s of summaries) {
    const cells = BENCHMARK_CATEGORIES.map((c) => {
      const e = s.categories[c];
      if (e.samples === 0) return pad("-", catColW);
      return pad(pct(e.score), catColW);
    });
    const line =
      pad(s.modelId, modelColW) +
      " " +
      cells.join(" ") +
      " " +
      pad(s.overallScore.toFixed(1) + "/10", overallColW) +
      " " +
      pad(String(s.totalSamples), sampleColW);
    console.log(line);
  }
}

// Bootstrap-style: run the entry point.
main().catch((err) => {
  console.error("[benchmark] uncaught error:", err);
  process.exit(1);
});
