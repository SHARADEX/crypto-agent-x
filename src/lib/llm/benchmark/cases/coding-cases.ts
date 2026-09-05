// Benchmark cases — coding (Phase-2 §7 / P2-4 / P1-7).
//
// Each case prompts the model to implement a small pure function (no I/O, no
// imports, no external dependencies). The grader extracts the function from
// the response via `new Function()` (sandboxed — no require/import) and runs
// it against a test suite. Pass = all tests pass, partial = some pass,
// fail = syntax error / wrong.

import type { BenchmarkCase } from "../types";
import { gradeFunction } from "../grader";

export const codingCases: BenchmarkCase[] = [
  {
    id: "coding-isPrime-v1",
    category: "coding",
    prompt:
      `Implement a TypeScript function named "isPrime" that takes a number n and\n` +
      `returns true if n is a prime number, false otherwise. Treat numbers less\n` +
      `than 2 as not prime. Output ONLY the function inside a TypeScript code\n` +
      `fence — no prose, no examples, no test code.\n\n` +
      `Function signature: function isPrime(n: number): boolean`,
    expected: {
      fnName: "isPrime",
      tests: [
        { args: [2], want: true },
        { args: [3], want: true },
        { args: [4], want: false },
        { args: [17], want: true },
        { args: [1], want: false },
        { args: [0], want: false },
        { args: [-3], want: false },
        { args: [25], want: false },
        { args: [29], want: true },
        { args: [100], want: false },
      ],
    },
    maxTokens: 800,
    timeoutMs: 45_000,
    grade: (response, expected) =>
      gradeFunction(
        response,
        expected as { fnName: string; tests: { args: unknown[]; want: unknown }[] }
      ),
  },
  {
    id: "coding-fibonacci-v1",
    category: "coding",
    prompt:
      `Implement a TypeScript function named "fib" that takes a non-negative integer n\n` +
      `and returns the n-th Fibonacci number (0-indexed: fib(0) = 0, fib(1) = 1,\n` +
      `fib(n) = fib(n-1) + fib(n-2)). Output ONLY the function inside a TypeScript\n` +
      `code fence — no prose, no test code.\n\n` +
      `Function signature: function fib(n: number): number`,
    expected: {
      fnName: "fib",
      tests: [
        { args: [0], want: 0 },
        { args: [1], want: 1 },
        { args: [2], want: 1 },
        { args: [3], want: 2 },
        { args: [5], want: 5 },
        { args: [10], want: 55 },
        { args: [15], want: 610 },
      ],
    },
    maxTokens: 800,
    timeoutMs: 45_000,
    grade: (response, expected) =>
      gradeFunction(
        response,
        expected as { fnName: string; tests: { args: unknown[]; want: unknown }[] }
      ),
  },
  {
    id: "coding-reverseString-v1",
    category: "coding",
    prompt:
      `Implement a TypeScript function named "reverseString" that takes a string s\n` +
      `and returns the string with its characters reversed. For empty string return\n` +
      `empty string. Output ONLY the function inside a TypeScript code fence — no\n` +
      `prose, no test code.\n\n` +
      `Function signature: function reverseString(s: string): string`,
    expected: {
      fnName: "reverseString",
      tests: [
        { args: [""], want: "" },
        { args: ["a"], want: "a" },
        { args: ["ab"], want: "ba" },
        { args: ["hello"], want: "olleh" },
        { args: ["racecar"], want: "racecar" },
        { args: ["12345"], want: "54321" },
      ],
    },
    maxTokens: 600,
    timeoutMs: 45_000,
    grade: (response, expected) =>
      gradeFunction(
        response,
        expected as { fnName: string; tests: { args: unknown[]; want: unknown }[] }
      ),
  },
  {
    id: "coding-sumArray-v1",
    category: "coding",
    prompt:
      `Implement a TypeScript function named "sumArray" that takes an array of\n` +
      `numbers and returns the sum of all elements. Empty array returns 0.\n` +
      `Output ONLY the function inside a TypeScript code fence — no prose, no test\n` +
      `code.\n\n` +
      `Function signature: function sumArray(arr: number[]): number`,
    expected: {
      fnName: "sumArray",
      tests: [
        { args: [[]], want: 0 },
        { args: [[1, 2, 3]], want: 6 },
        { args: [[-1, -2, -3]], want: -6 },
        { args: [[100]], want: 100 },
        { args: [[1.5, 2.5]], want: 4 },
      ],
    },
    maxTokens: 600,
    timeoutMs: 45_000,
    grade: (response, expected) =>
      gradeFunction(
        response,
        expected as { fnName: string; tests: { args: unknown[]; want: unknown }[] }
      ),
  },
];
