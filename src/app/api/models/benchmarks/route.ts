// GET /api/models/benchmarks
//
// Phase-2 P2-20 §36 / P2-4: dashboard "Benchmark Results" table endpoint.
//
// Aggregates `ModelPerformance` rows where `taskType LIKE 'benchmark:%'` into
// a per-model summary that the dashboard can render as a model × category
// matrix with the measured scores (NOT the seed/author estimates stored in
// `ModelRecord.capabilitiesJson`).
//
// Each entry carries:
//   - modelId
//   - categories: { [category]: { score, samples, passRate } }
//   - overallScore (0..10 — mean across categories that have at least 1 sample)
//   - totalSamples
//   - benchmarkedAt (most-recent updatedAt among the model's benchmark rows)

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bootstrapAgent } from "@/lib/orchestrator/bootstrap";
import {
  BENCHMARK_CATEGORIES,
  type BenchmarkCategory,
  type CategoryScore,
  type ModelBenchmarkSummary,
} from "@/lib/llm/benchmark";

export const dynamic = "force-dynamic";

const BENCHMARK_PREFIX = "benchmark:";

export interface BenchmarkTableResponse {
  benchmarks: ModelBenchmarkSummary[];
  categories: BenchmarkCategory[];
  count: number;
}

export async function GET() {
  try {
    await bootstrapAgent();

    const rows = await db.modelPerformance.findMany({
      where: { taskType: { startsWith: BENCHMARK_PREFIX } },
      orderBy: [{ modelId: "asc" }, { taskType: "asc" }],
    });

    // Group by modelId and aggregate per-category.
    const byModel = new Map<
      string,
      { categories: Record<BenchmarkCategory, CategoryScore>; latestAt: number }
    >();

    for (const row of rows) {
      const cat = row.taskType.slice(BENCHMARK_PREFIX.length) as BenchmarkCategory;
      if (!BENCHMARK_CATEGORIES.includes(cat)) continue;
      let bucket = byModel.get(row.modelId);
      if (!bucket) {
        const cats = {} as Record<BenchmarkCategory, CategoryScore>;
        for (const c of BENCHMARK_CATEGORIES) {
          cats[c] = { score: 0, samples: 0, passRate: 0 };
        }
        bucket = { categories: cats, latestAt: 0 };
        byModel.set(row.modelId, bucket);
      }
      const entry = bucket.categories[cat];
      // ModelPerformance stores avg_quality on a 0..10 scale; convert to 0..1
      // for the public benchmark-summary shape.
      const score = (row.avgQuality ?? 0) / 10;
      // When we have multiple runs per (model, category) — we don't today
      // because of the EMA-style update in recordModelPerformance — we take
      // the latest score. attempts is cumulative; we use it as the sample
      // count so the dashboard's "confidence" badge reflects total samples.
      entry.samples += row.attempts;
      entry.passRate =
        row.attempts > 0 ? row.successes / row.attempts : entry.passRate;
      entry.score = row.attempts > 0 ? score : entry.score;
      const ts = row.updatedAt ? Date.parse(row.updatedAt.toISOString()) : 0;
      if (Number.isFinite(ts) && ts > bucket.latestAt) {
        bucket.latestAt = ts;
      }
    }

    const summaries: ModelBenchmarkSummary[] = [];
    for (const [modelId, bucket] of byModel.entries()) {
      const sampled = BENCHMARK_CATEGORIES.filter(
        (c) => bucket.categories[c].samples > 0
      );
      const totalSamples = sampled.reduce(
        (sum, c) => sum + bucket.categories[c].samples,
        0
      );
      const overall =
        sampled.length === 0
          ? 0
          : Math.round(
              (sampled.reduce((s, c) => s + bucket.categories[c].score, 0) /
                sampled.length) *
                10 *
                10
            ) / 10;
      summaries.push({
        modelId,
        categories: bucket.categories,
        overallScore: overall,
        totalSamples,
        benchmarkedAt: bucket.latestAt
          ? new Date(bucket.latestAt).toISOString()
          : new Date(0).toISOString(),
      });
    }

    return NextResponse.json(
      {
        benchmarks: summaries,
        categories: BENCHMARK_CATEGORIES,
        count: summaries.length,
      } as BenchmarkTableResponse,
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/models/benchmarks GET] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
