// Google Gemini provider adapter (Phase-2 P2-1, P2-2, P2-3, P2-7).
//
// Gemini has TWO API surfaces:
//   1. The native Generative Language API (`/v1beta/models/...`)
//   2. An OpenAI-compat endpoint at `/v1beta/openai/chat/completions`
//
// We use surface #2 because it lets us reuse the shared OpenAI-compat base —
// same body shape, same `Authorization: Bearer` auth, same usage parsing. The
// only Gemini-specific quirk is the path prefix.

import { makeOpenAiCompatProvider } from "@/lib/llm/providers/openai-compat-base";

export const GeminiProvider = makeOpenAiCompatProvider({
  name: "gemini",
  displayName: "Google Gemini",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  envKey: "GEMINI_API_KEY",
  chatCompletionsPath: "/openai/chat/completions",
  modelsPath: "/openai/models",
  supportsJsonMode: true,
  supportsToolCalls: true,
  // Gemini's `/openai/models` endpoint returns OpenAI-shaped objects with
  // `id` = `models/gemini-2.0-flash` etc. — strip the `models/` prefix.
  normalizeModelId: (m) => m.replace(/^models\//, "").replace(/^gemini\//, ""),
  filterDiscovered: (m) => !m.modelId.startsWith("embedding-") && !m.modelId.startsWith("tts-") && !m.modelId.startsWith("imagen"),
});
