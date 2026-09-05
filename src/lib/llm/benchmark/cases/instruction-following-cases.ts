// Benchmark cases — instruction-following (Phase-2 §7 / P2-4 / P1-7).
//
// Each case gives the model a constraint (length, formatting, content rules).
// The grader checks each constraint deterministically (sentence count, word
// match, regex). Score = fraction of constraints satisfied. NO LLM judging.

import type { BenchmarkCase } from "../types";
import { checkConstraints, countSentences, countWords } from "../grader";

export const instructionFollowingCases: BenchmarkCase[] = [
  {
    id: "instr-three-sentences-v1",
    category: "instruction_following",
    prompt:
      `Write a description of the planet Mars.\n` +
      `Constraints:\n` +
      `- Your response must be exactly 3 sentences (no more, no less).\n` +
      `- Each sentence must end with a period.\n` +
      `- Do not use any bullet points or lists.\n\n` +
      `Respond with only the description — no preamble.`,
    expected: null,
    maxTokens: 400,
    timeoutMs: 30_000,
    grade: (response, _expected) => {
      void _expected;
      return checkConstraints(response, [
        {
          name: "exactly 3 sentences",
          check: (r) => countSentences(r) === 3,
        },
        {
          name: "no bullet points",
          check: (r) => !/^[\s]*[-*]\s/m.test(r) && !/^\s*\d+\.\s/m.test(r),
        },
        {
          name: "at least 30 words",
          check: (r) => countWords(r) >= 30,
        },
      ]);
    },
  },
  {
    id: "instr-start-summary-v1",
    category: "instruction_following",
    prompt:
      `Write a 1-paragraph summary of how HTTPS works.\n` +
      `Constraints:\n` +
      `- Your response MUST start with the exact word "Summary" (capital S).\n` +
      `- The word "Summary" must be followed by a colon and a space.\n` +
      `- The total response must be between 50 and 200 words.\n` +
      `- No bullet points, no code blocks, no markdown formatting.\n\n` +
      `Respond with only the paragraph — no preamble.`,
    expected: null,
    maxTokens: 400,
    timeoutMs: 30_000,
    grade: (response, _expected) => {
      void _expected;
      return checkConstraints(response, [
        {
          name: "starts with 'Summary:'",
          check: (r) => /^Summary:\s/.test(r.trim()),
        },
        {
          name: "no bullet points",
          check: (r) => !/^[\s]*[-*]\s/m.test(r),
        },
        {
          name: "no code fences",
          check: (r) => !/```/.test(r),
        },
        {
          name: "50-200 words",
          check: (r) => {
            const w = countWords(r);
            return w >= 50 && w <= 200;
          },
        },
      ]);
    },
  },
  {
    id: "instr-lowercase-only-v1",
    category: "instruction_following",
    prompt:
      `Write a 2-sentence description of a coffee shop. The entire response must\n` +
      `use ONLY lowercase letters (no uppercase letters anywhere — not even at\n` +
      `the start of sentences). All other punctuation is fine.\n\n` +
      `Respond with only the description.`,
    expected: null,
    maxTokens: 300,
    timeoutMs: 30_000,
    grade: (response, _expected) => {
      void _expected;
      return checkConstraints(response, [
        {
          name: "no uppercase letters",
          check: (r) => !/[A-Z]/.test(r),
        },
        {
          name: "exactly 2 sentences",
          check: (r) => countSentences(r) === 2,
        },
        {
          name: "at least 15 words",
          check: (r) => countWords(r) >= 15,
        },
      ]);
    },
  },
  {
    id: "instr-no-letter-e-v1",
    category: "instruction_following",
    prompt:
      `Write a 2-3 sentence description of a sunset. The constraint: do not use\n` +
      `the letter 'e' (case-insensitive — no 'e' or 'E') anywhere in your\n` +
      `response. The description must contain at least 20 words.\n\n` +
      `Respond with only the description.`,
    expected: null,
    maxTokens: 400,
    timeoutMs: 45_000,
    grade: (response, _expected) => {
      void _expected;
      return checkConstraints(response, [
        {
          name: "no letter 'e' or 'E'",
          check: (r) => !/[eE]/.test(r),
        },
        {
          name: "2-3 sentences",
          check: (r) => {
            const c = countSentences(r);
            return c >= 2 && c <= 3;
          },
        },
        {
          name: "at least 20 words",
          check: (r) => countWords(r) >= 20,
        },
      ]);
    },
  },
];
