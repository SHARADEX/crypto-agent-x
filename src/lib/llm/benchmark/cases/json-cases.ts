// Benchmark cases — structured JSON output (Phase-2 §7 / P2-4 / P1-7).
//
// Each case prompts the model to emit JSON matching a schema; the grader
// parses the response and validates against a zod schema. Spec §7 forbids
// "scoring everything through another LLM" — the schema is the source of
// truth, not a judge LLM.

import { z } from "zod";
import type { BenchmarkCase } from "../types";
import { gradeJsonSchema } from "../grader";

const personSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().nonnegative(),
  email: z.string().email(),
});

const productListSchema = z.object({
  products: z
    .array(
      z.object({
        id: z.string().or(z.number()),
        name: z.string().min(1),
        price: z.number().nonnegative(),
      })
    )
    .min(1),
});

const nestedSchema = z.object({
  user: z.object({
    id: z.string().min(1),
    profile: z.object({
      displayName: z.string().min(1),
      verified: z.boolean(),
    }),
  }),
  meta: z.object({
    version: z.string(),
  }),
});

export const jsonCases: BenchmarkCase[] = [
  {
    id: "json-person-v1",
    category: "structured_json",
    prompt:
      `Output a single JSON object (no prose, no markdown fence) representing a person.\n` +
      `Schema: { "name": string, "age": number (integer >= 0), "email": string (valid email) }.\n` +
      `Use this exact data: name "Ada Lovelace", age 36, email "ada@example.com".\n` +
      `Respond with ONLY the JSON object.`,
    expected: personSchema,
    maxTokens: 200,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeJsonSchema(response, expected as z.ZodType),
  },
  {
    id: "json-products-v1",
    category: "structured_json",
    prompt:
      `Output a JSON object listing 3 products. Schema:\n` +
      `{ "products": [ { "id": string, "name": string, "price": number } ... ] }.\n` +
      `Use these products (any ids): "Widget" $9.99, "Gadget" $19.95, "Gizmo" $4.50.\n` +
      `Respond with ONLY the JSON object — no prose, no code fence.`,
    expected: productListSchema,
    maxTokens: 400,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeJsonSchema(response, expected as z.ZodType),
  },
  {
    id: "json-nested-v1",
    category: "structured_json",
    prompt:
      `Output a JSON object with nested fields, schema:\n` +
      `{ "user": { "id": string, "profile": { "displayName": string, "verified": boolean } },\n` +
      `  "meta": { "version": string } }.\n` +
      `Use: id "u-001", displayName "alice", verified true, version "1.0.0".\n` +
      `Respond with ONLY the JSON object — no prose, no markdown.`,
    expected: nestedSchema,
    maxTokens: 300,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeJsonSchema(response, expected as z.ZodType),
  },
];
