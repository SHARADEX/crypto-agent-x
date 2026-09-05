// OpenRouter provider adapter (Phase-2 P2-1, P2-2, P2-3, P2-7).
//
// OpenRouter is an OpenAI-compatible router that aggregates many providers
// (Anthropic, Mistral, Meta, etc.) under a single API key. It exposes:
//
//   - POST /chat/completions  — chat (OpenAI-compat)
//   - GET  /models            — discovery
//
// Auth: `Authorization: Bearer $OPENROUTER_API_KEY`.
//
// Rate-limit headers: standard `X-RateLimit-*` family. A 429 returns a JSON
// body with `error.code` containing `rate_limit_exceeded` — we map that to
// `rate_limited`.

import { makeOpenAiCompatProvider } from "@/lib/llm/providers/openai-compat-base";

export const OpenRouterProvider = makeOpenAiCompatProvider({
  name: "openrouter",
  displayName: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  envKey: "OPENROUTER_API_KEY",
  supportsJsonMode: true,
  supportsToolCalls: true,
  // OpenRouter likes a `HTTP-Referer` + `X-Title` header for ranking in their
  // analytics dashboard. Cheap to send.
  extraHeaders: () => ({
    "HTTP-Referer": "https://github.com/cryptoearn-agent",
    "X-Title": "CryptoEarn Agent",
  }),
  // OpenRouter model ids are usually `<vendor>/<model>` (e.g.
  // `meta-llama/llama-3.3-70b-instruct:free`). The registry stores every
  // model as `<provider>/<modelId>` (see `upsertDiscoveredModel` in
  // providers/index.ts:287), so discovered OpenRouter models are stored as
  // `openrouter/meta-llama/llama-3.3-70b-instruct:free`. When we dispatch a
  // call, we must strip the leading `openrouter/` prefix so the API receives
  // the bare `meta-llama/llama-3.3-70b-instruct:free` slug it expects.
  // The seed model `openrouter/auto` becomes `auto` after stripping, which
  // is OpenRouter's valid auto-router slug.
  normalizeModelId: (m) => m.replace(/^openrouter\//, ""),
  // P0-2 fix: OpenRouter's `/models` endpoint is PUBLIC — it returns HTTP
  // 200 even with an invalid API key, causing a false `healthy` verdict.
  // Use a 1-token chat ping on `openrouter/auto` (OpenRouter's auto-router
  // slug) instead — the `/chat/completions` endpoint requires auth, so an
  // invalid key returns 401 → `invalid_credentials`.
  healthProbeModel: "openrouter/auto",
});
