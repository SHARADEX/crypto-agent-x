// Benchmark cases — tool use (Phase-2 §7 / P2-4 / P1-7).
//
// Each case prompts the model to emit a tool-call JSON structure (e.g. OpenAI
// function-calling format: { "name": "...", "arguments": {...} }). The grader
// extracts the JSON and checks that it has a tool name + args object. NO LLM
// judging — pure structural validation.

import type { BenchmarkCase } from "../types";
import { gradeToolCall } from "../grader";

export const toolUseCases: BenchmarkCase[] = [
  {
    id: "tool-weather-v1",
    category: "tool_use",
    prompt:
      `You are an assistant with access to a tool called "get_weather" that\n` +
      `accepts an object with a "location" string and optional "unit" field\n` +
      `(value "celsius" or "fahrenheit").\n\n` +
      `The user asks: "What's the weather in Tokyo?"\n\n` +
      `Respond with a single JSON tool-call object in this exact format:\n` +
      `{\n  "name": "get_weather",\n  "arguments": { "location": "Tokyo" }\n}\n\n` +
      `Respond with ONLY the JSON object — no prose, no markdown.`,
    expected: null,
    maxTokens: 200,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeToolCall(response, expected),
  },
  {
    id: "tool-search-v1",
    category: "tool_use",
    prompt:
      `You are an assistant with a tool called "web_search" that accepts an\n` +
      `object with a "query" string and an optional "max_results" integer.\n\n` +
      `The user asks: "Find recent papers on zero-knowledge proofs."\n\n` +
      `Respond with a single JSON tool-call object in this format:\n` +
      `{\n  "name": "web_search",\n  "arguments": { "query": "..." }\n}\n\n` +
      `Respond with ONLY the JSON object — no prose.`,
    expected: null,
    maxTokens: 200,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeToolCall(response, expected),
  },
  {
    id: "tool-transfer-v1",
    category: "tool_use",
    prompt:
      `You are an assistant with a tool called "transfer_token" that accepts an\n` +
      `object with "to" (string address), "amount" (number), and "token" (string\n` +
      `symbol).\n\n` +
      `The user asks: "Send 5 USDC to address 0x123abc."\n\n` +
      `Respond with a single JSON tool-call object in this format:\n` +
      `{\n  "name": "transfer_token",\n  "arguments": { "to": "...", "amount": 5, "token": "USDC" }\n}\n\n` +
      `Respond with ONLY the JSON object — no prose.`,
    expected: null,
    maxTokens: 200,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeToolCall(response, expected),
  },
];
