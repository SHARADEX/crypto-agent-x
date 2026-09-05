# Configuration

This document describes every configuration file in the CryptoEarn
Agent and how to customize the agent's behavior without touching code.

All configuration lives in three TypeScript files under
[`src/config/`](../src/config/) plus the Prisma schema. Environment
variables override runtime defaults.

---

## Table of contents

1. [`src/config/wallets.ts`](#1-srcconfigwalletsts)
2. [`src/config/sources.ts`](#2-srcconfigsourcests)
3. [`src/config/providers.ts`](#3-srcconfigprovidersts)
4. [`prisma/schema.prisma`](#4-prismaschemaprisma)
5. [How to add a new wallet](#5-how-to-add-a-new-wallet)
6. [How to add a new opportunity source](#6-how-to-add-a-new-opportunity-source)
7. [How to add a new LLM provider](#7-how-to-add-a-new-llm-provider)
8. [How to change budget limits](#8-how-to-change-budget-limits)
9. [How to change autonomy mode](#9-how-to-change-autonomy-mode)
10. [How to add a new strategy](#10-how-to-add-a-new-strategy)
11. [Environment variable reference](#11-environment-variable-reference)

---

## 1. `src/config/wallets.ts`

[`src/config/wallets.ts`](../src/config/wallets.ts) defines the
public read-only wallet addresses the agent monitors.

### Shape

```typescript
export const WALLETS: WalletConfig[] = [
  {
    label: "Ronin Wallet",
    chain: "ronin",
    address: "0xAa4E76e5Be5334c0f2Fe0716C42B2FC61D4c150B",
    explorer: "https://app.roninchain.com",
  },
  // ... 4 more
];

export const NATIVE_PRICE_FALLBACK_USD: Record<string, number> = {
  ETH: 3200, BTC: 62000, SOL: 145, TRX: 0.13, RON: 1.6,
  MATIC: 0.55, BNB: 580,
};

export const NATIVE_SYMBOL_BY_CHAIN: Record<string, string> = {
  ethereum: "ETH", bitcoin: "BTC", solana: "SOL", tron: "TRX",
  ronin: "RON", polygon: "MATIC", bsc: "BNB",
  arbitrum: "ETH", optimism: "ETH",
};
```

### Default wallets (5)

| Label | Chain | Address |
|---|---|---|
| Ronin Wallet | ronin | `0xAa4E76e5Be5334c0f2Fe0716C42B2FC61D4c150B` |
| MetaMask (EVM) Wallet | ethereum | `0xd6DFE6b54bF3dBC919Fde57009452fe6bbb0D997` |
| Bitcoin Wallet | bitcoin | `bc1qh3areygq598ntxht0yp5yv87ej7g6aqvw8fl4z` |
| Solana Wallet | solana | `2emXSLoziaB5wdC8y48ovbu41agh9PzR5ro8o7kRDUvM` |
| Tron Wallet | tron | `TJxkyJW57Tb8qmvvv5rCh3L2FYssRvWFEv` |

### What each field means

| Field | Type | Description |
|---|---|---|
| `label` | string | Human-readable name shown in the dashboard. |
| `chain` | `Chain` | One of `ethereum`, `bitcoin`, `solana`, `tron`, `ronin`, `polygon`, `bsc`, `arbitrum`, `optimism`. Determines which adapter is used. |
| `address` | string | The public address (case-sensitive on Solana; case-insensitive on EVM/Tron). |
| `explorer` | string | Base URL of the chain's explorer (for dashboard links). |

### `NATIVE_PRICE_FALLBACK_USD`

Conservative USD reference prices used **for display only**. Used as a
fallback when a live price cannot be fetched (e.g. when the adapter
hits a rate limit). NOT used for accounting — verified earnings store
the USD value at the time of payment verification.

### `NATIVE_SYMBOL_BY_CHAIN`

Maps chain identifiers to native token symbols. Used by the wallet
adapters and the payment verifier to normalize currency strings.

---

## 2. `src/config/sources.ts`

[`src/config/sources.ts`](../src/config/sources.ts) defines the
opportunity sources the Scout agent polls, the skills the agent
claims, and the prohibited content patterns.

### `SOURCES` array

```typescript
export const SOURCES: SourceConfig[] = [
  {
    id: "github_issues",
    name: "GitHub Issues (bounty-labeled)",
    type: "github",
    enabled: true,
    reliabilitySeed: 90,
    endpoint: "https://api.github.com/search/issues?q=label:bounty+state:open&...",
    notes: "Public GitHub Search API. No token required for low-volume reads (60 req/hour per IP).",
  },
  // ... 3 more
];
```

### Source fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Stable identifier (used as the `source` field on Opportunity rows). |
| `name` | string | Human-readable name shown in the dashboard. |
| `type` | `"github" \| "mock" \| "rss" \| "api" \| "web"` | Determines which scanner adapter is invoked. |
| `enabled` | boolean | If false, the source is skipped during discovery. |
| `reliabilitySeed` | number (0-100) | Starting `SourceReputation.reliability` (spec §22). Updated at runtime as outcomes are recorded. |
| `endpoint` | string (optional) | URL for HTTP-based sources. |
| `notes` | string (optional) | Operator-facing documentation. |

### Default sources (4)

| ID | Type | Reliability Seed | Purpose |
|---|---|---|---|
| `github_issues` | github | 90 | GitHub Search API, `label:bounty` issues |
| `github_help_wanted` | github | 80 | GitHub Search API, `label:help-wanted` issues |
| `mock_bounties` | mock | 70 | Deterministic seed opportunities (12 legit + 2 scams) |
| `mock_hackathons` | mock | 65 | Simulated hackathon prize pools |

### `AGENT_CAPABLE_SKILLS` array

The skills the agent can credibly offer. Used by the Research Agent to
estimate `probability_of_success` per opportunity and by the Economics
Agent to compute `agentSkillMatch` (fraction of `skillsRequired` the
agent can offer).

```typescript
export const AGENT_CAPABLE_SKILLS = [
  "typescript", "javascript", "react", "nextjs", "node",
  "python", "solidity", "rust", "move", "sql", "prisma",
  "tailwind", "documentation", "testing", "ci-cd",
  "security-review", "smart-contract-audit", "devops", "data-analysis",
];
```

### `PROHIBITED_PATTERNS` array

Regex patterns that match content the agent will NEVER pursue (spec §3
prohibition perimeter). Each match adds +40 to the scam `riskScore`
(critical signal). Patterns cover:

- Wash trade, fake referral, engagement bot
- Stolen credential, account bypass, sybil attack
- "free money no work", "guaranteed profit"
- "private key required", "seed phrase required"

```typescript
export const PROHIBITED_PATTERNS: RegExp[] = [
  /wash\s*trad/i,
  /fake\s*referr/i,
  /engagement\s*bot/i,
  /stolen\s*credential/i,
  /account\s*bypass/i,
  /sybil\s*attack/i,
  /free\s*money\s*no\s*work/i,
  /guaranteed\s*profit/i,
  /private\s*key\s*required/i,
  /seed\s*phrase\s*required/i,
];
```

---

## 3. `src/config/providers.ts`

[`src/config/providers.ts`](../src/config/providers.ts) defines the
LLM provider configuration: base URLs, env var names, seed models,
exploration ratio, and budget limits.

### `PROVIDER_BASE_URL`

```typescript
export const PROVIDER_BASE_URL: Record<Provider, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  groq: "https://api.groq.com/openai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  zai: "https://api.z.ai/api/paas/v4",
};
```

### `PROVIDER_ENV_KEY`

Maps each provider to the env var that holds its API key. All are
OPTIONAL — when absent, the system falls back to the Z.AI SDK.

```typescript
export const PROVIDER_ENV_KEY: Record<Provider, string> = {
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  zai: "ZAI_API_KEY",
};
```

### `SEED_MODELS` (6 models)

The seed registry. Capabilities are 0..10 (calibrated against published
benchmarks). These are starting estimates only — the adaptive router
overrides them with real-world outcomes via the `ModelPerformance`
table.

| Model ID | Provider | Role | Specialty |
|---|---|---|---|
| `zai/glm-4.6` | zai | primary | All-round reasoning + coding (always-on in this env) |
| `openrouter/auto` | openrouter | primary | Auto-routed across many models |
| `gemini/gemini-2.0-flash` | gemini | secondary | Web research, fast turnaround |
| `groq/llama-3.3-70b-versatile` | groq | primary | Low latency (Llama 3.3 70B) |
| `cerebras/llama-3.1-70b` | cerebras | exploration | Ultra-low latency inference |
| `gemini/gemini-2.5-pro` | gemini | reviewer | Independent review (different model from primary) |

Each model has:

```typescript
{
  model_id: string;
  provider: Provider;
  api_type: "openai-compatible" | "gemini" | "zai";
  enabled: boolean;
  role: "primary" | "secondary" | "reviewer" | "exploration" | "disabled";
  status: "healthy" | "degraded" | "unhealthy" | "blacklisted";
  capabilities: ModelCapabilities;  // reasoning, coding, research, web_research, web3, security, writing, tool_use, structured_output (0..10)
  performance: ModelPerformance;    // success_rate, average_quality, average_latency, average_tokens, failure_rate
  limits: ModelLimits;              // requests_per_minute, tokens_per_minute, daily_requests, daily_tokens
  earnings_contribution_usd: number;
}
```

### `ROUTING_EXPLORATION`

```typescript
export const ROUTING_EXPLORATION = {
  exploit_best: 0.8,        // 80% — use currently best-performing model
  explore_promising: 0.15,  // 15% — test promising alternatives
  experiment_unknown: 0.05, // 5% — try unknown / new models
};
```

### `BUDGET_LIMITS`

```typescript
export const BUDGET_LIMITS = {
  dailyLlmTokens: Number(process.env.DAILY_LLM_TOKENS ?? 250000),
  hourlyLlmTokens: Number(process.env.HOURLY_LLM_TOKENS ?? 40000),
  perTaskLlmTokens: Number(process.env.PER_TASK_LLM_TOKENS ?? 8000),
  dailyWebRequests: Number(process.env.DAILY_WEB_REQUESTS ?? 500),
  dailyRpcRequests: Number(process.env.DAILY_RPC_REQUESTS ?? 1000),
};
```

All overridable via env vars.

---

## 4. `prisma/schema.prisma`

[`prisma/schema.prisma`](../prisma/schema.prisma) defines the database
schema. 13 active models + 2 legacy compatibility models.

### Core lifecycle

| Model | Purpose |
|---|---|
| `Opportunity` | Canonical normalized opportunity (spec §5, §6, §7, §8, §9). Unique on `canonicalId`. |
| `Task` | A unit of work performed by a specialist agent (spec §4M). |
| `AgentEvent` | Append-only event log (spec §17, §28). |

### Economics

| Model | Purpose |
|---|---|
| `Earning` | Verified or expected earning entry (spec §14 — never mix). |
| `Transaction` | On-chain transactions observed on monitored wallets. Unique on `[chain, txHash]`. |
| `StrategyStat` | Per-strategy learning stats (spec §15, §16). Unique on `strategy`. |
| `SourceReputation` | Reliability score per source (spec §22). Unique on `source`. |

### LLM registry

| Model | Purpose |
|---|---|
| `ModelRecord` | LLM model registry (spec §4C-§4R). Unique on `modelId`. |
| `ModelPerformance` | Per-task-type stats for adaptive routing. Unique on `[modelId, taskType]`. |

### Human control

| Model | Purpose |
|---|---|
| `Approval` | Human approval queue (spec §11, §25). |
| `IdempotencyRecord` | Prevents duplicate external actions (spec §30). Unique on `executionId`. |
| `BudgetUsage` | Daily/hourly budget tracker (spec §27). Unique on `period`. |
| `AgentState` | Singleton persisted state (kill switch, autonomy mode, last cycle). |

### Schema changes

After any schema change:

```bash
bun run db:push     # apply to SQLite
bun run db:generate # regenerate the Prisma client
```

For production with Postgres / MySQL:

```bash
bun run db:migrate dev --name your_migration_name
```

---

## 5. How to add a new wallet

1. Open [`src/config/wallets.ts`](../src/config/wallets.ts).
2. Append to the `WALLETS` array:

```typescript
{
  label: "My Polygon Wallet",
  chain: "polygon",  // must be one of the Chain union members
  address: "0xMyAddress...",
  explorer: "https://polygonscan.com",
},
```

3. If the chain is `polygon` / `bsc` / `arbitrum` / `optimism`, you'll
   need to register an EVM-compatible adapter in
   [`src/lib/wallet/adapters/index.ts`](../src/lib/wallet/adapters/index.ts).
   The existing EVM adapter handles Ethereum mainnet via Blockscout;
   the Blockscout API is multi-chain, so you can extend it by passing
   the right base URL.

4. If the chain is new (not EVM-compatible), implement a new adapter
   module under [`src/lib/wallet/adapters/`](../src/lib/wallet/adapters/)
   following the existing patterns (8s AbortController timeout, never
   throws, `recordRpcRequest` before fetch, returns zero-balance
   `WalletBalance` on failure).

5. Restart the dev server. The next `refreshWallets()` call will
   include your new wallet.

---

## 6. How to add a new opportunity source

1. Open [`src/config/sources.ts`](../src/config/sources.ts).
2. Append to the `SOURCES` array:

```typescript
{
  id: "gitcoin_grants",
  name: "Gitcoin Grants Round",
  type: "api",   // or "rss" or "web"
  enabled: true,
  reliabilitySeed: 85,
  endpoint: "https://grants-stack-indexer-v2.gitcoin.co/graphql",
  notes: "Gitcoin Grants stack indexer (public GraphQL).",
},
```

3. Implement the scanner adapter. If `type: "github"`, the existing
   `scanGitHubBounties` in
   [`src/lib/agent/scanners/github-scanner.ts`](../src/lib/agent/scanners/github-scanner.ts)
   handles it (the `endpoint` is the GitHub Search URL).

   If `type: "mock"`, the existing `scanMockOpportunities` handles
   it. (Note: the mock scanner currently returns the same 14
   opportunities for every `mock`-type source — they dedup via
   canonical id.)

   If `type: "rss"` / `"api"` / `"web"`, you need a new scanner:
   - Create `src/lib/agent/scanners/gitcoin-scanner.ts` that exports
     `scanGitcoinGrants(opts)` returning `{ opportunities: RawOpportunityInput[], source, fetchedAt, error? }`.
   - Wire it into `runDiscoveryCycle` in
     [`src/lib/agent/scanners/index.ts`](../src/lib/agent/scanners/index.ts)
     (the dispatcher switch on `source.type`).

4. The scanner contract is:
   - Never throws — always return an object even on failure.
   - Calls `BudgetManager.recordWebRequest()` before every network call.
   - Returns `RawOpportunityInput` shapes that `normalizeOpportunity`
     can canonicalize.

5. Restart the dev server. The next discovery cycle will include
   your new source.

---

## 7. How to add a new LLM provider

1. Add the provider to the `Provider` union in
   [`src/lib/agent/types.ts`](../src/lib/agent/types.ts):

```typescript
export type Provider = "openrouter" | "gemini" | "groq" | "cerebras" | "zai" | "myprovider";
```

2. Add the provider to `PROVIDER_BASE_URL` and `PROVIDER_ENV_KEY` in
   [`src/config/providers.ts`](../src/config/providers.ts):

```typescript
export const PROVIDER_BASE_URL: Record<Provider, string> = {
  // ...
  myprovider: "https://api.myprovider.com/v1",
};

export const PROVIDER_ENV_KEY: Record<Provider, string> = {
  // ...
  myprovider: "MYPROVIDER_API_KEY",
};
```

3. Add a seed model in `SEED_MODELS` with the new provider:

```typescript
{
  model_id: "myprovider/my-model",
  provider: "myprovider",
  api_type: "openai-compatible",  // most providers are OpenAI-compatible
  enabled: true,
  role: "primary",
  status: "healthy",
  capabilities: { reasoning: 8.5, coding: 8.0, ... },
  performance: { success_rate: 0.88, ... },
  limits: { requests_per_minute: 30, ... },
  earnings_contribution_usd: 0,
},
```

4. If the provider is OpenAI-compatible (most are), no further code
   changes are needed — `callOpenAiCompatible` in
   [`src/lib/llm/provider.ts`](../src/lib/llm/provider.ts) handles
   it. If the provider has a custom API, add a `callMyProvider`
   function and wire it into the `dispatchToProvider` switch.

5. Set the env var: `MYPROVIDER_API_KEY=...`

6. Restart the dev server. The next API call will bootstrap the new
   model into the registry.

---

## 8. How to change budget limits

### Via env vars (recommended)

Set any of:

```bash
DAILY_LLM_TOKENS=500000      # default 250000
HOURLY_LLM_TOKENS=80000       # default 40000
PER_TASK_LLM_TOKENS=16000     # default 8000
DAILY_WEB_REQUESTS=1000       # default 500
DAILY_RPC_REQUESTS=2000        # default 1000
```

Restart the dev server. The `BUDGET_LIMITS` constant in
[`src/config/providers.ts`](../src/config/providers.ts) reads these
on module load.

### Via code

Edit `BUDGET_LIMITS` directly in
[`src/config/providers.ts`](../src/config/providers.ts) to change
the defaults.

### Important: per-period keys

The budget tracker uses period-key-based upserts:
- `day:YYYY-MM-DD` — UTC daily aggregate
- `hour:YYYY-MM-DD-HH` — UTC hourly aggregate

Changing the limits does NOT reset the current period. The existing
`BudgetUsage` rows persist with the old values; the new limits apply
to the comparison going forward. To force a reset, delete the
`BudgetUsage` rows for the current period:

```bash
bunx prisma studio
# Navigate to BudgetUsage, delete rows where period starts with today's date
```

Or via SQL:

```sql
DELETE FROM BudgetUsage WHERE period LIKE 'day:2024-12-12%';
```

---

## 9. How to change autonomy mode

### Via API (recommended)

```bash
curl -X POST https://your-app/api/agent/autonomy \
  -H "Content-Type: application/json" \
  -d '{"mode":"semi"}'
```

### Via dashboard

In the header, use the **Autonomy** dropdown.

### Valid modes

| Mode | Allows |
|---|---|
| `observe` | Discovery + verification only. No execution. Level-3 required for everything above read. |
| `assist` | Low-risk execution (level 1) auto-allowed. |
| `semi` | Moderate-risk (level 2) auto-allowed; level 3 still requires approval. |
| `full` | Everything except level-3 financial actions (which ALWAYS require approval). |

See [OPERATIONS.md](./OPERATIONS.md#autonomy-modes) for what each
mode allows in detail.

### Via DB (advanced)

```sql
UPDATE AgentState SET autonomyMode = 'semi' WHERE id = 'singleton';
```

The 2-second TTL cache on `AgentState` will pick this up on the next
read.

---

## 10. How to add a new strategy

### Step 1: Add to `CANONICAL_STRATEGIES`

Open [`src/lib/economics/strategy-stats.ts`](../src/lib/economics/strategy-stats.ts)
and add your strategy to the array:

```typescript
export const CANONICAL_STRATEGIES = [
  "github_bounty",
  "hackathon",
  // ... 9 more
  "your_new_strategy",   // <-- add here
] as const;
```

### Step 2: Add to `OpportunityCategory` (if it's a new category)

Open [`src/lib/agent/types.ts`](../src/lib/agent/types.ts) and add
the category to the union:

```typescript
export type OpportunityCategory =
  | "bounty"
  // ...
  | "your_new_strategy";
```

### Step 3: Add reward cap (if needed)

Open [`src/lib/security/scam-detection.ts`](../src/lib/security/scam-detection.ts)
and add the cap to `REWARD_CAP_BY_CATEGORY`:

```typescript
const REWARD_CAP_BY_CATEGORY: Record<OpportunityCategory, number> = {
  // ...
  your_new_strategy: 20_000,
};
```

### Step 4: Restart the dev server

The next `bootstrapAgent()` call will upsert the new strategy row
into the `StrategyStat` table with zero counts. The exploration
bonus in `rankStrategies()` ensures it gets tried at least 3 times
before being ranked on raw `avgHourly`.

### Step 5: Optional — extend the mock scanner

If you want to test the new strategy with deterministic seed data,
add a mock opportunity with `category: "your_new_strategy"` in
[`src/lib/agent/scanners/mock-scanner.ts`](../src/lib/agent/scanners/mock-scanner.ts).

---

## 11. Environment variable reference

### Required

| Env var | Default | Description |
|---|---|---|
| `DATABASE_URL` | (none) | Prisma database URL. SQLite: `file:./db/custom.db`. Postgres: `postgresql://...`. |

### Optional: LLM API keys

| Env var | Provider | Get from |
|---|---|---|
| `OPENROUTER_API_KEY` | openrouter | [openrouter.ai](https://openrouter.ai/) |
| `GEMINI_API_KEY` | gemini | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| `GROQ_API_KEY` | groq | [console.groq.com](https://console.groq.com/keys) |
| `CEREBRAS_API_KEY` | cerebras | [cloud.cerebras.ai](https://cloud.cerebras.ai/) |
| `ZAI_API_KEY` | zai | (escape hatch; SDK reads `/etc/.z-ai-config` by default) |

### Optional: budget overrides

| Env var | Default | Description |
|---|---|---|
| `DAILY_LLM_TOKENS` | `250000` | Max LLM tokens per UTC day |
| `HOURLY_LLM_TOKENS` | `40000` | Max LLM tokens per UTC hour |
| `PER_TASK_LLM_TOKENS` | `8000` | Max LLM tokens per single call |
| `DAILY_WEB_REQUESTS` | `500` | Max HTTP requests per UTC day |
| `DAILY_RPC_REQUESTS` | `1000` | Max RPC calls per UTC day |

### Optional: kill switch

| Env var | Default | Description |
|---|---|---|
| `PAUSE_AGENT` | (unset) | If `true`, agent starts paused. Useful for CI / staging. |

### Optional: wallet adapter overrides

| Env var | Default | Description |
|---|---|---|
| `BLOCKSCOUT_BASE_URL` | `https://eth.blockscout.com` | Ethereum mainnet explorer API |
| `BLOCKCHAIN_INFO_BASE_URL` | `https://blockchain.info` | Bitcoin explorer API |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana JSON-RPC endpoint |
| `TRONGRID_BASE_URL` | `https://api.trongrid.io` | TronGrid API base |
| `RONIN_RPC_URL` | `https://api.roninchain.com/rpc` | Ronin JSON-RPC endpoint |
| `PROJECT_ROOT` | `process.cwd()` | Where the kill switch looks for `PAUSE` / `STOP` files |

### Optional: Next.js

| Env var | Default | Description |
|---|---|---|
| `PORT` | `3000` | Dev server port |
| `NODE_ENV` | `development` | `production` for production builds |

---

## Cross-references

- **Architecture** — see [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Setup & deployment** — see [SETUP.md](./SETUP.md)
- **Operations** — see [OPERATIONS.md](./OPERATIONS.md)
- **Strategies** — see [STRATEGIES.md](./STRATEGIES.md)
- **Security** — see [SECURITY.md](./SECURITY.md)
