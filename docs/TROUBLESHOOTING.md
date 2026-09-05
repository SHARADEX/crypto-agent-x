# Troubleshooting

This document covers the most common issues you may encounter
operating the CryptoEarn Agent and how to resolve them.

---

## Table of contents

1. [Dashboard shows "STOPPED"](#1-dashboard-shows-stopped)
2. [Wallet balances all $0](#2-wallet-balances-all-0)
3. [Models blacklisted](#3-models-blacklisted)
4. [Budget exceeded](#4-budget-exceeded)
5. [No opportunities discovered](#5-no-opportunities-discovered)
6. [LLM calls failing](#6-llm-calls-failing)
7. [Payment not verifying](#7-payment-not-verifying)
8. [Database locked](#8-database-locked)
9. [Hydration mismatch](#9-hydration-mismatch)
10. [Debugging tips](#10-debugging-tips)

---

## 1. Dashboard shows "STOPPED"

### Symptom

The header shows the agent status badge as **STOPPED** (red dot) or
**PAUSED** (amber dot), even though you didn't intentionally stop
the agent.

### Likely causes

| Cause | How to verify |
|---|---|
| `./PAUSE` or `./STOP` file exists in the project root | `ls /path/to/project/PAUSE /path/to/project/STOP` |
| `PAUSE_AGENT=true` env var is set | `echo $PAUSE_AGENT` |
| DB flags `paused` / `emergencyStop` are true (left over from a prior session) | `curl https://your-app/api/agent/status \| jq '.killSwitch'` |

### Resolution

#### Step 1: Check the kill switch state

```bash
curl https://your-app/api/agent/status | jq '.killSwitch, .canRun'
```

```json
{
  "killSwitch": {
    "paused": true,        // <-- the culprit
    "emergencyStop": false,
    "reason": "operator pause"
  },
  "canRun": {
    "canRun": false,
    "reason": "paused: operator pause"
  }
}
```

#### Step 2: Clear every signal

The kill switch ORs three independent signals. ALL must be cleared:

**DB flag:**

```bash
curl -X POST https://your-app/api/agent/emergency-reset
```

This clears BOTH `emergencyStop` and `paused` DB flags.

**Filesystem markers:**

```bash
rm /path/to/project/PAUSE 2>/dev/null
rm /path/to/project/STOP 2>/dev/null
```

**Env var:**

```bash
unset PAUSE_AGENT
# Restart the dev server to pick up the env change
```

#### Step 3: Verify

```bash
curl https://your-app/api/agent/status | jq '.canRun'
```

You should see `{ "canRun": true, "reason": "ready" }`.

The dashboard header badge should now show **IDLE** (gray dot) or
**RUNNING** (emerald dot, if a cycle is in flight).

---

## 2. Wallet balances all $0

### Symptom

The Wallets tab shows $0.00 across all five monitored wallets.

### Why this is expected

All 5 monitored wallets are **public read-only addresses** that may
have zero balance. They are:

- `0xAa4E76e5Be5334c0f2Fe0716C42B2FC61D4c150B` (Ronin)
- `0xd6DFE6b54bF3dBC919Fde57009452fe6bbb0D997` (EVM)
- `bc1qh3areygq598ntxht0yp5yv87ej7g6aqvw8fl4z` (Bitcoin)
- `2emXSLoziaB5wdC8y48ovbu41agh9PzR5ro8o7kRDUvM` (Solana)
- `TJxkyJW57Tb8qmvvv5rCh3L2FYssRvWFEv` (Tron)

The agent does NOT need a balance to monitor incoming payments. The
read-only adapters don't require any on-chain activity to function.

### Verification

Check the adapter didn't error:

```bash
curl https://your-app/api/wallet/balances | jq '.wallets[] | { label, chain, nativeBalance, error }'
```

Each row should have `nativeBalance: 0` and `error: undefined` (or
`error: null` — meaning the adapter succeeded; the wallet just has
zero balance).

If you see `error: "..."` strings, that's a real problem — see
[LLM calls failing](#6-llm-calls-failing) for diagnostic steps
(the RPC adapters use the same budget + fetch infra as LLM calls).

### Testing payment verification end-to-end

If you want to see a verified earning show up in the ledger:

1. Send a small amount (e.g. 0.001 ETH = ~$3) to one of the
   monitored addresses.
2. Wait 1-2 minutes for the tx to confirm on-chain.
3. Click **Refresh Wallets** on the Wallets tab (or `curl
   https://your-app/api/wallet/balances`).
4. Click **Seed New** on the Opportunities tab to force a discovery
   cycle.
5. The agent should discover the incoming tx, match it against a
   mock opportunity with a matching reward amount, and verify the
   payment.

(Note: the mock opportunities have rewards in $50-$25,000 range, so
a 0.001 ETH tx won't match any of them. To test payment matching
end-to-end you'd need to send exactly the right amount — easier to
just trust the unit tests in the worklog.)

---

## 3. Models blacklisted

### Symptom

The Model Routing tab shows one or more models with status
`blacklisted`. The Events tab shows `model_blacklisted` events.

### Why this happens

The circuit breaker in
[`src/lib/llm/circuit-breaker.ts`](../src/lib/llm/circuit-breaker.ts)
auto-blacklists a model after 10 failures in 60 seconds. The
blacklist auto-expires after 10 minutes.

| Failures in 60s | Status |
|---|---|
| 0 | healthy |
| 3 | degraded |
| 5 | unhealthy |
| 10 | blacklisted (10-minute cool-off) |

### Resolution

The blacklist auto-expires after 10 minutes. To force-clear it:

```bash
curl -X PATCH https://your-app/api/models/MODEL_ID \
  -H "Content-Type: application/json" \
  -d '{"status":"healthy"}'
```

URL-encode `/` as `%2F` in the model id (e.g.
`zai%2Fglm-4.6`).

### Diagnosing the cause

Look for `llm_call_failed` events:

```bash
curl "https://your-app/api/events?level=warn&agent=model_router&limit=20" | jq
```

Common causes:

| Cause | Fix |
|---|---|
| API key expired or revoked | Rotate the key; update the env var |
| Provider rate limit (429) | Lower `HOURLY_LLM_TOKENS` / `DAILY_LLM_TOKENS` |
| Provider 5xx errors | Wait; the breaker will recover |
| Model deprecated | Update `SEED_MODELS` in `src/config/providers.ts` |
| Z.AI SDK config expired | Refresh `/etc/.z-ai-config` (admin task) |

### Fallback behavior

When a model is blacklisted, the provider falls back through:

```
same-provider fallback -> cross-provider -> zai (always-on) -> deterministic -> queue
```

The orchestrator keeps running — only that specific model is
unavailable. The dashboard footer may show a brief spike in error
count, but the agent should recover within minutes.

---

## 4. Budget exceeded

### Symptom

The dashboard footer shows the budget progress bar in red (>=90% of
cap). The Events tab shows `cycle_skipped_budget` events.

### Why this happens

The budget manager in
[`src/lib/budget/manager.ts`](../src/lib/budget/manager.ts) refuses
new LLM calls when daily/hourly/per-task caps are exceeded. The
autonomous loop aborts cleanly with `skipReason="Budget: ..."`.

### Resolution

#### Option A: Wait

Hourly caps reset on the next UTC hour. Daily caps reset on the
next UTC day. No action needed.

#### Option B: Increase the caps

Set env vars and restart the dev server:

```bash
# .env.local
DAILY_LLM_TOKENS=500000        # default 250000
HOURLY_LLM_TOKENS=80000         # default 40000
PER_TASK_LLM_TOKENS=16000       # default 8000
DAILY_WEB_REQUESTS=1000         # default 500
DAILY_RPC_REQUESTS=2000          # default 1000
```

```bash
# Restart dev server
bun run dev
```

#### Option C: Reset the current period (advanced)

Delete the matching `BudgetUsage` rows for the current period:

```bash
bunx prisma studio
# Navigate to BudgetUsage, delete rows where period starts with today's date
```

Or via SQL:

```sql
DELETE FROM BudgetUsage WHERE period LIKE 'day:2024-12-12%';
DELETE FROM BudgetUsage WHERE period LIKE 'hour:2024-12-12-10%';
```

This is destructive — only do it if you're sure the budget tracking
is wrong (e.g. a runaway task burned through 100k tokens before you
noticed).

### Verifying the new caps

```bash
curl https://your-app/api/agent/status | jq '.budget.limits'
```

```json
{
  "dailyLlmTokens": 500000,
  "hourlyLlmTokens": 80000,
  "perTaskLlmTokens": 16000
}
```

---

## 5. No opportunities discovered

### Symptom

The Opportunities tab is empty, or `GET /api/opportunities` returns
`count: 0`.

### Likely causes

1. The DB is empty and the bootstrap hasn't run yet.
2. All sources are disabled.
3. The GitHub Search API rate limit is exhausted (60 req/hour/IP
   unauthenticated).
4. The discovery cycle was throttled (10-minute cool-off).
5. The budget for web requests is exhausted.

### Resolution

#### Step 1: Force a discovery cycle

```bash
curl -X POST https://your-app/api/opportunities/seed
```

This bypasses the 10-minute throttle and runs
`runDiscoveryCycle()` immediately. Returns the `DiscoverySummary`:

```json
{
  "summary": {
    "discovered": 14,
    "new": 14,
    "duplicates": 0,
    "rejected": 2,
    "byCategory": { "github_bounty": 1, "hackathon": 1, ... },
    "startedAt": "...",
    "finishedAt": "...",
    "skipped": false,
    "scannerErrors": {}
  }
}
```

If `discovered: 0`, the scanners found nothing — see step 2.

#### Step 2: Check sources

Open [`src/config/sources.ts`](../src/config/sources.ts) and verify
at least one source has `enabled: true`:

```typescript
export const SOURCES: SourceConfig[] = [
  { id: "github_issues", enabled: true, ... },
  { id: "github_help_wanted", enabled: true, ... },
  { id: "mock_bounties", enabled: true, ... },
  { id: "mock_hackathons", enabled: true, ... },
];
```

If all are `false`, set at least one to `true` and restart the dev
server.

#### Step 3: Check scannerErrors

The `DiscoverySummary` includes a `scannerErrors` map. If the
GitHub scanner returned errors, they'll be here:

```json
{
  "scannerErrors": {
    "github_issues": "HTTP 403: rate limit exceeded",
    "github_help_wanted": "HTTP 403: rate limit exceeded"
  }
}
```

The GitHub Search API allows 60 unauthenticated requests per hour
per IP. If you've been hitting it heavily, wait an hour or set a
`GITHUB_TOKEN` env var (note: not currently wired in — you'd need
to add it to the github-scanner adapter).

The mock scanner (`mock_bounties`, `mock_hackathons`) is
deterministic and always succeeds. If `discovered: 0` even with
the mock sources enabled, there's a deeper issue — see step 4.

#### Step 4: Check the budget

```bash
curl https://your-app/api/agent/status | jq '.budget'
```

If `day.webRequests` is at or near `DAILY_WEB_REQUESTS` (default
500), the scanners can't fetch. Either wait or increase the cap.

#### Step 5: Check the event log

```bash
curl "https://your-app/api/events?agent=scout&limit=20" | jq
```

Look for `discovery_cycle_skipped` or
`discovery_cycle_budget_skipped` events.

---

## 6. LLM calls failing

### Symptom

The Events tab shows `llm_call_failed` events. The Model Routing tab
shows models with status `degraded` or `unhealthy`. Tasks are
failing with `fallback_action: "degrade_to_deterministic"`.

### Likely causes

1. LLM API keys are missing or invalid.
2. The Z.AI SDK config is missing or expired.
3. Provider rate limits are exceeded.
4. The model is blacklisted.
5. Network connectivity issue.

### Resolution

#### Step 1: Check env vars

```bash
echo "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"
echo "GEMINI_API_KEY=$GEMINI_API_KEY"
echo "GROQ_API_KEY=$GROQ_API_KEY"
echo "CEREBRAS_API_KEY=$CEREBRAS_API_KEY"
```

If any are empty, the agent falls back to the Z.AI SDK. If all are
empty AND the Z.AI SDK is unavailable, `callLLM` returns
`fallback_action: "degrade_to_deterministic"`.

To set them:

```bash
# .env.local
OPENROUTER_API_KEY=sk-or-v1-...
GEMINI_API_KEY=AIzaSy...
GROQ_API_KEY=gsk_...
CEREBRAS_API_KEY=csk-...
```

Restart the dev server.

#### Step 2: Check the Z.AI SDK config

```bash
cat /etc/.z-ai-config 2>/dev/null
# OR (if running locally)
ls ~/.z-ai-config 2>/dev/null
```

If the file is missing or the token inside is expired,
`ZAI.create()` will throw and the breaker will trip on the first
call. The agent will degrade to deterministic logic while the
operator refreshes the config.

#### Step 3: Check the model registry

```bash
curl https://your-app/api/models | jq '.models[] | { model_id, status, enabled }'
```

```json
{ "model_id": "zai/glm-4.6", "status": "blacklisted", "enabled": true }
```

If a model is `blacklisted`, see [Models blacklisted](#3-models-blacklisted).

#### Step 4: Check the event log

```bash
curl "https://your-app/api/events?level=warn&agent=model_router&limit=20" | jq '.events[] | { event, payload }'
```

Look for the specific error message. Common patterns:

| Error | Cause | Fix |
|---|---|---|
| `401 Unauthorized` | API key invalid | Rotate the key |
| `429 Too Many Requests` | Rate limit | Wait or lower budget caps |
| `500 Internal Server Error` | Provider 5xx | Wait; the breaker will recover |
| `ENOTFOUND api.openrouter.ai` | DNS / network | Check network connectivity |
| `ECONNREFUSED` | Firewall blocking | Check outbound HTTPS rules |
| `socket hang up` | Timeout | Retry; check latency to provider |

#### Step 5: Verify with a direct call

```bash
# Test OpenRouter
curl -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openrouter/auto","messages":[{"role":"user","content":"hi"}]}' \
  https://openrouter.ai/api/v1/chat/completions

# Test Gemini OpenAI-compat endpoint
curl -H "Authorization: Bearer $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.0-flash","messages":[{"role":"user","content":"hi"}]}' \
  https://generativelanguage.googleapis.com/v1beta/openai/chat/completions

# Test Groq
curl -H "Authorization: Bearer $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"hi"}]}' \
  https://api.groq.com/openai/v1/chat/completions
```

If the direct call fails, the issue is with the provider, not with
the agent.

#### Step 6: Fallback to deterministic

If ALL providers are unreachable, the orchestrator dispatches to
the deterministic module (`src/lib/llm/deterministic.ts`). This
handles LEVEL 1 tasks (wallet balance, arithmetic, JSON validation,
file operation) without any LLM call. The agent stays alive — it
just can't reason about new opportunities.

---

## 7. Payment not verifying

### Symptom

An opportunity is stuck in `awaiting_payment` status. The
`POST /api/opportunities/[id]/verify-payment` endpoint returns
`{ matched: false, status: "unverified", notes: [...] }`.

### Likely causes

1. The payment hasn't actually landed on a monitored wallet.
2. The payment landed on a different chain than the opportunity's
   `rewardCurrency`.
3. The payment amount is outside the ±5% tolerance.
4. The payment was sent to a non-monitored address.
5. The payment was an ERC-20 token transfer (the EVM adapter only
   matches native ETH transfers; ERC-20 token transfer scanning
   is a follow-up).
6. The Ronin adapter can't list transactions (the public Ronin RPC
   doesn't expose a key-less tx-list endpoint).

### Resolution

#### Step 1: Verify the payment on-chain

Open the explorer for the chain you expected the payment on:

| Chain | Explorer |
|---|---|
| ethereum | https://etherscan.io/address/<MONITORED_ADDRESS> |
| bitcoin | https://blockchain.info/address/<MONITORED_ADDRESS> |
| solana | https://solscan.io/account/<MONITORED_ADDRESS> |
| tron | https://tronscan.org/#/address/<MONITORED_ADDRESS> |
| ronin | https://app.roninchain.com/address/<MONITORED_ADDRESS> |

Confirm the incoming tx is there. If it's not, the payment simply
hasn't landed yet — wait for confirmations.

#### Step 2: Check the transaction table

```bash
curl "https://your-app/api/wallet/transactions?limit=50" | jq
```

Look for the tx in the list. If it's not there, force a scan:

```bash
curl -X POST https://your-app/api/wallet/transactions \
  -H "Content-Type: application/json" \
  -d '{"since": "2024-12-01T00:00:00Z"}'
```

#### Step 3: Check the matching criteria

The payment verifier matches on:

- `direction = "incoming"`
- `toAddress` is one of our monitored addresses (case-insensitive on EVM/Tron)
- `blockTimestamp` is within the last 30 days
- `amount` is within ±5% of `opportunity.rewardAmount`
- `currency` matches `opportunity.rewardCurrency` (case-insensitive)

If the amount is outside ±5%, the verifier won't match. If the
currency is different (e.g. the opportunity expects USDC but the
payment is in native ETH), the verifier won't match.

#### Step 4: Manually verify

If the payment clearly matches but the verifier missed it, you can
manually override:

```bash
# 1. Mark the opportunity as paid
curl -X PATCH https://your-app/api/opportunities/OPP_ID \
  -H "Content-Type: application/json" \
  -d '{"status":"paid"}'

# 2. (Optional) Manually mark the transaction as matched via SQL
# (advanced — requires direct DB access)
```

The manual override doesn't go through the ledger's
`convertExpectedToVerified` path, so the expected earning won't be
upgraded automatically. You'd need to also call the ledger
directly (out of scope for this doc).

#### Step 5: Known limitations

- **ERC-20 token transfers**: The EVM adapter currently only
  fetches native ETH transfers. ERC-20 (USDC, USDT, etc.) token
  transfers need a separate Blockscout endpoint. If your
  opportunity is paid in USDC, the verifier won't match until that
  follow-up ships.
- **Ronin transactions**: The public Ronin RPC doesn't expose a
  key-less tx-list endpoint. Use EVM/Solana/Tron/BTC matching for
  opportunities paid in those currencies.
- **30-day window**: If the payment was older than 30 days, the
  verifier won't find it. This is by design — older payments
  shouldn't be re-matched to new opportunities.

---

## 8. Database locked

### Symptom

The dev server throws `Error: SQLite database is locked` or
`PrismaClientKnownRequestError: Transaction failed on the server`.

### Likely causes

1. Another process is using the SQLite file (e.g. a second dev
   server instance, or `prisma studio`).
2. A long-running transaction held the write lock and timed out.
3. The SQLite WAL file is corrupt (rare).

### Resolution

#### Step 1: Stop the dev server

```bash
# Ctrl+C in the terminal running `bun run dev`
```

#### Step 2: Delete the WAL + SHM files

```bash
rm /path/to/project/db/custom.db-journal 2>/dev/null
rm /path/to/project/db/custom.db-wal 2>/dev/null
rm /path/to/project/db/custom.db-shm 2>/dev/null
```

These are SQLite's write-ahead-log files. Deleting them while the
dev server is stopped is safe — the main `custom.db` file has all
committed data.

#### Step 3: Restart the dev server

```bash
bun run dev
```

#### Step 4: If it persists, reset the database (dev only)

```bash
rm /path/to/project/db/custom.db*
bun run db:push
# The next API call will trigger bootstrapAgent() which re-seeds the
# mock opportunities + strategies + models.
```

WARNING: This deletes ALL data — opportunities, tasks, earnings,
events. Only do this in dev. In production, restore from backup
instead.

#### Step 5: Prevent recurrence

- Don't run two dev server instances on the same DB file.
- If you need `prisma studio` open alongside the dev server, it
  will share the connection pool — but heavy writes can still
  contend.
- For production, switch to Postgres (Neon / Supabase / Vercel
  Postgres) which handles concurrent connections better than
  SQLite.

---

## 9. Hydration mismatch

### Symptom

The browser console shows:
```
Warning: Expected server HTML to contain a matching <div> in <div>.
Hydration failed because the initial UI does not match what was rendered on the server.
```

### Likely causes

1. The `next-themes` ThemeProvider is rendering a different theme
   on the server vs the client (e.g. server renders "system", client
   resolves to "dark").
2. A component is using `Date.now()` / `Math.random()` /
   `window.localStorage` during render.
3. Conditional rendering based on browser-only APIs.

### Resolution

#### For `next-themes` (most common)

The `ThemeProvider` in
[`src/components/dashboard/theme-provider.tsx`](../src/components/dashboard/theme-provider.tsx)
should have `suppressHydrationWarning` set on the `<html>` element
in [`src/app/layout.tsx`](../src/app/layout.tsx):

```tsx
<html lang="en" suppressHydrationWarning>
```

If the warning persists, check that no component renders
theme-dependent UI before the ThemeProvider mounts. The standard
fix is to gate theme-dependent UI behind a `mounted` flag:

```tsx
const [mounted, setMounted] = useState(false);
useEffect(() => setMounted(true), []);
if (!mounted) return null; // or a skeleton
```

#### For Date / Math.random

Don't call `Date.now()` or `Math.random()` during render — call
them in `useEffect` or compute the value on the server and pass it
down as a prop.

#### For localStorage / window

Wrap any access in a `typeof window !== 'undefined'` check, or use
`useEffect` to read it after mount.

---

## 10. Debugging tips

### Read dev.log

The dev server tees its output to `dev.log` (see `package.json`'s
`dev` script: `next dev -p 3000 2>&1 | tee dev.log`).

```bash
tail -f /path/to/project/dev.log
```

Or grep for specific patterns:

```bash
# Recent errors
grep -i error /path/to/project/dev.log | tail -30

# Specific API route
grep "/api/opportunities" /path/to/project/dev.log | tail -20

# Console.error from the orchestrator
grep "\[orchestrator\]" /path/to/project/dev.log | tail -30
```

### Check /api/events

The event log is the append-only audit trail. Use the filters:

```bash
# Critical events
curl "https://your-app/api/events?level=critical&limit=20" | jq

# Events from a specific agent
curl "https://your-app/api/events?agent=orchestrator&limit=50" | jq

# Events for a specific opportunity
curl "https://your-app/api/events?opportunityId=opp_..." | jq
```

### Check /api/agent/status

The dashboard's primary polling endpoint:

```bash
curl https://your-app/api/agent/status | jq
```

Returns `agentState`, `canRun`, `budget`, `killSwitch`,
`walletSummary` in a single round-trip.

### Use Prisma Studio for DB inspection

```bash
bunx prisma studio
```

Opens a web UI at [http://localhost:5555](http://localhost:5555)
where you can browse and edit every Prisma model.

### Use the agent-browser skill

If you need to interact with the dashboard as a user (e.g. to test
a specific click flow), the `agent-browser` skill can drive the
browser headlessly:

```bash
# From the project root
agent-browser snapshot http://localhost:3000
agent-browser click "text=Run Cycle"
agent-browser snapshot
```

### Add temporary logging

If a specific agent or pipeline step is misbehaving, add temporary
`console.log` statements in the relevant file. The dev server's
hot-reload will pick up the changes immediately.

For example, to debug the Research Agent:

```typescript
// src/lib/agents/research-agent.ts
export async function execute(input: AgentInput): Promise<AgentOutput> {
  console.log('[research] input:', JSON.stringify(input, null, 2));
  // ... existing code
  console.log('[research] output:', JSON.stringify(output, null, 2));
  return output;
}
```

Remove the logs before committing.

### Check the bootstrap result

The first API call triggers `bootstrapAgent()`. To see what it did:

```bash
curl "https://your-app/api/events?agent=orchestrator&limit=5" | jq '.events[] | select(.event == "agent_bootstrapped") | .payload'
```

You should see:

```json
{
  "modelsSeeded": 6,
  "strategiesSeeded": 11,
  "opportunitiesCount": 14,
  "discoveryRan": true,
  "discoveryNew": 14,
  "errorCount": 0,
  "errors": []
}
```

If `errorCount > 0`, investigate each error string.

### Force a fresh bootstrap

The `bootstrapDone` flag is module-level — it resets on hot-reload.
To force a re-bootstrap without restarting the dev server, you can
call `resetBootstrapFlag()` from a test script, or just restart the
dev server (`Ctrl+C` + `bun run dev`).

### Common gotchas

- **`force-dynamic` everywhere**: every API route sets
  `export const dynamic = "force-dynamic"`. Without this, Next.js
  16 may attempt to statically optimize the route at build time.
  If you see stale data on the dashboard, check that the route
  file has this line.
- **`Cache-Control: no-store`**: every API response sets this
  header. If you see stale data, check the route file.
- **Hot-reload resets module-level state**: the circuit breaker,
  bootstrap flag, and ZAI SDK singleton all reset on hot-reload.
  This is fine in dev; in production (single long-lived process)
  they persist for the lifetime of the process.
- **The mock scanner is invoked twice per cycle** (once for
  `mock_bounties`, once for `mock_hackathons`). Both invocations
  return the same 14 raws, which dedup via canonical id. This is
  expected.
- **The GitHub scanner is invoked twice per cycle** (once for
  `github_issues`, once for `github_help_wanted`). Both raw sets
  have `source: "github_issues"` (hardcoded) so they aggregate
  under one `SourceReputation` row.

---

## Cross-references

- **Architecture** — see [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Operations** — see [OPERATIONS.md](./OPERATIONS.md)
- **Configuration** — see [CONFIGURATION.md](./CONFIGURATION.md)
- **Security** — see [SECURITY.md](./SECURITY.md)
- **API reference** — see [API.md](./API.md)
