// Benchmark cases — package index. Re-exports every case list + the flat
// BENCHMARK_CASES array.

import { jsonCases } from "./json-cases";
import { codingCases } from "./coding-cases";
import { arithmeticCases } from "./arithmetic-cases";
import { reasoningCases } from "./reasoning-cases";
import { classificationCases } from "./classification-cases";
import { instructionFollowingCases } from "./instruction-following-cases";
import { securityCases } from "./security-cases";
import { web3Cases } from "./web3-cases";
import { researchSummarizationCases } from "./research-summarization-cases";
import { debuggingCases } from "./debugging-cases";
import { toolUseCases } from "./tool-use-cases";
import type { BenchmarkCase } from "../types";

export const BENCHMARK_CASES: BenchmarkCase[] = [
  ...jsonCases,
  ...codingCases,
  ...arithmeticCases,
  ...reasoningCases,
  ...classificationCases,
  ...instructionFollowingCases,
  ...securityCases,
  ...web3Cases,
  ...researchSummarizationCases,
  ...debuggingCases,
  ...toolUseCases,
];

export {
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
};
