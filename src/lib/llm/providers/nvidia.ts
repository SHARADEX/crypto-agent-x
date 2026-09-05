// NVIDIA NIM provider adapter (Phase-2 P2-1, P2-2, P2-3, P2-7).
//
// NVIDIA's integrate.api.nvidia.com hosts an OpenAI-compatible endpoint
// (`/v1/chat/completions` + `/v1/models`) that routes to a catalogue of
// open-weights models (Llama 3.x, Mixtral, Qwen, DeepSeek, etc.) running
// on NVIDIA's hardware. Auth: `Authorization: Bearer $NVIDIA_API_KEY`.

import { makeOpenAiCompatProvider } from "@/lib/llm/providers/openai-compat-base";

export const NvidiaProvider = makeOpenAiCompatProvider({
  name: "nvidia",
  displayName: "NVIDIA NIM",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  envKey: "NVIDIA_API_KEY",
  supportsJsonMode: true,
  supportsToolCalls: true,
  normalizeModelId: (m) => m.replace(/^nvidia\//, ""),
  // P0-2 fix: NVIDIA's `/models` endpoint is PUBLIC — it returns HTTP 200
  // even with an invalid API key, causing a false `healthy` verdict. Use a
  // 1-token chat ping on `meta/llama-3.1-8b-instruct` (always-available
  // free model in NVIDIA's catalogue) instead — `/chat/completions`
  // requires auth, so an invalid key returns 403 → `invalid_credentials`.
  healthProbeModel: "meta/llama-3.1-8b-instruct",
});
