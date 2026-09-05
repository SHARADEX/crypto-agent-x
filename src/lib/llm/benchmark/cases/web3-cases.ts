// Benchmark cases — web3 understanding (Phase-2 §7 / P2-4 / P1-7).
//
// Each case asks a Web3 / Solidity / blockchain question with a known
// canonical answer. The grader extracts the label/keyword and compares to
// the deterministic expected answer. NO LLM judging.

import type { BenchmarkCase } from "../types";
import { gradeLabel, gradeKeyword } from "../grader";

export const web3Cases: BenchmarkCase[] = [
  {
    id: "web3-solidity-keyword-v1",
    category: "web3_understanding",
    prompt:
      `In Solidity, which visibility keyword marks a function that can ONLY be\n` +
      `called externally (by other contracts or via transactions) and NOT\n` +
      `internally from within the same contract? Choose from: public, private,\n` +
      `external, internal.\n\n` +
      "End your response with a line that reads exactly:\n" +
      "Answer: <keyword>",
    expected: {
      allowed: ["public", "private", "external", "internal"],
      answer: "external",
    },
    maxTokens: 200,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeLabel(
        response,
        expected as { allowed: readonly string[]; answer: string }
      ),
  },
  {
    id: "web3-reentrancy-detect-v1",
    category: "web3_understanding",
    prompt:
      `Does this Solidity function contain a reentrancy vulnerability? Answer yes\n` +
      `or no.\n\n` +
      "function withdraw() public {\n" +
      "  uint amount = balances[msg.sender];\n" +
      "  require(msg.sender.call.value(amount)());  // external call\n" +
      "  balances[msg.sender] = 0;                  // state update AFTER call\n" +
      "}\n\n" +
      "End your response with a line that reads exactly:\n" +
      "Answer: <yes|no>",
    expected: { allowed: ["yes", "no"], answer: "yes" },
    maxTokens: 200,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeLabel(
        response,
        expected as { allowed: readonly string[]; answer: string }
      ),
  },
  {
    id: "web3-gas-limit-keyword-v1",
    category: "web3_understanding",
    prompt:
      `In Ethereum, what is the per-block hard cap on the total gas that can be\n` +
      `consumed by all transactions in the block? Provide a single integer value.\n\n` +
      `End your response with a line that reads exactly:\n` +
      `Answer: <number>`,
    expected: 30_000_000,
    maxTokens: 300,
    timeoutMs: 30_000,
    grade: (response, expected) => {
      const got = Number(
        (response.match(/answer\s*[:]\s*([\d,\s]+)/i)?.[1] ?? "").replace(
          /[,\s]/g,
          ""
        )
      );
      const want = expected as number;
      if (!Number.isFinite(got)) {
        return {
          score: 0,
          passed: false,
          details: `no numeric answer extracted (expected ${want})`,
        };
      }
      // Accept the canonical 30M (post-London default) — give partial credit
      // for close-but-not-exact values (15M = pre-London, etc.).
      if (got === want) {
        return {
          score: 1,
          passed: true,
          details: `correct: ${got.toLocaleString()}`,
        };
      }
      if (Math.abs(got - want) <= 1_000_000) {
        return {
          score: 0.5,
          passed: false,
          details: `close: got ${got}, expected ${want}`,
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
    id: "web3-storage-keyword-v1",
    category: "web3_understanding",
    prompt:
      `In Solidity, which data location is REQUIRED for reference-type\n` +
      `parameters (structs, dynamic arrays) of EXTERNAL functions when the\n` +
      `function only needs to read the data? Choose from: storage, memory,\n` +
      `calldata, stack.\n\n` +
      `End your response with a line that reads exactly:\n` +
      `Answer: <keyword>`,
    expected: {
      allowed: ["storage", "memory", "calldata", "stack"],
      answer: "calldata",
    },
    maxTokens: 300,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeLabel(
        response,
        expected as { allowed: readonly string[]; answer: string }
      ),
  },
];
