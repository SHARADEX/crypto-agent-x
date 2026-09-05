# Setup

This document walks you through getting the CryptoEarn Agent running
locally and deploying it to a hosting provider.

The project is designed so that **no CLI or git is required**. You can
do the entire setup via the GitHub web UI (drag-and-drop the project
folder) and the hosting provider's dashboard.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Local development](#2-local-development)
3. [Environment variables](#3-environment-variables)
4. [Database setup](#4-database-setup)
5. [Optional: real free-tier API keys](#5-optional-real-free-tier-api-keys)
6. [First run](#6-first-run)
7. [Deploying to Vercel](#7-deploying-to-vercel)
8. [Deploying to Netlify](#8-deploying-to-netlify)
9. [Deploying to Cloudflare Pages](#9-deploying-to-cloudflare-pages)
10. [Troubleshooting setup](#10-troubleshooting-setup)

---

## 1. Prerequisites

### Required

| Tool | Version | Why |
|---|---|---|
| **Node.js** | 18+ | Next.js 16 runtime requirement |
| **Bun** | latest | Used as the package manager + script runner. Faster than npm/yarn; you can substitute npm/yarn/pnpm if you prefer. |

That's it. You do NOT need:

- Git (you can download a ZIP from GitHub instead).
- Docker (the agent runs in the Next.js server runtime).
- A separate database server (SQLite via Prisma is bundled).
- Python (the spec's reference Python autonomous-agent design is
  preserved conceptually; all modules are TypeScript).
- Any blockchain node or RPC provider account (all wallet adapters
  use free public read-only endpoints).

### Where to get Bun

```bash
# macOS (Homebrew)
brew tap oven-sh/bun
brew install bun

# Linux / WSL
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

Verify:

```bash
bun --version   # should print e.g. 1.1.x
```

If you prefer npm/yarn/pnpm, substitute accordingly — every command
below has a direct equivalent.

---

## 2. Local development

### Option A: Download as ZIP from GitHub web UI

1. Go to your GitHub repository's web page.
2. Click the green **Code** button -> **Download ZIP**.
3. Unzip the archive.
4. Open a terminal in the unzipped folder.

### Option B: Clone via the GitHub web UI's "Open with GitHub Desktop"

If you have GitHub Desktop installed, this clones the repo locally.

### Install dependencies

```bash
bun install
```

This installs all 80+ dependencies listed in `package.json`. Expect
30-60 seconds.

### Push the database schema

```bash
bun run db:push
```

This runs `prisma db push --accept-data-loss` against the SQLite
database file at `db/custom.db` (path from `.env`'s `DATABASE_URL`).
Creates the 13 Prisma tables (`Opportunity`, `Task`, `Earning`,
`Transaction`, `Approval`, `AgentEvent`, `StrategyStat`, `ModelRecord`,
`ModelPerformance`, `AgentState`, `BudgetUsage`, `IdempotencyRecord`,
`SourceReputation`).

### Start the dev server

```bash
bun run dev
```

This runs `next dev -p 3000`. The server starts on
[http://localhost:3000](http://localhost:3000) and tees its output to
`dev.log` so you can grep it later.

You should see output like:

```
   ▲ Next.js 16.1.1
   - Local:        http://localhost:3000
   - Network:      http://192.168.x.x:3000

 ✓ Ready in 1234ms
```

### Open the dashboard

Open [http://localhost:3000](http://localhost:3000) in your browser.

You should see the CryptoEarn Agent dashboard with 10 tabs:
Overview, Opportunities, Wallets, Model Routing, Strategies, Ledger,
Approvals, Tasks, Events, Architecture.

The first API request triggers `bootstrapAgent()` (idempotent,
guarded by a module-level flag) which:
1. Seeds the `ModelRecord` table with the 6 free-tier models.
2. Seeds the `StrategyStat` table with the 11 canonical strategies.
3. Ensures the `AgentState` singleton exists (in `paused` state —
   the operator must explicitly start the agent).
4. Runs an initial discovery cycle IF the opportunity DB is empty.

---

## 3. Environment variables

ALL environment variables are OPTIONAL. The system works out of the
box with zero configuration because the Z.AI SDK is provisioned in
this environment.

### Required for local dev

```bash
# .env (already in the repo)
DATABASE_URL=file:/home/z/my-project/db/custom.db
```

This is the only env var that ships in the repo. On Windows you
might use a different path: `DATABASE_URL=file:./db/custom.db`.

### Optional: LLM API keys

```bash
# .env.local (NOT in the repo — create this yourself)
OPENROUTER_API_KEY=sk-or-v1-...
GEMINI_API_KEY=AIzaSy...
GROQ_API_KEY=gsk_...
CEREBRAS_API_KEY=csk-...
```

When absent, the system falls back to the Z.AI SDK (`z-ai-web-dev-sdk`)
which is provisioned via `/etc/.z-ai-config` in this environment. In
production on Vercel/Netlify/Cloudflare Pages you should set at
least one of these — Z.AI is a development convenience and may not
be available in your production environment.

### Optional: budget overrides

```bash
DAILY_LLM_TOKENS=250000      # default
HOURLY_LLM_TOKENS=40000        # default
PER_TASK_LLM_TOKENS=8000       # default
DAILY_WEB_REQUESTS=500         # default
DAILY_RPC_REQUESTS=1000        # default
```

Lower these if you want to be extra-conservative. Higher values risk
blowing through free-tier quotas and triggering rate limits.

### Optional: kill switch

```bash
PAUSE_AGENT=true   # pauses the agent on startup — useful for CI / staging
```

### Optional: wallet adapter overrides

```bash
BLOCKSCOUT_BASE_URL=https://eth.blockscout.com
BLOCKCHAIN_INFO_BASE_URL=https://blockchain.info
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
TRONGRID_BASE_URL=https://api.trongrid.io
RONIN_RPC_URL=https://api.roninchain.com/rpc
```

Override these only if the default endpoint is rate-limited or
deprecated in your region.

### Environment variable reference

See [CONFIGURATION.md](./CONFIGURATION.md#environment-variable-reference)
for the full table.

---

## 4. Database setup

### SQLite via Prisma (default)

The agent uses SQLite via Prisma. The database file lives at
`db/custom.db` (path from `DATABASE_URL` in `.env`).

**First-time setup:**

```bash
bun run db:push
```

This creates all 13 Prisma tables. The schema is in
[`prisma/schema.prisma`](../prisma/schema.prisma).

**Reset the database (dev only):**

```bash
bun run db:reset
```

This drops all tables and re-creates them. Useful when you've changed
the schema locally and want a fresh start.

**Generate the Prisma client:**

```bash
bun run db:generate
```

Run this after every schema change. The Prisma client is committed at
`node_modules/.prisma/client` so this is mostly a no-op on `bun install`.

**Create a migration (production):**

```bash
bun run db:migrate
```

For production deployments you typically want migrations rather than
`db:push` so schema changes are auditable. The project ships with no
migrations by default — `db:push` is sufficient for SQLite.

### Other databases

If you want to use Postgres or MySQL in production:

1. Update `DATABASE_URL` in your hosting platform's env vars:
   ```
   DATABASE_URL=postgresql://user:pass@host:5432/dbname?schema=public
   ```
2. Update `prisma/schema.prisma`:
   ```prisma
   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }
   ```
3. Run `bun run db:push` (or `bun run db:migrate dev`).

For Vercel deployments, use Vercel Postgres or Neon (both have
generous free tiers).

---

## 5. Optional: real free-tier API keys

The agent works without any API keys, but you'll get more LLM
throughput and better model diversity if you set at least one.

### OpenRouter (recommended first)

1. Go to [https://openrouter.ai/](https://openrouter.ai/).
2. Sign in with Google or GitHub.
3. Click **Keys** -> **Create Key**.
4. Copy the key (starts with `sk-or-v1-`).
5. Set `OPENROUTER_API_KEY=sk-or-v1-...` in your environment.

OpenRouter's free tier routes across many models (Llama, Mistral,
Qwen, etc.) with a generous free quota.

### Google Gemini

1. Go to [https://aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).
2. Sign in with a Google account.
3. Click **Create API Key**.
4. Copy the key (starts with `AIzaSy...`).
5. Set `GEMINI_API_KEY=AIzaSy...`.

Gemini's free tier: 15 requests/minute for `gemini-2.0-flash`,
50 requests/day for `gemini-2.5-pro`.

### Groq

1. Go to [https://console.groq.com/keys](https://console.groq.com/keys).
2. Sign in with Google or GitHub.
3. Click **Create API Key**.
4. Copy the key (starts with `gsk_`).
5. Set `GROQ_API_KEY=gsk_...`.

Groq's free tier is generous on requests but limited to Llama models.
Ultra-low latency (~400-800ms per call).

### Cerebras

1. Go to [https://cloud.cerebras.ai/](https://cloud.cerebras.ai/).
2. Sign in.
3. Click **API Keys** -> **Create API Key**.
4. Copy the key (starts with `csk-`).
5. Set `CEREBRAS_API_KEY=csk-...`.

Cerebras offers ultra-fast inference (~400ms per call) on Llama 3.1
70B. Free tier is small but sufficient for exploration.

### Z.AI SDK (default in this environment)

No setup needed. The SDK reads its config from `/etc/.z-ai-config`
(provisioned in this environment). In production, you'll need to
install the SDK and provision the config file yourself, OR rely on
the other four providers exclusively.

---

## 6. First run

Once the dev server is running on [http://localhost:3000](http://localhost:3000):

### Step 1: Verify bootstrap

The first API call to `GET /api/agent/status` triggers
`bootstrapAgent()`. Verify it ran:

```bash
curl http://localhost:3000/api/agent/status | jq '.killSwitch, .canRun'
```

You should see:

```json
{
  "killSwitch": {
    "paused": false,
    "emergencyStop": false,
    "reason": null
  },
  "canRun": {
    "canRun": true,
    "reason": "ready"
  }
}
```

### Step 2: Check opportunities

```bash
curl "http://localhost:3000/api/opportunities?limit=5" | jq '.count, .total'
```

You should see ~14 mock opportunities (deterministic seed data) plus
any real GitHub bounty issues discovered by the GitHub Search API
(60 req/hour/IP unauthenticated quota).

### Step 3: Set autonomy mode

The agent starts in `observe` mode (discovery + verification only,
no execution). To allow execution of low-risk tasks:

```bash
curl -X POST http://localhost:3000/api/agent/autonomy \
  -H "Content-Type: application/json" \
  -d '{"mode":"assist"}'
```

Valid modes: `observe`, `assist`, `semi`, `full`. See
[OPERATIONS.md](./OPERATIONS.md#autonomy-modes) for what each allows.

### Step 4: Click "Run Cycle"

In the dashboard header, click the green **Run Cycle** button. This
calls `POST /api/agent/run-cycle` with `{ cycles: 1, delayMs: 1000 }`.

You should see:

- The footer cycle counter increments.
- The Events tab shows `cycle_complete` events.
- The Opportunities tab shows status transitions (e.g.
  `discovered -> researching -> verified`).
- If you're in `assist` or higher, opportunities may advance to
  `executed` and `awaiting_payment`.

### Step 5: Approve pending tasks (if any)

If the agent encountered a level-3 action (referral, large reward
without verified payment, etc.), it would create an `Approval` row
and wait. Check the Approvals tab:

```bash
curl http://localhost:3000/api/approvals | jq
```

If there are pending approvals, click **Approve** / **Reject** /
**Skip** in the dashboard.

### Step 6: Seed fresh opportunities (optional)

If you want to force a fresh discovery pass (bypassing the 10-minute
throttle), click the **Seed New** button on the Opportunities tab.
This calls `POST /api/opportunities/seed`.

---

## 7. Deploying to Vercel

Vercel is the recommended hosting provider because the project is
built on Next.js 16 (Vercel's own framework).

### Via GitHub web UI (recommended)

1. Push the project to GitHub:
   - Go to [https://github.com/new](https://github.com/new).
   - Create a new repository (e.g. `cryptoearn-agent`).
   - Drag-and-drop the project files into the GitHub web UI's upload
     page. (Or use `git push` if you have git installed.)

2. Connect Vercel to GitHub:
   - Go to [https://vercel.com/new](https://vercel.com/new).
   - Sign in with GitHub.
   - Click **Import Project** -> select your `cryptoearn-agent` repo.
   - Vercel auto-detects Next.js 16.

3. Configure environment variables:
   - In the Vercel project settings, go to **Settings** -> **Environment Variables**.
   - Add at least `DATABASE_URL` (Vercel Postgres or Neon).
   - Optionally add `OPENROUTER_API_KEY`, `GEMINI_API_KEY`,
     `GROQ_API_KEY`, `CEREBRAS_API_KEY`.
   - Add `PAUSE_AGENT=true` if you want to deploy paused.

4. Deploy:
   - Click **Deploy**.
   - Vercel runs `bun install` + `next build` + `prisma generate`.
   - First deploy takes ~2 minutes.

5. Run `prisma db push` against the production DB:
   - Vercel doesn't auto-run Prisma migrations.
   - Either add a `postinstall` script in `package.json`, or run
     `bunx prisma db push --accept-data-loss` locally with
     `DATABASE_URL` pointing at the production DB before deploying.

6. Open the production dashboard:
   - Vercel gives you a URL like `cryptoearn-agent.vercel.app`.
   - Open it in your browser. The first request triggers
     `bootstrapAgent()` against the production DB.

### Via Vercel CLI

```bash
npm i -g vercel
vercel login
cd /path/to/cryptoearn-agent
vercel link
vercel env add DATABASE_URL
vercel env add OPENROUTER_API_KEY
# ... add others
vercel --prod
```

---

## 8. Deploying to Netlify

Netlify supports Next.js via the `@netlify/plugin-nextjs` plugin.

1. Push to GitHub (as above).
2. Go to [https://app.netlify.com/start](https://app.netlify.com/start).
3. Connect to GitHub -> select your repo.
4. Build settings:
   - **Build command**: `bun run build`
   - **Publish directory**: `.next` (auto-detected)
   - **Functions directory**: `.netlify/functions`
5. Environment variables: same as Vercel.
6. Click **Deploy site**.

Netlify's Next.js plugin handles the App Router + API routes
out of the box.

---

## 9. Deploying to Cloudflare Pages

Cloudflare Pages supports Next.js via the `@cloudflare/next-on-pages`
adapter.

1. Push to GitHub (as above).
2. Go to [https://dash.cloudflare.com/](https://dash.cloudflare.com/) -> **Workers & Pages** -> **Create application** -> **Pages** -> **Connect to Git**.
3. Select your repo.
4. Build settings:
   - **Framework preset**: Next.js
   - **Build command**: `npx @cloudflare/next-on-pages`
   - **Build output directory**: `.vercel/output/static`
5. Environment variables: same as Vercel.
6. Click **Save and Deploy**.

Note: Cloudflare Pages runs on the Edge runtime, which has some
Node.js compatibility quirks. SQLite via Prisma is **not** supported
on the Edge — you'll need to switch to a Postgres provider (Neon,
Supabase, etc.) and update `prisma/schema.prisma` accordingly.

For most operators we recommend Vercel — the project is built on
Next.js 16 and Vercel's runtime is the canonical target.

---

## 10. Troubleshooting setup

### `bun install` fails

**Symptom:** `error: failed to resolve @parcel/watcher` or similar
native module error.

**Fix:** Make sure you have a C++ toolchain installed:
- macOS: `xcode-select --install`
- Linux: `apt install build-essential python3`
- Windows: install Visual Studio Build Tools.

Alternative: use `npm install` or `pnpm install` instead.

### `bun run db:push` fails with `Database is locked`

**Symptom:** SQLite database is locked by another process.

**Fix:**
1. Stop the dev server (`Ctrl+C`).
2. Delete the `db/custom.db-journal` file (if it exists).
3. Try again.

If it persists, delete `db/custom.db` entirely and re-run
`bun run db:push` (you'll lose all data, but the bootstrap will
re-seed on the next API call).

### Dev server fails to start on port 3000

**Symptom:** `EADDRINUSE: address already in use 0.0.0.0:3000`.

**Fix:** Another process is using port 3000. Either kill it or use
a different port:

```bash
bun run dev -- -p 3001
```

### Dashboard shows "STOPPED" status

**Symptom:** The header shows the agent as STOPPED, even though you
didn't stop it.

**Fix:** See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#dashboard-shows-stopped)
— most likely a `./STOP` or `./PAUSE` file exists in the project
root, or `PAUSE_AGENT=true` is set in your env.

### Wallet balances all $0

**Symptom:** The Wallets tab shows $0.00 across all five wallets.

**Fix:** This is **expected** if the wallets are unfunded. The
monitored wallets are public read-only addresses that may have zero
balance. The agent doesn't need a balance to monitor incoming
payments — the read-only adapters don't require any on-chain activity
to function.

If you want to test payment verification end-to-end, send a small
amount (e.g. 0.001 ETH) to one of the monitored addresses and click
**Refresh Wallets**.

### LLM calls failing

**Symptom:** The Events tab shows `llm_call_failed` events.

**Fix:** Check:
1. `OPENROUTER_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` /
   `CEREBRAS_API_KEY` are set (if you're using them).
2. The Z.AI SDK config at `/etc/.z-ai-config` is valid (in this
   environment).
3. The model you're calling is enabled (check the Model Routing
   tab — disabled models show as grayed-out).

The system falls back to the Z.AI SDK automatically when other
providers fail. If all providers fail, `callLLM` returns
`fallback_action: "degrade_to_deterministic"` and the orchestrator
dispatches to the deterministic module.

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for more.

---

## Cross-references

- **Architecture** — see [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Configuration** — see [CONFIGURATION.md](./CONFIGURATION.md)
- **Operations** — see [OPERATIONS.md](./OPERATIONS.md)
- **Common issues** — see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
