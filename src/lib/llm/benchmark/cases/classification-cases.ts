// Benchmark cases — classification (Phase-2 §7 / P2-4 / P1-7).
//
// Each case prompts the model to classify text into one of N labels. The
// grader extracts the label (case-insensitive, word-boundary matched) and
// compares to the deterministic expected label. NO LLM judging.

import type { BenchmarkCase } from "../types";
import { gradeLabel } from "../grader";

export const classificationCases: BenchmarkCase[] = [
  {
    id: "classify-sentiment-v1",
    category: "classification",
    prompt:
      `Classify the sentiment of this review as one of: positive, negative,\n` +
      `neutral.\n\n` +
      `"The product arrived on time and works exactly as advertised. Very happy\n` +
      `with the purchase — would buy again."\n\n` +
      `End your response with a line that reads exactly:\n` +
      `Label: <your-label>`,
    expected: { allowed: ["positive", "negative", "neutral"], answer: "positive" },
    maxTokens: 200,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeLabel(
        response,
        expected as { allowed: readonly string[]; answer: string }
      ),
  },
  {
    id: "classify-spam-v1",
    category: "classification",
    prompt:
      `Classify the following email as one of: spam, ham (legitimate).\n\n` +
      `"Subject: CONGRATULATIONS! You've won a $1,000,000 lottery!!!\n` +
      `Click here NOW to claim your prize before it expires in 24 hours!!!"\n\n` +
      `End your response with a line that reads exactly:\n` +
      `Label: <your-label>`,
    expected: { allowed: ["spam", "ham"], answer: "spam" },
    maxTokens: 200,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeLabel(
        response,
        expected as { allowed: readonly string[]; answer: string }
      ),
  },
  {
    id: "classify-language-v1",
    category: "classification",
    prompt:
      `Identify the natural language of this text. Choose from: english, spanish,\n` +
      `french, german, italian.\n\n` +
      `"Bonjour, comment allez-vous aujourd'hui? Je suis très heureux de vous\n` +
      `rencontrer."\n\n` +
      `End your response with a line that reads exactly:\n` +
      `Label: <your-label>`,
    expected: {
      allowed: ["english", "spanish", "french", "german", "italian"],
      answer: "french",
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
    id: "classify-topic-v1",
    category: "classification",
    prompt:
      `Classify the topic of this news headline into one of: sports, politics,\n` +
      `technology, health.\n\n` +
      `"OpenAI releases new flagship model with improved reasoning and 1M context\n` +
      `window; competitors scramble to catch up."\n\n` +
      `End your response with a line that reads exactly:\n` +
      `Label: <your-label>`,
    expected: {
      allowed: ["sports", "politics", "technology", "health"],
      answer: "technology",
    },
    maxTokens: 200,
    timeoutMs: 30_000,
    grade: (response, expected) =>
      gradeLabel(
        response,
        expected as { allowed: readonly string[]; answer: string }
      ),
  },
];
