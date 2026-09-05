// Mistral provider adapter (Phase-2 P2-1, P2-2, P2-3, P2-7).
//
// Mistral AI offers an OpenAI-compatible API at https://api.mistral.ai/v1
// with the standard `/chat/completions` + `/models` endpoints. Auth:
// `Authorization: Bearer $MISTRAL_API_KEY`. Has a free tier that allows
// `mistral-small-latest` and `open-mistral-nemo` calls.

import { makeOpenAiCompatProvider } from "@/lib/llm/providers/openai-compat-base";

export const MistralProvider = makeOpenAiCompatProvider({
  name: "mistral",
  displayName: "Mistral AI",
  baseUrl: "https://api.mistral.ai/v1",
  envKey: "MISTRAL_API_KEY",
  supportsJsonMode: true,
  supportsToolCalls: true,
  normalizeModelId: (m) => m.replace(/^mistral\//, ""),
});
