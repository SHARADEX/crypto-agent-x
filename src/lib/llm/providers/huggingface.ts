// Hugging Face provider adapter (Phase-2 P2-1, P2-2, P2-3, P2-7).
//
// HF's "router" API exposes an OpenAI-compatible endpoint at
// https://router.huggingface.co/v1/chat/completions. Auth:
// `Authorization: Bearer $HF_TOKEN` (or `$HUGGINGFACE_API_KEY` — both work,
// we prefer `HF_TOKEN` per the .env.example).
//
// Discovery: GET `/v1/models` returns a list of router-routable models.

import { makeOpenAiCompatProvider } from "@/lib/llm/providers/openai-compat-base";

export const HuggingFaceProvider = makeOpenAiCompatProvider({
  name: "huggingface",
  displayName: "Hugging Face",
  baseUrl: "https://router.huggingface.co/v1",
  // HF_TOKEN is the canonical name; we also accept HUGGINGFACE_API_KEY as a
  // fallback by resolving it at config time.
  envKey: process.env.HF_TOKEN ? "HF_TOKEN" : "HUGGINGFACE_API_KEY",
  supportsJsonMode: true,
  supportsToolCalls: false,
  normalizeModelId: (m) => m.replace(/^huggingface\//, ""),
});
