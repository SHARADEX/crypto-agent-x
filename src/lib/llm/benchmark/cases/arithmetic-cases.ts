// Benchmark cases — arithmetic (Phase-2 §7 / P2-4 / P1-7).
//
// Each case prompts the model to compute an arithmetic expression and emit
// the answer. The grader extracts the numeric value from the response and
// compares to the deterministic answer (with a small tolerance for floating
// drift). NOTE: arithmetic is a separate family from "reasoning" — these are
// pure computation, no logic chain.

import type { BenchmarkCase } from "../types";
import { gradeNumber } from "../grader";

export const arithmeticCases: BenchmarkCase[] = [
  {
    id: "arith-multiply-add-v1",
    category: "reasoning",
    prompt:
      `Compute the value of: 123 * 456 + 789.\n` +
      `Show your reasoning briefly, then end with a line that reads exactly:\n` +
      `Answer: <number>`,
    expected: 56877,
    maxTokens: 400,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeNumber(response, expected as number),
  },
  {
    id: "arith-large-multiplication-v1",
    category: "reasoning",
    prompt:
      `Compute 1234 * 5678 by hand. Show your steps briefly, then end with a\n` +
      `line that reads exactly:\n` +
      `Answer: <number>`,
    expected: 7006652,
    maxTokens: 600,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeNumber(response, expected as number),
  },
  {
    id: "arith-modulo-v1",
    category: "reasoning",
    prompt:
      `Compute 7^4 mod 11 (7 to the 4th power, modulo 11).\n` +
      `Show your steps, then end with a line that reads exactly:\n` +
      `Answer: <number>`,
    expected: 3,
    maxTokens: 400,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeNumber(response, expected as number),
  },
  {
    id: "arith-percentage-v1",
    category: "reasoning",
    prompt:
      `What is 17.5% of 240? Show your steps, then end with a line that reads\n` +
      `exactly:\n` +
      `Answer: <number>`,
    expected: 42,
    maxTokens: 400,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeNumber(response, expected as number),
  },
];
