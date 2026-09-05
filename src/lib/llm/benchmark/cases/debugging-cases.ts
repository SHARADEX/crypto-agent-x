// Benchmark cases — debugging (Phase-2 §7 / P2-4 / P1-7).
//
// Each case shows buggy code and asks the model to identify the bug. The
// grader checks whether the response mentions the specific bug keyword
// (case-insensitive). NO LLM judging — pure keyword match.

import type { BenchmarkCase } from "../types";
import { gradeKeyword } from "../grader";

export const debuggingCases: BenchmarkCase[] = [
  {
    id: "debug-off-by-one-v1",
    category: "debugging",
    prompt:
      `The following function is supposed to return the sum of integers from\n` +
      `1 to n inclusive. But it returns the wrong result for n=5 (expected 15,\n` +
      `got 10). What is the bug?\n\n` +
      "function sumTo(n) {\n" +
      "  let total = 0;\n" +
      "  for (let i = 1; i < n; i++) {\n" +
      "    total += i;\n" +
      "  }\n" +
      "  return total;\n" +
      "}\n\n" +
      `End your response with a line that reads exactly:\n` +
      `Bug: <bug-description>`,
    expected: {
      keywords: ["off-by-one", "off by one", "<=", "less than or equal", "< n", "i <= n", "less-than-or-equal"],
    },
    maxTokens: 400,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeKeyword(
        response,
        expected as { keywords: string[]; requireAll?: boolean }
      ),
  },
  {
    id: "debug-null-pointer-v1",
    category: "debugging",
    prompt:
      `The following code crashes with a TypeError: Cannot read property 'name'\n` +
      `of null. What kind of bug is this?\n\n` +
      "function printUser(user) {\n" +
      "  console.log(user.name);\n" +
      "}\n" +
      "printUser(null);\n\n" +
      `End your response with a line that reads exactly:\n` +
      `Bug: <bug-description>`,
    expected: {
      keywords: ["null", "undefined", "null pointer", "null reference", "typeerror"],
    },
    maxTokens: 300,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeKeyword(
        response,
        expected as { keywords: string[]; requireAll?: boolean }
      ),
  },
  {
    id: "debug-integer-overflow-v1",
    category: "debugging",
    prompt:
      `In Solidity, this code works for small numbers but fails (reverts) when\n` +
      `multiplying two large numbers like 1e18 * 1e18. What is the bug?\n\n` +
      "function multiply(uint a, uint b) public pure returns (uint) {\n" +
      "  return a * b;\n" +
      "}\n\n" +
      `End your response with a line that reads exactly:\n` +
      `Bug: <bug-description>`,
    expected: {
      keywords: ["overflow", "underflow", "integer overflow", "uint256"],
    },
    maxTokens: 400,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeKeyword(
        response,
        expected as { keywords: string[]; requireAll?: boolean }
      ),
  },
  {
    id: "debug-infinite-loop-v1",
    category: "debugging",
    prompt:
      `The following function never returns when called. What is the bug?\n\n` +
      "function countDown(n) {\n" +
      "  while (n > 0) {\n" +
      "    console.log(n);\n" +
      "    // missing decrement\n" +
      "  }\n" +
      "  return n;\n" +
      "}\n\n" +
      `End your response with a line that reads exactly:\n` +
      `Bug: <bug-description>`,
    expected: {
      keywords: ["infinite loop", "decrement", "n--", "n -=", "missing decrement", "loop"],
    },
    maxTokens: 400,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeKeyword(
        response,
        expected as { keywords: string[]; requireAll?: boolean }
      ),
  },
];
