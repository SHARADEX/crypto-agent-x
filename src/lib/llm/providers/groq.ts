// Groq provider adapter (Phase-2 P2-1, P2-2, P2-3, P2-7).
//
// Groq offers an OpenAI-compatible API at https://api.groq.com/openai/v1 with
// the standard `/chat/completions` + `/models` endpoints. Auth via
// `Authorization: Bearer $GROQ_API_KEY`.
//
// Groq is notable for its very fast inference (LPU silicon) and relatively
// strict rate limits — they return `X-RateLimit-*` headers on every request.

import { makeOpenAiCompatProvider } from "@/lib/llm/providers/openai-compat-base";

export const GroqProvider = makeOpenAiCompatProvider({
  name: "groq",
  displayName: "Groq",
  baseUrl: "https://api.groq.com/openai/v1",
  envKey: "GROQ_API_KEY",
  supportsJsonMode: true,
  supportsToolCalls: true,
  // Groq model ids are plain (`llama-3.3-70b-versatile`). Strip any
  // `groq/` prefix the caller may have added.
  normalizeModelId: (m) => m.replace(/^groq\//, ""),
});
