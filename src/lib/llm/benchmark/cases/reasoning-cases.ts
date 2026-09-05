// Benchmark cases — reasoning (Phase-2 §7 / P2-4 / P1-7).
//
// Each case is a logic puzzle with a known deterministic answer. The grader
// extracts the answer (regex for "Answer:" lines) and compares it. NO LLM
// judging — the answer is computed independently of the model.

import type { BenchmarkCase } from "../types";
import { extractNumber, gradeKeyword } from "../grader";

export const reasoningCases: BenchmarkCase[] = [
  {
    id: "reason-fox-goose-grain-v1",
    category: "reasoning",
    prompt:
      `A farmer must cross a river with a fox, a goose, and a bag of grain. The\n` +
      `boat can carry only the farmer and one item at a time. The fox will eat the\n` +
      `goose if left alone; the goose will eat the grain if left alone. What is the\n` +
      `MINIMUM number of one-way crossings the farmer must make to get everything\n` +
      `across safely?\n\n` +
      `Think step by step. Then end your response with a line that reads exactly:\n` +
      `Answer: <number>`,
    expected: 7,
    maxTokens: 800,
    timeoutMs: 45_000,
    grade: (response, expected) => {
      const got = extractNumber(response);
      const want = expected as number;
      if (!Number.isFinite(got)) {
        return {
          score: 0,
          passed: false,
          details: `no numeric answer extracted (expected ${want})`,
        };
      }
      if (got === want) {
        return {
          score: 1,
          passed: true,
          details: `correct: ${got} crossings`,
        };
      }
      return {
        score: 0,
        passed: false,
        details: `wrong: got ${got}, expected ${want}`,
      };
    },
  },
  {
    id: "reason-meeting-overlap-v1",
    category: "reasoning",
    prompt:
      `Alice has a meeting 9:00-10:30. Bob has a meeting 10:00-11:00. They want to\n` +
      `meet for 30 minutes today. What is the LATEST possible start time for their\n` +
      `meeting (24-hour clock, HH:MM)? They cannot meet during either meeting.\n\n` +
      `Show your reasoning, then end with a line that reads exactly:\n` +
      `Answer: HH:MM`,
    expected: { keywords: ["11:00"] },
    maxTokens: 600,
    timeoutMs: 45_000,
    grade: (response, expected) =>
      gradeKeyword(
        response,
        expected as { keywords: string[]; requireAll?: boolean }
      ),
  },
  {
    id: "reason-age-riddle-v1",
    category: "reasoning",
    prompt:
      `Tom is twice as old as Jerry was when Tom was as old as Jerry is now. The\n` +
      `sum of their current ages is 63. How old is Tom now?\n\n` +
      `Think step by step, then end with a line that reads exactly:\n` +
      `Answer: <number>`,
    expected: 36,
    maxTokens: 800,
    timeoutMs: 45_000,
    grade: (response, expected) => {
      const got = extractNumber(response);
      const want = expected as number;
      if (!Number.isFinite(got)) {
        return {
          score: 0,
          passed: false,
          details: `no numeric answer extracted (expected ${want})`,
        };
      }
      if (got === want) {
        return {
          score: 1,
          passed: true,
          details: `correct: Tom is ${got}`,
        };
      }
      return {
        score: 0,
        passed: false,
        details: `wrong: got ${got}, expected ${want}`,
      };
    },
  },
  {
    id: "reason-coin-weigh-v1",
    category: "reasoning",
    prompt:
      `You have 9 coins, one of which is counterfeit and slightly lighter than the\n` +
      `others (which all weigh the same). You have a balance scale. What is the\n` +
      `MINIMUM number of weighings needed to identify the counterfeit coin?\n\n` +
      `Think step by step, then end with a line that reads exactly:\n` +
      `Answer: <number>`,
    expected: 2,
    maxTokens: 600,
    timeoutMs: 45_000,
    grade: (response, expected) => {
      const got = extractNumber(response);
      const want = expected as number;
      if (!Number.isFinite(got)) {
        return {
          score: 0,
          passed: false,
          details: `no numeric answer extracted (expected ${want})`,
        };
      }
      if (got === want) {
        return {
          score: 1,
          passed: true,
          details: `correct: ${got} weighings`,
        };
      }
      return {
        score: 0,
        passed: false,
        details: `wrong: got ${got}, expected ${want}`,
      };
    },
  },
];
