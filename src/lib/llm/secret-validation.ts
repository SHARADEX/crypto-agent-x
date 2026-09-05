// Secret validation (Phase-2 P2-19).
//
// `validateSecrets()` returns an array of `{ name, configured, required }`
// for every env var the agent reads. `printSecretReport()` console.logs a
// human-readable ✅/⚠️ view. NEVER prints the value — only the presence or
// absence of the variable.
//
// The list below mirrors `.env.example`. When new env vars are added there,
// they should ALSO be added here so the health check picks them up.

export interface SecretReportEntry {
  /** Env var name (e.g. `OPENROUTER_API_KEY`). */
  name: string;
  /** True when the env var is set to a non-empty string. */
  configured: boolean;
  /** True when the agent cannot run without this var (currently only DATABASE_URL). */
  required: boolean;
  /** One-line description for the report. */
  description: string;
}

const SECRET_DEFS: Array<{
  name: string;
  required?: boolean;
  description: string;
}> = [
  // ---- Database ----
  { name: "DATABASE_URL", required: true, description: "Prisma connection string (SQLite file or Postgres URL). Required for the app to start." },

  // ---- LLM providers ----
  { name: "OPENROUTER_API_KEY", description: "OpenRouter API key (free tier)." },
  { name: "GEMINI_API_KEY", description: "Google AI Studio (Gemini) API key." },
  { name: "GROQ_API_KEY", description: "Groq API key." },
  { name: "CEREBRAS_API_KEY", description: "Cerebras API key." },
  { name: "HF_TOKEN", description: "Hugging Face access token (preferred)." },
  { name: "HUGGINGFACE_API_KEY", description: "Hugging Face API key (alternate)." },
  { name: "MISTRAL_API_KEY", description: "Mistral AI API key." },
  { name: "CLOUDFLARE_API_TOKEN", description: "Cloudflare API token (Workers AI)." },
  { name: "CLOUDFLARE_ACCOUNT_ID", description: "Cloudflare account ID (required for Workers AI)." },
  { name: "ZAI_API_KEY", description: "Z.AI API key (optional — SDK auto-provisions in this env)." },
  { name: "NVIDIA_API_KEY", description: "NVIDIA NIM API key." },
  { name: "CRYPTOEAR_CLASSIFIER_MODEL", description: "Override the classifier model (default: zai/glm-4.6)." },

  // ---- GitHub (required for real PR submission + PR monitoring) ----
  { name: "GITHUB_TOKEN", description: "GitHub PAT with repo + workflow scopes (execution agent)." },

  // ---- Search providers (for the research agent) ----
  { name: "BRAVE_API_KEY", description: "Brave Search API key." },
  { name: "TAVILY_API_KEY", description: "Tavily search API key." },
  { name: "SERPER_API_KEY", description: "Serper.dev search API key." },
  { name: "EXA_API_KEY", description: "Exa search API key." },
  { name: "JINA_API_KEY", description: "Jina Reader API key (HTML → text)." },

  // ---- Content publishing adapters ----
  { name: "MEDIUM_TOKEN", description: "Medium API token (publishing adapter)." },
  { name: "MEDIUM_USER_ID", description: "Medium author user id (publishing adapter)." },
  { name: "MIRROR_AUTH_TOKEN", description: "Mirror.xyz auth token (publishing adapter)." },

  // ---- RSS discovery ----
  { name: "BOUNTY_RSS_FEEDS", description: "Comma-separated RSS feed URLs for bounty discovery." },

  // ---- Wallet RPC overrides ----
  { name: "BLOCKSCOUT_BASE_URL", description: "EVM block explorer base URL (default: eth.blockscout.com)." },
  { name: "BLOCKCHAIN_INFO_BASE_URL", description: "Bitcoin explorer base URL (default: blockchain.info)." },
  { name: "SOLANA_RPC_URL", description: "Solana RPC endpoint (default: api.mainnet-beta.solana.com)." },
  { name: "TRONGRID_BASE_URL", description: "Tron Grid API base URL (default: api.trongrid.io)." },
  { name: "RONIN_RPC_URL", description: "Ronin RPC endpoint (default: api.roninchain.com)." },

  // ---- Budget caps ----
  { name: "DAILY_LLM_TOKENS", description: "Daily LLM token budget (default: 250000)." },
  { name: "HOURLY_LLM_TOKENS", description: "Hourly LLM token budget (default: 40000)." },
  { name: "PER_TASK_LLM_TOKENS", description: "Per-task LLM token budget (default: 8000)." },
  { name: "DAILY_WEB_REQUESTS", description: "Daily outbound web request budget (default: 1000)." },
  { name: "DAILY_RPC_REQUESTS", description: "Daily RPC request budget (default: 500)." },

  // ---- Runtime / kill switch ----
  { name: "PAUSE_AGENT", description: "Set to 'true' to pause the agent at startup (env kill switch)." },
  { name: "MOCK_MODE", description: "Set to 'true' to force mock mode (simulated LLM + execution)." },
  { name: "PUBLIC_READ_ONLY", description: "Set to 'true' to expose a read-only public dashboard at /public." },
  { name: "OPERATOR_TOKEN", description: "Bearer token for operator-only API routes." },
  { name: "PROJECT_ROOT", description: "Project root for filesystem kill-switch marker paths (default: cwd)." },
];

/**
 * Returns a report entry for every env var the agent reads. NEVER raises.
 * NEVER includes the value — only the boolean `configured` flag.
 */
export function validateSecrets(): SecretReportEntry[] {
  const out: SecretReportEntry[] = [];
  for (const def of SECRET_DEFS) {
    const v = process.env[def.name];
    const configured = typeof v === "string" && v.trim().length > 0;
    out.push({
      name: def.name,
      configured,
      required: def.required === true,
      description: def.description,
    });
  }
  return out;
}

/**
 * Format the secret report as a human-readable string with ✅/⚠️ markers.
 * Suitable for printing in the console or surfacing on the dashboard.
 *
 * Example:
 *   ✅ DATABASE_URL configured
 *   ⚠️ OPENROUTER_API_KEY missing  — OpenRouter API key (free tier).
 */
export function formatSecretReport(): string {
  const lines: string[] = [];
  lines.push("Secret Validation Report");
  lines.push("========================");
  for (const entry of validateSecrets()) {
    const marker = entry.configured ? "✅" : "⚠️";
    const state = entry.configured
      ? "configured"
      : entry.required
        ? "MISSING (required)"
        : "missing";
    const suffix = entry.configured
      ? ""
      : `  — ${entry.description}`;
    lines.push(`${marker} ${entry.name.padEnd(28)} ${state}${suffix}`);
  }
  lines.push("");
  lines.push("NOTE: secret values are NEVER printed — only presence / absence.");
  return lines.join("\n");
}

/** Console.log the secret report. Convenience wrapper. */
export function printSecretReport(): void {
  console.log(formatSecretReport());
}
