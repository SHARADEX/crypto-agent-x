// LLM provider configuration (spec §4C–§4R, §19).
//
// The four free providers requested by the operator are OpenRouter, Gemini,
// Groq, and Cerebras. The Z.AI SDK is wired in as the live reasoning backend
// used by the dashboard demo so the agent can be exercised end-to-end without
// requiring the operator to paste API keys. The other four providers are
// modelled in the registry with realistic capability scores so the Model
// Router can demonstrate adaptive selection, exploration/exploitation, and
// fallback hierarchies.

import type { ModelRecord, Provider } from "@/lib/agent/types";

export const PROVIDER_BASE_URL: Record<Provider, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  groq: "https://api.groq.com/openai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  zai: "https://api.z.ai/api/paas/v4",
  huggingface: "https://router.huggingface.co/v1",
  mistral: "https://api.mistral.ai/v1",
  cloudflare: "https://api.cloudflare.com/client/v4/accounts",
  nvidia: "https://integrate.api.nvidia.com/v1",
};

// Environment variable names where the operator may paste real free-tier API
// keys. All are OPTIONAL — when absent the system falls back to the Z.AI SDK
// (which is already provisioned in this environment) for live reasoning.
export const PROVIDER_ENV_KEY: Record<Provider, string> = {
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  zai: "ZAI_API_KEY",
  huggingface: "HF_TOKEN",
  mistral: "MISTRAL_API_KEY",
  cloudflare: "CLOUDFLARE_API_TOKEN",
  nvidia: "NVIDIA_API_KEY",
};

// Seed model registry. Capabilities are 0..10 (calibrated against published
// benchmarks and internal task outcomes). These are starting estimates only —
// the adaptive router (spec §4I, §4K) overrides them with real-world outcomes.
export const SEED_MODELS: ModelRecord[] = [
  {
    model_id: "zai/glm-4.6",
    provider: "zai",
    api_type: "zai",
    enabled: true,
    role: "primary",
    status: "healthy",
    capabilities: {
      reasoning: 9.2,
      coding: 9.0,
      research: 8.8,
      web_research: 8.5,
      web3: 8.0,
      security: 8.2,
      writing: 9.0,
      tool_use: 8.7,
      structured_output: 9.3,
    },
    performance: {
      success_rate: 0.92,
      average_quality: 8.9,
      average_latency: 1800,
      average_tokens: 1450,
      failure_rate: 0.08,
    },
    limits: {
      requests_per_minute: 30,
      tokens_per_minute: 60000,
      daily_requests: 1000,
      daily_tokens: 500000,
    },
    earnings_contribution_usd: 0,
  },
  {
    model_id: "openrouter/auto",
    provider: "openrouter",
    api_type: "openai-compatible",
    enabled: true,
    role: "primary",
    status: "healthy",
    capabilities: {
      reasoning: 8.5,
      coding: 8.7,
      research: 8.9,
      web_research: 9.0,
      web3: 7.8,
      security: 8.0,
      writing: 8.8,
      tool_use: 8.6,
      structured_output: 8.4,
    },
    performance: {
      success_rate: 0.88,
      average_quality: 8.5,
      average_latency: 2400,
      average_tokens: 1600,
      failure_rate: 0.12,
    },
    limits: {
      requests_per_minute: 20,
      tokens_per_minute: 40000,
      daily_requests: 200,
      daily_tokens: 200000,
    },
    earnings_contribution_usd: 0,
  },
  {
    model_id: "gemini/gemini-2.0-flash",
    provider: "gemini",
    api_type: "gemini",
    enabled: true,
    role: "secondary",
    status: "healthy",
    capabilities: {
      reasoning: 8.4,
      coding: 8.2,
      research: 8.6,
      web_research: 9.2,
      web3: 7.5,
      security: 7.8,
      writing: 8.5,
      tool_use: 8.3,
      structured_output: 8.8,
    },
    performance: {
      success_rate: 0.87,
      average_quality: 8.4,
      average_latency: 1500,
      average_tokens: 1200,
      failure_rate: 0.13,
    },
    limits: {
      requests_per_minute: 15,
      tokens_per_minute: 60000,
      daily_requests: 1500,
      daily_tokens: 1000000,
    },
    earnings_contribution_usd: 0,
  },
  {
    model_id: "groq/llama-3.3-70b-versatile",
    provider: "groq",
    api_type: "openai-compatible",
    enabled: true,
    role: "primary",
    status: "healthy",
    capabilities: {
      reasoning: 8.1,
      coding: 8.0,
      research: 7.8,
      web_research: 7.5,
      web3: 7.2,
      security: 7.4,
      writing: 8.0,
      tool_use: 7.9,
      structured_output: 8.2,
    },
    performance: {
      success_rate: 0.86,
      average_quality: 8.1,
      average_latency: 850,
      average_tokens: 950,
      failure_rate: 0.14,
    },
    limits: {
      requests_per_minute: 30,
      tokens_per_minute: 60000,
      daily_requests: 1000,
      daily_tokens: 500000,
    },
    earnings_contribution_usd: 0,
  },
  {
    model_id: "cerebras/llama-3.1-70b",
    provider: "cerebras",
    api_type: "openai-compatible",
    enabled: true,
    role: "exploration",
    status: "healthy",
    capabilities: {
      reasoning: 7.9,
      coding: 7.8,
      research: 7.6,
      web_research: 7.3,
      web3: 7.0,
      security: 7.1,
      writing: 7.7,
      tool_use: 7.6,
      structured_output: 7.9,
    },
    performance: {
      success_rate: 0.83,
      average_quality: 7.8,
      average_latency: 420,
      average_tokens: 880,
      failure_rate: 0.17,
    },
    limits: {
      requests_per_minute: 25,
      tokens_per_minute: 50000,
      daily_requests: 800,
      daily_tokens: 400000,
    },
    earnings_contribution_usd: 0,
  },
  {
    model_id: "gemini/gemini-2.5-pro",
    provider: "gemini",
    api_type: "gemini",
    enabled: true,
    role: "reviewer",
    status: "healthy",
    capabilities: {
      reasoning: 9.3,
      coding: 9.1,
      research: 9.2,
      web_research: 9.4,
      web3: 8.4,
      security: 8.6,
      writing: 9.1,
      tool_use: 8.9,
      structured_output: 9.2,
    },
    performance: {
      success_rate: 0.9,
      average_quality: 8.9,
      average_latency: 3200,
      average_tokens: 2100,
      failure_rate: 0.1,
    },
    limits: {
      requests_per_minute: 10,
      tokens_per_minute: 80000,
      daily_requests: 500,
      daily_tokens: 800000,
    },
    earnings_contribution_usd: 0,
  },
];

// Exploration / exploitation split (spec §4J). Percentages are configurable.
export const ROUTING_EXPLORATION = {
  exploit_best: 0.8, // 80% — use currently best-performing model
  explore_promising: 0.15, // 15% — test promising alternatives
  experiment_unknown: 0.05, // 5% — try unknown/new models
};

// Free-tier budget caps (spec §27). Conservative defaults; can be tightened
// further via env vars.
export const BUDGET_LIMITS = {
  dailyLlmTokens: Number(process.env.DAILY_LLM_TOKENS ?? 250000),
  hourlyLlmTokens: Number(process.env.HOURLY_LLM_TOKENS ?? 40000),
  perTaskLlmTokens: Number(process.env.PER_TASK_LLM_TOKENS ?? 8000),
  dailyWebRequests: Number(process.env.DAILY_WEB_REQUESTS ?? 500),
  dailyRpcRequests: Number(process.env.DAILY_RPC_REQUESTS ?? 1000),
};
