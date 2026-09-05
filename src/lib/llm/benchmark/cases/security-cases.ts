// Benchmark cases — security analysis (Phase-2 §7 / P2-4 / P1-7).
//
// Each case shows a code snippet and asks a yes/no question about whether
// it contains a vulnerability, or asks to identify the bug. The grader
// extracts the answer (yes/no exact match or specific bug keyword).
// NO LLM judging.

import type { BenchmarkCase } from "../types";
import { gradeLabel, gradeKeyword } from "../grader";

export const securityCases: BenchmarkCase[] = [
  {
    id: "sec-sql-injection-v1",
    category: "security_analysis",
    prompt:
      `Does the following code contain a security vulnerability? Answer yes or no.\n\n` +
      "const query = \"SELECT * FROM users WHERE name = '\" + userInput + \"'\";\n" +
      "db.execute(query);\n\n" +
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
    id: "sec-xss-v1",
    category: "security_analysis",
    prompt:
      `Does the following code contain a security vulnerability? Answer yes or no.\n\n` +
      "function greet(name) {\n" +
      "  document.getElementById('greeting').innerHTML =\n" +
      "    '<h1>Hello, ' + name + '</h1>';\n" +
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
    id: "sec-hardcoded-secret-v1",
    category: "security_analysis",
    prompt:
      `Does the following code contain a security vulnerability? Answer yes or no.\n\n` +
      "const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';\n" +
      "const client = new S3Client({ accessKeyId: 'AKIA...', secretAccessKey: AWS_SECRET });\n\n" +
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
    id: "sec-identify-bug-v1",
    category: "security_analysis",
    prompt:
      `Look at this code and identify the vulnerability type by name.\n\n` +
      "function transfer(to, amount) {\n" +
      "  balances[msg.sender] -= amount;\n" +
      "  balances[to] += amount;\n" +
      "}\n\n" +
      "Hint: this is a Solidity function — what well-known attack is possible\n" +
      "if these two lines are in the wrong order?\n\n" +
      "End your response with a line that reads exactly:\n" +
      "Vulnerability: <bug-name>",
    expected: {
      keywords: ["reentrancy", "re-entrancy", "reentrant"],
    },
    maxTokens: 300,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeKeyword(
        response,
        expected as { keywords: string[]; requireAll?: boolean }
      ),
  },
];
