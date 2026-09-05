// Benchmark suite — package index (Phase-2 §7 / P2-4 / P1-7).
//
// Re-exports the public types, the deterministic graders, the runner, and the
// flat `BENCHMARK_CASES` array (every case from every category file).

export * from "./types";
export * from "./grader";
export {
  runBenchmarkForModel,
  runBenchmarkForAllModels,
  getBenchmarkSummary,
  persistBenchmarkScores,
} from "./runner";

// The flat list of every case + per-category slices.
export {
  BENCHMARK_CASES,
  jsonCases,
  codingCases,
  arithmeticCases,
  reasoningCases,
  classificationCases,
  instructionFollowingCases,
  securityCases,
  web3Cases,
  researchSummarizationCases,
  debuggingCases,
  toolUseCases,
} from "./cases";
