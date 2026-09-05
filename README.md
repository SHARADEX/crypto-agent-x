# CryptoEarn Agent

**Autonomous Zero-Cost Crypto Earning Agent** — a Next.js 16 multi-agent
LLM orchestrator that discovers, evaluates, executes, and verifies
crypto earning opportunities without spending real money on LLM tokens
or signing blockchain transactions.

> This is **not a chatbot.** The agent autonomously pursues crypto
> bounties, hackathons, grants, OSS contributions, and content
> rewards. Every external action is gated by a deterministic policy
> engine; the LLM proposes, deterministic code decides.

---

## What it is

CryptoEarn Agent is a single deployable Next.js 16 app that bundles:

- A **multi-agent LLM orchestrator** (11 specialist agents) that walks
  every opportunity through an 11-stage lifecycle (DISCOVER -> NORMALIZE
  -> VERIFY -> SCORE -> PLAN -> APPROVAL -> EXECUTE -> VERIFY RESULT ->
  VERIFY PAYMENT -> RECORD PROFIT -> LEARN).
- A **read-only wallet monitor** for 5 chains (Ethereum, Bitcoin,
  Solana, Tron, Ronin) that never stores private keys, never signs
  transactions, and verifies payments on-chain.
- A **real-time operator dashboard** with 10 tabs covering Overview,
  Opportunities, Wallets, Model Routing, Strategies, Ledger,
  Approvals, Tasks, Events, and Architecture.
- A **deterministic economics engine** that computes every dollar
  value, probability, and ranking score the agent cites in its final
  report (the LLM is never given a path to do final arithmetic).
- A **zero-cost LLM stack** with circuit breakers, budget caps, an
  adaptive model router, and fallbacks across OpenRouter, Gemini,
  Groq, Cerebras, and the Z.AI SDK.

All written in TypeScript, all running inside the Next.js server
runtime, all deployable to Vercel / Netlify / Cloudflare Pages with
a single git push.

---

## What it does (key features)

- **Multi-agent orchestration** — 11 specialist agents (Scout,
  Research, Verification, Economics, Coding, Web3, Writing, Security,
  Execution, Payment, Review) coordinated by a central orchestrator
  that is the only component creating Task rows.
- **4-level model routing** — Deterministic (LEVEL 1), Cheap
  Classifier (LEVEL 2), Specialist (LEVEL 3), Multi-Model Panel
  (LEVEL 4). Adaptive scoring with 80/15/5 exploration/exploitation.
- **Deterministic economic engine** — every dollar value computed
  from numeric inputs the orchestrator collected (spec §8 hard
  guarantee that the LLM never does final arithmetic).
- **Read-only wallet system** — 5 monitored public addresses, never
  stores private keys, never signs, verifies payments via on-chain
  transaction scanning.
- **Defense-in-depth security** — 6 deterministic boundaries
  (prompt-injection sanitiser, URL validator, code-safety inspector,
  scam detector, policy engine, kill switch + budget caps +
  idempotency).
- **Strategy learning loop** — 11 canonical strategies tracked via
  per-strategy stats (discovered, attempted, completed, failed,
  avgHourly, successRate) with a 70/20/10 exploration/exploitation
  split.
- **Real-time dashboard** — TanStack Query polling, Framer Motion
  tab transitions, dark mode default, full keyboard / screen-reader
  accessibility.
- **Kill switch** — 3 independent mechanisms (DB flag, filesystem
  marker, env var) OR-ed together. Operator can halt the agent
  instantly without DB access.

For the full architecture, see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## Live demo

![CryptoEarn Agent Dashboard](./public/agent-logo.png)

The dashboard renders at `/` and is the operator's primary control
panel. Open it in your browser after running `bun run dev` to see
the 10 tabs and live updates.

---

## Quick start

The project is designed so that **no CLI or git is required** for
setup — you can do everything via the GitHub web UI (drag-and-drop)
and your hosting provider's dashboard.

### Local development

```bash
# 1. Download the project (via GitHub web UI -> Download ZIP, or git clone)

# 2. Install dependencies
bun install

# 3. Push the database schema (SQLite via Prisma)
bun run db:push

# 4. Start the dev server
bun run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

The first API call triggers `bootstrapAgent()` which seeds the
`ModelRecord` table (6 free-tier models), the `StrategyStat` table
(11 canonical strategies), and runs an initial discovery cycle if
the opportunity DB is empty.

For the full setup walkthrough including Vercel / Netlify /
Cloudflare Pages deployment, see [docs/SETUP.md](./docs/SETUP.md).

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.1.1 (App Router) |
| Language | TypeScript 5 |
| Styling | Tailwind CSS 4 |
| UI components | shadcn/ui (60+ Radix primitives) |
| Charts | Recharts 2.15 |
| Data fetching | TanStack Query 5 |
| Animations | Framer Motion 12 |
| Database | Prisma 6 + SQLite (default) / Postgres (production) |
| LLM SDK | z-ai-web-dev-sdk 0.0.18 (default backend) |
| LLM providers | OpenRouter, Gemini, Groq, Cerebras (all optional) |
| Validation | Zod 4 |
| Runtime | Bun (package manager) / Node.js 18+ |
| Deployment | Vercel (recommended) / Netlify / Cloudflare Pages |

---

## Architecture overview

The CryptoEarn Agent is one Next.js 16 app server with three logical
layers:

```
+------------------------------------------------------------------+
|  Dashboard (browser) — TanStack Query polls /api/* every 5-60s   |
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|  Next.js 16 App Router (server runtime) — 25 route handlers      |
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|  Orchestrator + 11 Specialist Agents — plain TypeScript modules   |
+----+-----------+-------------+--------------+-------------+------+
     |           |             |              |             |
     v           v             v              v             v
+---------+ +----------+ +-----------+ +------------+ +-----------+
| Wallet  | | LLM      | | Economics | | Security  | | Scanners  |
| monitor | | router + | | engine    | | engine     | | (GitHub + |
| (RO)    | | provider | | (pure)    | | (determin.)| | mock)    |
+---------+ +----------+ +-----------+ +------------+ +-----------+
     |           |             |              |             |
     v           v             v              v             v
+------------------------------------------------------------------+
|  Prisma (SQLite) — single source of truth for all persistent     |
|  state: opportunities, tasks, earnings, transactions, approvals, |
|  events, strategies, models, budget, agent state.                |
+------------------------------------------------------------------+
```

For the full architecture (11-stage lifecycle, multi-agent
orchestration, 4-level model routing, security boundaries, file
structure, data flow), see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## Security summary

The agent follows six security design principles:

1. **Defense in depth** — 6 deterministic boundaries every external
   input must cross before any external action is allowed.
2. **Least privilege** — wallet subsystem is read-only; no signing
   code path anywhere.
3. **No secrets in the repository** — `.env` ships only `DATABASE_URL`;
   all LLM API keys are read from `process.env` at runtime.
4. **Deterministic overrides LLM** — the LLM proposes; deterministic
   code decides. The LLM has no path around the scam-risk hard cap,
   the policy engine, or the deterministic economic math.
5. **Default-safe** — agent starts paused; default autonomy mode is
   `observe` (discovery only, no execution).
6. **Audit everything** — every state transition logged to the
   append-only `AgentEvent` table.

For the full security architecture, see [docs/SECURITY.md](./docs/SECURITY.md).

For the per-scenario hostile audit (15 scenarios from spec §41),
see [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md).

---

## Configuration

All configuration lives in three TypeScript files plus the Prisma
schema:

| File | Purpose |
|---|---|
| [`src/config/wallets.ts`](./src/config/wallets.ts) | Monitored wallet addresses (5 chains) |
| [`src/config/sources.ts`](./src/config/sources.ts) | Opportunity sources, agent skills, prohibited patterns |
| [`src/config/providers.ts`](./src/config/providers.ts) | LLM providers, seed models, exploration ratios, budget limits |
| [`prisma/schema.prisma`](./prisma/schema.prisma) | 13 Prisma models (Opportunity, Task, Earning, etc.) |

Most runtime behavior is overridable via env vars (`DAILY_LLM_TOKENS`,
`HOURLY_LLM_TOKENS`, `PER_TASK_LLM_TOKENS`, `DAILY_WEB_REQUESTS`,
`DAILY_RPC_REQUESTS`, `PAUSE_AGENT`, etc.).

For the full configuration reference (how to add a wallet, add a
source, add a provider, change budget limits, add a strategy), see
[docs/CONFIGURATION.md](./docs/CONFIGURATION.md).

---

## API reference

The agent exposes 25 API endpoints under `/api/`:

| Group | Endpoints |
|---|---|
| Agent Control | status, pause, resume, emergency-stop, emergency-reset, autonomy, run-cycle |
| Opportunities | list, get, patch, process, verify-payment, seed |
| Wallets | balances, transactions (GET + POST scan) |
| Approvals | list, decide |
| Ledger | list, totals |
| Strategies | ranked list |
| Models | list, patch |
| Analytics | unified dashboard payload |
| Tasks | list, get |
| Events | filterable event log |

All endpoints are `force-dynamic` and return
`Cache-Control: no-store`. POST bodies are parsed defensively; missing
or invalid JSON never throws.

For the full API reference with curl examples and response shapes,
see [docs/API.md](./docs/API.md).

---

## Project structure

```
cryptoearn-agent/
+-- src/
|   +-- app/
|   |   +-- api/                   # 25 route handlers (Next.js 16 App Router)
|   |   +-- layout.tsx
|   |   +-- page.tsx               # server wrapper -> dashboard
|   +-- components/
|   |   +-- dashboard/             # 18 dashboard components
|   |   +-- ui/                    # 60+ shadcn primitives
|   +-- config/                    # wallets.ts, sources.ts, providers.ts
|   +-- lib/
|   |   +-- agent/                 # types, normalize, scorer, verification, events, state, scanners/
|   |   +-- agents/                # 11 specialist agents
|   |   +-- economics/             # engine, strategy-stats, ledger
|   |   +-- llm/                   # registry, router, provider, circuit-breaker, deterministic
|   |   +-- wallet/                # monitor, payment-verifier, adapters/
|   |   +-- security/              # prompt-injection, url-validator, code-safety, scam-detection, threat-model
|   |   +-- orchestrator/          # orchestrator, loop, bootstrap
|   |   +-- budget/                # BudgetManager
|   |   +-- policy.ts              # deterministic policy engine
|   |   +-- kill-switch.ts         # OR-ed DB + filesystem + env
|   |   +-- db.ts                  # Prisma client singleton
|   +-- hooks/
+-- prisma/
|   +-- schema.prisma             # 13 active models + 2 legacy
+-- public/
|   +-- agent-logo.png
+-- docs/                          # this documentation suite
+-- package.json
+-- next.config.ts
+-- tailwind.config.ts
+-- eslint.config.mjs
+-- .env                           # DATABASE_URL only
+-- worklog.md                     # shared handover log
```

---

## Roadmap / Status

The project implements the full spec §38 documentation suite. The
following subsystems are production-quality:

- Discovery + normalization + verification + scoring
- Economic engine (spec §8 critical test passes)
- Strategy learning (11 canonical strategies)
- Wallet monitoring (5 chains, read-only)
- Payment verification (on-chain tx matching)
- LLM router (4 levels, adaptive scoring, circuit breaker)
- Multi-agent orchestrator + 10-step autonomous loop
- Security engine (prompt-injection, URL, code-safety, scam detection)
- 25 API routes
- Dashboard (10 tabs, TanStack Query, dark mode default)

### Known follow-ups

- The Execution Agent is currently SIMULATED — it marks opportunities
  `executed` with `externalRef=simulated:...` but doesn't actually
  submit PRs. Real submission adapters (GitHub PR API, hackathon
  submission endpoints) need to be wired in by a future task.
- The EVM adapter currently fetches native ETH transfers only —
  ERC-20 (USDC, USDT) token transfers need a separate Blockscout
  endpoint.
- The Ronin adapter can't list transactions (the public Ronin RPC
  doesn't expose a key-less tx-list endpoint). The verifier falls
  back to EVM/Solana/Tron/BTC matching.
- The OpenAI-compatible path for Gemini uses
  `/openai/chat/completions` on the v1beta base URL — Google has
  historically moved this endpoint.

See the per-task worklog entries in [`worklog.md`](./worklog.md) for
the full details.

---

## License

MIT License. See [LICENSE](./LICENSE) for details (or assume MIT if
no LICENSE file is present).

---

## Important disclaimers

- **This is a simulation / educational system.** Do not connect real
  wallets with significant funds without auditing the code first.
  The execution agent is currently SIMULATED; the earnings shown in
  the dashboard may be simulated for demonstration purposes (the
  mock scanner generates mock opportunities with mock rewards).

- **The agent NEVER stores private keys.** All wallet operations are
  read-only. There is no signing code path anywhere in the
  repository.

- **Earnings shown in the dashboard may be simulated for
  demonstration purposes.** The mock scanner generates mock
  opportunities with mock rewards. Verified earnings require real
  on-chain transactions landing on monitored wallets.

- **Always verify opportunities independently before participating.**
  The agent's scam detection is conservative but not infallible.
  A sophisticated scam could evade the regex patterns. The policy
  engine requires human approval for level-3 actions exactly
  because the agent cannot perfectly distinguish legitimate from
  hostile opportunities.

- **The operators are responsible for complying with all applicable
  laws and platform terms of service.** The agent discovers
  opportunities from public sources (GitHub, hackathons, etc.) but
  the operator is responsible for ensuring participation complies
  with the source platform's terms (e.g. GitHub's Terms of Service,
  hackathon rules, tax obligations in the operator's jurisdiction).

- **No warranty.** This software is provided "as is" without
  warranty of any kind. The authors are not liable for any damages
  arising from its use.

---

## Documentation

| Document | Description |
|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System overview, 11-stage lifecycle, multi-agent orchestrator, 4-level model routing, file structure, data flow |
| [docs/SECURITY.md](./docs/SECURITY.md) | Security design principles, threat model summary, trust boundaries, anti-prompt-injection, scam detection, code safety, URL validation, wallet security, policy engine, kill switch, budget limits, secret management, what to do if compromised |
| [docs/SETUP.md](./docs/SETUP.md) | Prerequisites, local development, environment variables, database setup, optional free-tier API keys, first run, deploying to Vercel / Netlify / Cloudflare Pages |
| [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) | All configuration files explained (wallets, sources, providers, schema), how to add a wallet / source / provider / strategy, environment variable reference |
| [docs/OPERATIONS.md](./docs/OPERATIONS.md) | Day-to-day operations: starting/stopping, autonomy modes, the autonomous loop, approving pending tasks, monitoring budgets and wallets, reading the event log, interpreting the dashboard, manual operations, handling kill-switch activation |
| [docs/STRATEGIES.md](./docs/STRATEGIES.md) | The 11 supported opportunity categories, strategy learning loop, exploration vs exploitation (70/20/10), how to add a custom strategy, expected outcomes per strategy |
| [docs/API.md](./docs/API.md) | Complete API reference for all 25 endpoints with method, path, query params, body, response shape, curl examples |
| [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) | Common issues: STOPPED status, $0 balances, blacklisted models, budget exceeded, no opportunities, LLM failures, payment verification, database locked, hydration mismatch, debugging tips |
| [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md) | Full hostile audit (spec §41): 15 scenarios with description, attack vector, defense in place, how to test it, residual risk. Attack surface map and trust boundaries. |
