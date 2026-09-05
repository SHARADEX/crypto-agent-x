// Cerebras provider adapter (Phase-2 P2-1, P2-2, P2-3, P2-7).
//
// Cerebras offers an OpenAI-compatible API at https://api.cerebras.ai/v1
// with the standard `/chat/completions` + `/models` endpoints. Auth via
// `Authorization: Bearer $CEREBRAS_API_KEY`. Their LPU silicon delivers the
// lowest latency of the open-weights providers.

import { makeOpenAiCompatProvider } from "@/lib/llm/providers/openai-compat-base";

export const CerebrasProvider = makeOpenAiCompatProvider({
  name: "cerebras",
  displayName: "Cerebras",
  baseUrl: "https://api.cerebras.ai/v1",
  envKey: "CEREBRAS_API_KEY",
  supportsJsonMode: true,
  supportsToolCalls: false,
  normalizeModelId: (m) => m.replace(/^cerebras\//, ""),
});
