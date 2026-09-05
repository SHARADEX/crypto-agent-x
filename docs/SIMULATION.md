# SIMULATION — Autonomous Zero-Cost Crypto Earning Agent

**Task ID:** P2-DASH-OBS (Workstream C)
**Phase:** 2 §40, P2-23, P2-16
**Audience:** operators, devs wiring real adapters, auditors.

This document is the single source of truth for **what is simulated** in the
agent's runtime, **why** it's simulated, and **how to switch each component
to real**. It is read alongside `IMPLEMENTATION_GAPS.md` (which tracks
unimplemented features) — the items here are intentionally simulated, not
forgotten.

---

## TL;DR — at-a-glance simulation matrix

| Component | Simulated? | Why | How to switch to real |
|---|---|---|---|
| LLM responses (`callLLM`) | only when `MOCK_MODE=true` | tests + mock-simulation script spend no real tokens | `unset MOCK_MODE` (or `MOCK_MODE=false`) — every provider adapter is already wired with real `fetch()` |
| Execution agent submission (`execute`) | in `observe` autonomy OR `MOCK_MODE=true`; **refuses to run** in `semi`/`full` | no real GitHub PAT / hackathon token / docs-PR credentials in this sandbox | set `autonomyMode=observe` for demo, OR wire a `SubmissionAdapter` for the relevant category in `src/lib/agents/execution-agent.ts` |
| Mock scanner opportunities (`MockSource`) | always on | provides a deterministic dataset so the dashboard renders something on a fresh DB | remove `mock_bounties` / `mock_hackathons` from `src/config/sources.ts` once real sources are healthy |
| Provider credentials (OpenRouter/Gemini/Groq/Cerebras/HF/Mistral/Cloudflare/NVIDIA) | not simulated, **degraded** — `not_configured` until env var set | operator hasn't supplied API keys | set the corresponding `*_API_KEY` env var (see `docs/CONFIGURATION.md`) |
| Ronin tx-list endpoint | returns soft-error | public Ronin RPC has no key-less tx list endpoint | provision `RONIN_API_KEY` (Sky Mavis) and replace `fetchRoninTransactions` in `src/lib/wallet/adapters/ronin.ts` |
| Wallet balances | **real** (not simulated) | public RPCs return real balances | already real — no action needed |
| Payment verification | **real** (not simulated) | scans real tx history on EVM/Solana/Tron/BTC | already real — no action needed |

---

## 1. LLM responses — `callLLM` MOCK_MODE

**File:** `src/lib/llm/provider.ts` (`callLLM`)

**What's simulated:** When `process.env.MOCK_MODE === "true"` (case-insensitive),
`callLLM` short-circuits before the budget check + provider dispatch and
returns a canned response from `tests/fixtures/mock-llm-responses.ts`
keyed by `taskType`. The canned response is deterministic — the same
taskType always returns the same string. The budget counter is still
incremented (so budget-cap tests see realistic counters).

**Why:** Lets the test suite, the `bun run agent:mock-simulation` script,
and CI run the full agent lifecycle (orchestrator → 10 specialist agents →
wallet verifier → ledger) without spending real LLM tokens or hitting
rate-limited APIs. The simulator can finish a 5-cycle run in seconds.

**How to switch to real:**

```bash
unset MOCK_MODE
# (or, equivalently)
MOCK_MODE=false bun run dev
```

When unset, `callLLM` does the full lifecycle:

1. Budget pre-check (spec §27).
2. Circuit-breaker gate.
3. Provider dispatch via the `PROVIDERS` registry (z-ai SDK is auto-provisioned; others need their `*_API_KEY` env var).
4. Retry + backoff (2 retries, 500ms × 2^n).
5. Re-routing fallback — exclude failed model, re-run `selectModel`, loop up to N=3.
6. Budget + performance + breaker + quota tracking.
7. Audit-log `llm_call_succeeded` / `llm_call_failed` / `llm_call_rerouting` / `llm_call_exhausted_retries` events.

**Verification:**
- Real mode: `MOCK_MODE=false` + `ZAI_API_KEY` set (or auto-provisioned) →
  dashboard Events tab shows `llm_call_succeeded` events with real
  `promptTokens` + `completionTokens` usage.
- Mock mode: `MOCK_MODE=true` → events show `provider: "zai"`,
  `latencyMs: 1`, and the response matches the canned strings in
  `tests/fixtures/mock-llm-responses.ts`.

---

## 2. Execution agent submission — `execute()`

**File:** `src/lib/agents/execution-agent.ts`

**What's simulated:** When `SIMULATION_MODE` is active (MOCK_MODE=true OR
`autonomyMode === "observe"`), the execution agent marks the Opportunity
as `executed`, writes an `IdempotencyRecord` with `externalRef =
"simulated:<executionId>:<ts>"`, and emits an `execution_completed`
event with `simulated: true`. The dashboard will show the opportunity as
"executed" but the `externalRef` is prefixed with `simulated:` so the
audit log distinguishes it from a real submission at a glance.

**What's NOT simulated:** In `semi` or `full` autonomy (i.e. NOT
`observe`) AND `MOCK_MODE` is unset/false, the execution agent **refuses
to fake success** and instead returns:

```
{
  success: false,
  error: "no real submission adapter configured for category \"<category>\" (autonomyMode=<mode>). See docs/SIMULATION.md.",
  nextStatus: "failed"
}
```

It also writes an `execution_no_real_adapter` event at `error` level and
marks the Opportunity as `failed`. This is the loud-fail behaviour the
spec (§40) demands: never silently fake an action.

**Why:** There is no real submission adapter wired yet — GitHub PR
creation requires a PAT, hackathon entries require platform tokens,
docs PRs require GitHub OAuth, etc. The spec mandates the lifecycle be
demonstrable end-to-end (so the dashboard, ledger, payment verifier,
and review-agent all get exercised) — `SIMULATION_MODE` lets that
happen without misleading the operator into thinking real work was
done.

**How to switch to real:** Implement a `SubmissionAdapter` interface
and register it per-category in `src/lib/agents/execution-agent.ts`.
The interface is intentionally small:

```typescript
interface SubmissionAdapter {
  category: string;                    // "bounty" | "hackathon" | "docs" | ...
  submit(opts: {
    opportunity: Opportunity;
    task: Task;
    plan: TaskPlan;
    codeWorkspace?: string;            // path to the cloned repo (coding agent)
  }): Promise<{
    success: boolean;
    externalRef: string;               // e.g. "github_pr:12345"
    error?: string;
  }>;
}
```

Wire one or more adapters in `src/lib/agents/submissions/` (new
directory) and have `execute()` look them up by category before falling
back to the SIMULATION path. The pre-flight gates (policy, idempotency,
approval) stay exactly as they are — the adapter is the only new code.

Until the adapter is wired, leave `autonomyMode="observe"` for any
demo / dry-run, or set `MOCK_MODE=true` to simulate at the LLM layer
as well.

**Verification:**
- `autonomyMode=observe` → `execution_completed` event has
  `simulated: true`, `simulationMode: "on"`, `externalRef: "simulated:..."`.
- `autonomyMode=semi` + `MOCK_MODE` unset → `execution_no_real_adapter`
  event at `error` level, Opportunity status → `failed`, return value
  `success: false` with the actionable error string.

---

## 3. Mock scanner opportunities — `MockSource`

**Files:**
- `src/lib/agent/scanners/mock-scanner.ts` — the deterministic dataset (44 mock opportunities covering every category).
- `src/lib/agent/sources/mock-source.ts` — the V2 `OpportunitySource` adapter that wraps the scanner.
- `src/config/sources.ts` — defines which sources are configured.

**What's simulated:** The `MockSource` returns a fixed list of 44
opportunities (bounties, hackathons, docs, freelance, grants, etc.) on
every `discover()` call. The dataset is deterministic — the same
canonicalIds every time, so dedup (`normalizeOpportunity`) won't grow
the DB past the first scan.

**Why:** Provides a baseline of "interesting-looking" opportunities so
the dashboard, scoring, and economics engine have something to render
on a fresh DB. The real sources (GitHub bounties, Gitcoin, Devpost,
OnlyDust, Hashnode, RSS feeds) are health-gated — if their network is
down or no API key is set, they return zero rows. The mock source is
always considered healthy so the dashboard never renders empty.

**How to switch to real:** Remove the `mock_bounties` and `mock_hackathons`
entries from `src/config/sources.ts` once the real sources are healthy
and producing opportunities at a useful rate. The mock scanner stays in
the codebase — it's useful for tests and demos — but it won't be invoked
once the config drops those entries.

**Verification:**
- `bun run dev` + dashboard Opportunities tab shows ~44 rows even when
  no real source is configured.
- Remove `mock_bounties` + `mock_hackathons` from `src/config/sources.ts`
  → Opportunities tab shows only real-source rows (could be zero if no
  network).

---

## 4. Provider credentials — degraded (not simulated)

**Files:** `src/lib/llm/providers/*.ts` (9 adapters).

**What's NOT simulated:** Every provider adapter makes real `fetch()`
calls to its provider's OpenAI-compatible `/chat/completions` endpoint
(or the Gemini REST API, or the z-ai SDK). The dispatch layer in
`src/lib/llm/provider.ts` (`dispatchToProvider`) is real.

**What IS degraded:** Each adapter's `isConfigured()` returns `false`
when the corresponding env var is not set. The router then sees the
provider as `not_configured` and excludes it from routing.

| Provider | Env var | Auto-provisioned in this sandbox? |
|---|---|---|
| zai | (none — uses `/etc/.z-ai-config`) | ✅ yes |
| openrouter | `OPENROUTER_API_KEY` | ❌ operator must set |
| gemini | `GEMINI_API_KEY` | ❌ operator must set |
| groq | `GROQ_API_KEY` | ❌ operator must set |
| cerebras | `CEREBRAS_API_KEY` | ❌ operator must set |
| huggingface | `HUGGINGFACE_API_KEY` | ❌ operator must set |
| mistral | `MISTRAL_API_KEY` | ❌ operator must set |
| cloudflare | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | ❌ operator must set |
| nvidia | `NVIDIA_API_KEY` | ❌ operator must set |

**How to switch to real:** Set the env var(s). The `bootstrapProviders()`
call at startup will re-run `healthCheck()` + `listModels()` and the
models will become routable.

**Verification:** `curl -s http://localhost:3000/api/models/providers`
returns a `providers` array — check the `isConfigured` flag and
`status` field per provider.

---

## 5. Ronin tx-list endpoint — soft-error (not simulated)

**File:** `src/lib/wallet/adapters/ronin.ts` (`fetchRoninTransactions`)

**What's simulated:** Nothing — the function returns a soft error
("endpoint requires API key") rather than real transactions.

**Why:** The public Ronin RPC (`https://api.roninchain.com/rpc`) only
exposes `eth_getBalance` for key-less callers. Listing transactions
requires the Sky Mavis API (with key) or the Ronin Explorer scraper.
We don't have a Sky Mavis API key in this sandbox, and the spec (§12)
mandates "graceful return of zero balance + error note" rather than
crashing.

**Phase-2 §40 / P2-23 change:** The soft error is now EXPLICITLY logged
as a `wallet_ronin_txlist_unavailable` event at `warn` level (was
previously silent). The dashboard Events tab surfaces it; the audit log
shows the operator-actionable message.

**How to switch to real:**

1. Provision a Sky Mavis API key (https://docs.skymavis.com/).
2. Set `RONIN_API_KEY` in `.env`.
3. Replace the body of `fetchRoninTransactions` in
   `src/lib/wallet/adapters/ronin.ts` with a real call to the Sky Mavis
   endpoint (or the Ronin Explorer scraper). The return shape stays the
   same (`RoninTxScanResult`) so the payment verifier doesn't need
   changes.

**Verification:**
- With no key set: dashboard Events tab shows
  `wallet_ronin_txlist_unavailable` warn events on every payment
  scan.
- With a real Sky Mavis call wired: events stop appearing, real
  Ronin transactions show up in the Wallets tab.

---

## 6. Wallet balances + payment verification — REAL (not simulated)

**Files:**
- `src/lib/wallet/adapters/{evm,bitcoin,solana,tron,ronin}.ts` — real RPC calls.
- `src/lib/wallet/monitor.ts` — refreshes every wallet every cycle.
- `src/lib/wallet/payment-verifier.ts` — scans real tx history.

**What's real:** Every wallet adapter makes real `fetch()` calls to its
chain's public RPC endpoint. Balances update on every cycle. The payment
verifier scans real transactions and matches them against
`awaiting_payment` opportunities by amount + recipient address + ±5%
time window.

**Caveat:** The 5 monitored wallets (Ronin, EVM, BTC, SOL, TRON) are
**unfunded read-only public addresses** in this sandbox. Their balances
are correctly reported (typically 0). When an operator funds a wallet
and a real payment lands, the verifier will pick it up automatically —
no code changes needed.

---

## 7. How to verify the simulation matrix at runtime

```bash
# 1. Check provider configuration:
curl -s http://localhost:3000/api/models/providers | jq '.providers[] | {name, isConfigured, status}'

# 2. Check the live quota tracker:
curl -s http://localhost:3000/api/models/quota | jq '.quota'

# 3. Check recent execution events for `simulated: true`:
curl -s "http://localhost:3000/api/events?agent=execution&limit=5" | \
  jq '.events[] | {event, payload: (.payload | {simulated, simulationMode, autonomyMode, mockMode, externalRef})}'

# 4. Check for Ronin soft-error warnings:
curl -s "http://localhost:3000/api/events?agent=payment&limit=20" | \
  jq '.events[] | select(.event == "wallet_ronin_txlist_unavailable")'

# 5. Run a single cycle and check the runId correlation:
curl -s -X POST http://localhost:3000/api/agent/run-cycle \
  -H "Content-Type: application/json" -d '{"cycles": 1, "delayMs": 0}'
# Then check that the runId on the cycle_complete event matches the
# runId on the downstream model_router events:
curl -s "http://localhost:3000/api/events?agent=orchestrator&limit=1" | \
  jq '.events[0].payload.runId'
```

---

## 8. Related documents

- `AUDIT.md` — per-requirement classification (IMPLEMENTED / PARTIAL / MOCK / MISSING / BROKEN).
- `IMPLEMENTATION_GAPS.md` — prioritised list of unimplemented features (not simulated — actually missing).
- `docs/ARCHITECTURE.md` — system overview, lifecycle, agent table, routing diagram.
- `docs/CONFIGURATION.md` — every env var with examples.
- `docs/OPERATIONS.md` — runbook for the operator dashboard.
