# Operations

This document is the operator's manual for the CryptoEarn Agent. It
covers day-to-day operations: starting/stopping the agent, approving
pending tasks, monitoring budgets and wallets, reading the event log,
interpreting the dashboard, and handling common operational scenarios.

---

## Table of contents

1. [Starting and stopping the agent](#1-starting-and-stopping-the-agent)
2. [Autonomy modes](#2-autonomy-modes)
3. [The autonomous loop](#3-the-autonomous-loop)
4. [Approving pending tasks](#4-approving-pending-tasks)
5. [Monitoring budgets](#5-monitoring-budgets)
6. [Monitoring wallet balances](#6-monitoring-wallet-balances)
7. [Reading the event log](#7-reading-the-event-log)
8. [Interpreting the dashboard](#8-interpreting-the-dashboard)
9. [Manual operations](#9-manual-operations)
10. [When a provider is blacklisted](#10-when-a-provider-is-blacklisted)
11. [Handling a kill-switch activation](#11-handling-a-kill-switch-activation)

---

## 1. Starting and stopping the agent

The agent has three control states. The kill switch is OR-ed across
three independent mechanisms (DB flag, filesystem marker, env var) —
if ANY is set, the agent halts.

### Soft pause (in-flight cycles finish, no new cycles start)

**Via dashboard:** Click the **Pause** button in the header.

**Via API:**

```bash
curl -X POST https://your-app/api/agent/pause \
  -H "Content-Type: application/json" \
  -d '{"reason":"investigating issue"}'
```

**Via filesystem marker:**

```bash
touch /path/to/project/PAUSE
```

**Via env var:**

```bash
export PAUSE_AGENT=true
```

To resume:

```bash
curl -X POST https://your-app/api/agent/resume
# OR delete the ./PAUSE file
# OR unset the PAUSE_AGENT env var
```

### Emergency stop (in-flight tasks MUST abort)

**Via dashboard:** Click the **Emergency** dropdown -> **Stop**.

**Via API:**

```bash
curl -X POST https://your-app/api/agent/emergency-stop \
  -H "Content-Type: application/json" \
  -d '{"reason":"suspected compromise"}'
```

**Via filesystem marker:**

```bash
touch /path/to/project/STOP
```

To reset (clears BOTH emergency stop and soft pause):

```bash
curl -X POST https://your-app/api/agent/emergency-reset
```

### Verifying the state

```bash
curl https://your-app/api/agent/status | jq '.killSwitch, .canRun'
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

### Important caveat

`setPaused` and `setEmergencyStop` always write the DB flag, even
when the same flag is also set via filesystem marker. This means
removing the `./PAUSE` file does NOT clear a DB-set pause (and vice
versa) — both signals must be cleared for the agent to run.

Use `POST /api/agent/emergency-reset` to clear both at once.

---

## 2. Autonomy modes

The agent has four autonomy modes (spec §11). The mode determines
what level of external action is auto-allowed vs requires human
approval.

| Mode | Level 0 (read) | Level 1 (low) | Level 2 (moderate) | Level 3 (high) |
|---|---|---|---|---|
| `observe` | allowed | rejected | rejected | rejected (needs approval) |
| `assist` | allowed | allowed | rejected | rejected (needs approval) |
| `semi` | allowed | allowed | allowed | rejected (needs approval) |
| `full` | allowed | allowed | allowed | rejected (needs approval — ALWAYS) |

**Level 3 ALWAYS requires an approved `Approval` row, even in `full`
autonomy.** This is the spec §11 invariant: financial actions, wallet
signing, and contract interactions are never auto-executed.

### Default mode

`observe` — the agent starts in this mode. Discovery + verification
only, no execution. To allow execution you must explicitly raise the
mode.

### Changing the mode

**Via dashboard:** Use the **Autonomy** dropdown in the header.

**Via API:**

```bash
curl -X POST https://your-app/api/agent/autonomy \
  -H "Content-Type: application/json" \
  -d '{"mode":"semi"}'
```

Valid modes: `observe`, `assist`, `semi`, `full`. Any other value
returns HTTP 400.

### What each mode allows in practice

| Action | observe | assist | semi | full |
|---|---|---|---|---|
| Discover opportunities | yes | yes | yes | yes |
| Verify (scam + URL + code) | yes | yes | yes | yes |
| Compute economics | yes | yes | yes | yes |
| Generate code (Coding Agent) | yes | yes | yes | yes |
| Generate docs (Writing Agent) | yes | yes | yes | yes |
| Execute low-risk submission (e.g. GitHub PR) | NO | yes | yes | yes |
| Execute moderate-risk submission (e.g. cross-repo) | NO | NO | yes | yes |
| Sign transactions / wallet drainer check | NO | NO | NO | NO (always requires approval) |
| Referral / airdrop participation | NO | NO | NO | NO (always requires approval) |

The policy engine in [`src/lib/policy.ts`](../src/lib/policy.ts)
implements these rules deterministically. The LLM has no override
path.

---

## 3. The autonomous loop

`runCycle()` in [`src/lib/orchestrator/loop.ts`](../src/lib/orchestrator/loop.ts)
runs ten steps per cycle. Every step is wrapped in try/catch —
failures are recorded as `errors[]` but never abort the whole cycle
(spec §29).

```
1. refreshKillSwitchState     - re-read DB + filesystem + env signals
2. canRun() gate              - abort if paused / stopped
3. budget.assertWithinBudget  - abort if caps exceeded
4. refreshWallets()          - light wallet balance refresh (parallel)
5. throttled runDiscovery    - only if last discovery > 10 min ago
6. selectStrategyForCycle    - 70/20/10 explore/exploit/experimental
7. selectNextOpportunity     - resume mid-flight first, then ranked
8. processOpportunity(id)    - walk through lifecycle
9. scanForIncomingPayments   - retry awaiting_payment opportunities
10. markCycle(result)         - increment cycle counter
```

### Triggering a cycle manually

**Via dashboard:** Click the green **Run Cycle** button in the header.

**Via API:**

```bash
# Run one cycle
curl -X POST https://your-app/api/agent/run-cycle \
  -H "Content-Type: application/json" \
  -d '{}'

# Run 5 cycles with 2-second delays
curl -X POST https://your-app/api/agent/run-cycle \
  -H "Content-Type: application/json" \
  -d '{"cycles": 5, "delayMs": 2000}'
```

Hard caps: `cycles` max 20, `delayMs` max 60000. The endpoint is
synchronous — it blocks until all cycles complete. For more than 5
cycles, the request may exceed the dev server's HTTP timeout; in
production use a queue or background job.

### Discovery throttle

Discovery is throttled to once per 10 minutes (`DISCOVERY_THROTTLE_MS`
in [`src/lib/orchestrator/loop.ts`](../src/lib/orchestrator/loop.ts)).
This is because the GitHub Search API has a 60 req/hour/IP
unauthenticated quota — a 1-second cycle cadence would blow through
that in a minute.

The throttle uses `AgentState.lastCycleAt` as the proxy for "last
discovery". To force a fresh discovery pass right now, see
[Forcing a discovery cycle](#forcing-a-discovery-cycle).

### Cycle summary

Every cycle returns a `CycleSummary`:

```typescript
{
  cycle: number;                 // sequential cycle number
  startedAt: string;             // ISO timestamp
  finishedAt: string;
  skipped: boolean;              // true if kill switch or budget gate fired
  skipReason?: string;
  discovered: number;            // raw opportunities discovered (after throttle)
  discoveredNew: number;         // new opportunities inserted into DB
  selectedOpportunityId: string | null;
  strategy: string | null;       // strategy chosen this cycle
  processed: ProcessOpportunityResult | null;
  paymentsVerified: number;
  errors: string[];               // step errors (never aborts the cycle)
}
```

The dashboard footer shows the latest cycle's result tag
(`processed:<finalStatus>`, `no-opportunity-processed`, etc.) and
the cycle counter.

---

## 4. Approving pending tasks

When the policy engine encounters a level-2 or level-3 action
without an approved `Approval` row, it creates a pending approval
and waits. The opportunity's status sticks at `queued` until the
operator decides.

### Listing pending approvals

**Via dashboard:** Go to the **Approvals** tab.

**Via API:**

```bash
curl https://your-app/api/approvals | jq
```

Response:

```json
{
  "approvals": [
    {
      "id": "approval_...",
      "opportunityId": "opp_...",
      "riskLevel": "moderate",
      "executionLevel": 2,
      "reason": "referral/airdrop category requires human approval (spec §3 prohibition perimeter).",
      "status": "pending",
      "opportunity": {
        "id": "opp_...",
        "title": "...",
        "category": "referral",
        "source": "mock_bounties",
        "rewardUsd": 100,
        "riskScore": 30,
        "expectedValue": 50,
        "riskAdjustedHourly": 20
      }
    }
  ],
  "count": 1
}
```

### Approving / rejecting / skipping

**Via dashboard:** Click **Approve** / **Reject** / **Skip** on the
approval row in the Approvals tab.

**Via API:**

```bash
curl -X POST https://your-app/api/approvals/APPROVAL_ID \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve", "decidedBy":"alice"}'
```

Valid decisions: `approve`, `reject`, `skip`.

### Side effects of "approve"

When you approve an approval:
1. The `Approval` row's `status` is set to `approved`,
   `decidedAt` is stamped, `decidedBy` is recorded.
2. The decision is logged via `logEvent("approval_approved", ...)`.
3. `queueForExecution(opportunityId)` is called, which:
   - Re-evaluates the policy verdict.
   - If allowed, transitions the opportunity from `queued` to...
     actually, the orchestrator picks it up on its next cycle and
     walks it through `planning -> approved -> executed`.
   - Records an expected earning in the ledger.
   - Increments the matching StrategyStat's `attempted` counter.

### Side effects of "reject"

The opportunity stays in its current status (typically `queued`).
The orchestrator will NOT pick it up again until the operator
manually overrides its status via `PATCH /api/opportunities/[id]`.

### Side effects of "skip"

The approval row's status becomes `skipped` but the opportunity
remains queueable. The orchestrator will skip past it on the next
cycle (no approval row blocks progression — the policy engine only
checks for `pending` approvals).

---

## 5. Monitoring budgets

The budget tracker in
[`src/lib/budget/manager.ts`](../src/lib/budget/manager.ts) records
LLM tokens, web requests, RPC calls, and execution time per UTC
day/hour period. Hard caps are in
[`src/config/providers.ts`](../src/config/providers.ts); env vars
override.

### Reading the budget report

**Via dashboard:** The footer shows a progress bar with emerald
(<70%), amber (<90%), red (>=90%) buckets. The Model Routing tab
shows the full breakdown.

**Via API:**

```bash
curl https://your-app/api/agent/status | jq '.budget'
```

Response:

```json
{
  "day": {
    "llmRequests": 47,
    "llmTokens": 38291,
    "webRequests": 12,
    "rpcRequests": 5,
    "executionTimeMs": 23891
  },
  "hour": {
    "llmRequests": 5,
    "llmTokens": 2981,
    "webRequests": 0,
    "rpcRequests": 0,
    "executionTimeMs": 1200
  },
  "limits": {
    "dailyLlmTokens": 250000,
    "hourlyLlmTokens": 40000,
    "perTaskLlmTokens": 8000
  }
}
```

### When caps are exceeded

| Cap | Effect |
|---|---|
| Daily LLM tokens | Cycle aborts cleanly with `skipReason="Budget: daily LLM tokens exhausted"`. |
| Hourly LLM tokens | Same as daily. |
| Per-task LLM tokens | `callLLM` returns `fallback_action: "queue_task"`. The orchestrator queues the opportunity. |
| Daily web requests | Scanner adapters start returning `{ opportunities: [], error: "daily web budget exhausted" }`. |
| Daily RPC requests | Wallet adapters return zero-balance rows with `error: "daily RPC budget exhausted"`. |

The dashboard footer shows the budget-red state. To recover:

1. **Wait** — hourly caps reset on the next UTC hour, daily caps
   reset on the next UTC day.
2. **Increase caps** — set `DAILY_LLM_TOKENS`, `HOURLY_LLM_TOKENS`,
   etc. via env vars and restart the dev server.
3. **Reset the period** — delete the matching `BudgetUsage` rows
   (advanced, see [CONFIGURATION.md](./CONFIGURATION.md#8-how-to-change-budget-limits)).

---

## 6. Monitoring wallet balances

The wallet monitor in [`src/lib/wallet/monitor.ts`](../src/lib/wallet/monitor.ts)
refreshes every monitored wallet's balance in parallel on every
cycle. The snapshot is persisted to `data/wallet-snapshot.json`
(the dashboard's source of truth).

### Reading balances

**Via dashboard:** Go to the **Wallets** tab. Each wallet has a
card showing native balance, USD value, token balances, explorer
link, fetched-at timestamp, and an error badge if the adapter
failed.

**Via API:**

```bash
curl https://your-app/api/wallet/balances | jq
```

Response:

```json
{
  "wallets": [
    {
      "label": "MetaMask (EVM) Wallet",
      "chain": "ethereum",
      "address": "0xd6DF...D997",
      "nativeBalance": 0.0,
      "nativeSymbol": "ETH",
      "usdValue": 0.0,
      "tokens": [],
      "fetchedAt": "2024-12-12T10:30:00.000Z"
    }
    // ... 4 more
  ],
  "totalUsd": 0.0,
  "fetchedAt": "2024-12-12T10:30:00.000Z"
}
```

### Forcing a refresh

**Via dashboard:** Click the **Refresh Wallets** button on the
Wallets tab.

**Via API:**

```bash
curl https://your-app/api/wallet/balances
```

The endpoint forces a refresh (parallel adapter fetch + persist
snapshot) and returns the result.

### Reading transactions

```bash
curl "https://your-app/api/wallet/transactions?limit=50&chain=ethereum" | jq
```

### Scanning for incoming payments

```bash
curl -X POST https://your-app/api/wallet/transactions \
  -H "Content-Type: application/json" \
  -d '{"since": "2024-12-11T00:00:00Z"}'
```

Runs `scanForIncomingPayments({ since })` across every monitored
wallet. Returns the `ScanPaymentsSummary`:

```json
{
  "summary": {
    "scannedWallets": 5,
    "fetchedTransactions": 12,
    "newTransactions": 3,
    "duplicates": 9,
    "errors": {},
    "startedAt": "...",
    "finishedAt": "..."
  }
}
```

### Expected state: $0.00 balances

All 5 monitored wallets are public read-only addresses that may have
zero balance. This is **expected** — the agent does not need a
balance to monitor incoming payments. The read-only adapters don't
require any on-chain activity to function.

If you want to test payment verification end-to-end, send a small
amount (e.g. 0.001 ETH) to one of the monitored addresses and click
**Refresh Wallets**. The next payment scan will pick up the incoming
tx.

---

## 7. Reading the event log

The event log is the append-only audit trail of every agent action.
It's the operator's primary debugging tool.

### Listing recent events

**Via dashboard:** Go to the **Events** tab. Use the level / agent /
limit filters to narrow down.

**Via API:**

```bash
# Last 50 events of any level
curl "https://your-app/api/events?limit=50" | jq

# Critical events only
curl "https://your-app/api/events?level=critical&limit=50" | jq

# Events from the orchestrator agent
curl "https://your-app/api/events?agent=orchestrator&limit=50" | jq

# Events for a specific opportunity
curl "https://your-app/api/events?opportunityId=opp_..." | jq
```

### Event fields

```json
{
  "id": "evt_...",
  "taskId": "task_...",        // nullable
  "opportunityId": "opp_...",  // nullable
  "agent": "orchestrator",     // orchestrator|task_classifier|model_router|scout|research|...
  "level": "info",             // debug|info|warn|error|critical
  "event": "cycle_complete",   // event name
  "payload": { ... },          // JSON payload
  "createdAt": "2024-12-12T10:30:00.000Z"
}
```

### Levels

| Level | Meaning | Color |
|---|---|---|
| `debug` | Internal tracing (discovery_throttled, etc.) | gray |
| `info` | Normal operation (cycle_complete, specialist_dispatched, llm_call_succeeded) | blue |
| `warn` | Recoverable issue (specialist_failed, cycle_skipped_budget) | amber |
| `error` | Operator attention needed (tick_crashed, run_cycles_aborted_too_many_errors) | red |
| `critical` | Urgent (kill_switch_emergency, possible compromise) | red (bold) |

### Key event names to watch

| Event | Agent | Meaning |
|---|---|---|
| `agent_bootstrapped` | orchestrator | Bootstrap completed; models + strategies seeded |
| `cycle_complete` | orchestrator | One autonomous cycle finished |
| `cycle_skipped` | orchestrator | Cycle aborted (kill switch) |
| `cycle_skipped_budget` | orchestrator | Cycle aborted (budget) |
| `process_opportunity_started` | orchestrator | Lifecycle walker started |
| `process_opportunity_completed` | orchestrator | Lifecycle walker finished |
| `specialist_dispatched` | orchestrator | Specialist agent invoked |
| `specialist_failed` | orchestrator | Specialist returned `success=false` |
| `opportunity_queued` | orchestrator | Opportunity moved to `queued` |
| `opportunity_policy_rejected` | orchestrator | Policy engine rejected |
| `opportunity_status_overridden` | orchestrator | Operator manually patched status |
| `payment_verified` | payment | On-chain tx matched an opportunity |
| `payment_scan_complete` | payment | Wallet tx scan finished |
| `wallet_refresh` | payment | Wallet balances refreshed |
| `wallet_refresh_skipped` | payment | Refresh skipped (kill switch) |
| `approval_approved` / `approval_rejected` / `approval_skipped` | orchestrator | Operator decision recorded |
| `llm_call_succeeded` / `llm_call_failed` | model_router | LLM provider result |
| `model_blacklisted` | model_router | Circuit breaker tripped |
| `strategy_stats_bootstrapped` | economics | Canonical strategies seeded |

---

## 8. Interpreting the dashboard

The dashboard has 10 tabs. Each polls its own data on an appropriate
interval (Overview 5s, Tasks 15s, Events 10s, Wallets 30-60s,
Models/Strategies/Ledger 30s).

### Overview tab

- 6 KPI cards: Verified Earnings, Expected Earnings, Opportunities
  Discovered, Success Rate, Avg Hourly, Wallet Balance.
- 3 charts: earnings-over-time area, by-category donut, by-status
  vertical bar.
- Top-5 opportunities table with risk/verify ScoreBars + Process
  button.
- Last-5 active tasks list with from->to agent badges.
- Last-8 events feed.

### Opportunities tab

- 4 filters (status / category / source / sort) + search.
- Seed New button (force a fresh discovery pass).
- Table with 11 columns including risk/verify ScoreBars, status
  badge, View/ExternalLink actions.
- Click any row to open the Opportunity Detail Sheet (right side).

### Wallets tab

- 5 wallet cards (one per chain).
- Total portfolio card.
- Refresh Wallets button.
- Recent transactions table.

### Model Routing tab

- Budget usage panel (4 meters).
- Provider health cards (5 providers).
- Available Models table with capability mini-bars + edit dialog.
- Top-models-by-earnings + best-task-type panels.

### Strategies tab

- Exploration vs exploitation explainer (70/20/10 split).
- Avg-hourly bar chart across strategies.
- Ranked strategy table with discovered/attempted/completed/failed/
  successRate/totalNetUsd/avgHourly/effectiveAvgHourly columns.

### Ledger tab

- 7 totals cards (Gross / Net Verified / Expected / Fees / Expenses /
  Hours / Avg $/hr).
- Net-USD-by-strategy bar chart.
- Verified earnings list + expected earnings list with explorer links.

### Approvals tab

- Pending approvals with Approve/Reject/Skip buttons.
- Empty state: "No approvals pending. The agent is operating within
  policy."
- Decision history below.

### Tasks tab

- Status / limit filters.
- Table with from->to agent badges + status/risk/model/tokens/
  latency/quality columns.
- Click row -> dialog with pretty-printed input/output JSON.

### Events tab

- Level / agent / limit filters.
- Color-coded event log with collapsible JSON payloads.

### Architecture tab

- 11-stage lifecycle flow.
- 11 specialist agents grid.
- 4-level model router diagram.
- Security boundaries callout.

---

## 9. Manual operations

### Forcing a discovery cycle

```bash
curl -X POST https://your-app/api/opportunities/seed
```

Bypasses the 10-minute throttle. Returns the `DiscoverySummary`:

```json
{
  "summary": {
    "discovered": 44,
    "new": 0,
    "duplicates": 44,
    "rejected": 0,
    "byCategory": { "github_bounty": 31, "hackathon": 1, ... },
    "startedAt": "...",
    "finishedAt": "...",
    "skipped": false,
    "scannerErrors": []
  }
}
```

### Force-processing a specific opportunity

```bash
curl -X POST https://your-app/api/opportunities/OPP_ID/process
```

Runs `processOpportunity(id)` — walks the opportunity through its
full lifecycle (research -> verification -> economics -> planning ->
execution -> review -> payment). Returns a `ProcessOpportunityResult`
summarising every step.

This is useful when:
- You want to manually advance an opportunity that's stuck in
  `discovered` because the autonomous loop hasn't picked it up.
- You want to test the full pipeline end-to-end on a specific
  opportunity.
- You want to debug a failing step (the response includes per-step
  `success` and `notes`).

### Verifying a payment manually

```bash
curl -X POST https://your-app/api/opportunities/OPP_ID/verify-payment
```

Runs `verifyPaymentForOpportunity(id)`. Scans the `Transaction`
table for incoming txs matching the opportunity's expected reward
(±5% amount tolerance, 30-day window, currency match). On a match,
upgrades the ledger row from expected to verified.

Returns the `PaymentVerificationResult`:

```json
{
  "result": {
    "matched": true,
    "transactionHash": "0x...",
    "chain": "ethereum",
    "amount": 50,
    "currency": "USDC",
    "usdValue": 50,
    "status": "matched",
    "notes": [
      "Matched on ethereum tx 0x...",
      "Amount 50 USDC vs expected 50 USDC (Δ 0%)."
    ]
  }
}
```

If no match is found:

```json
{
  "result": {
    "matched": false,
    "status": "unverified",
    "notes": ["No matching transaction found in last 30 days"]
  }
}
```

### Overriding an opportunity's status

```bash
curl -X PATCH https://your-app/api/opportunities/OPP_ID \
  -H "Content-Type: application/json" \
  -d '{"status":"verified"}'
```

Only the `status` field is mutable. Valid values:
`discovered`, `researching`, `verified`, `rejected`, `queued`,
`planning`, `approved`, `executing`, `executed`, `awaiting_payment`,
`paid`, `failed`.

The change is logged via `logEvent("opportunity_status_overridden",
...)` for the audit trail.

### Updating a model's role / status / enabled

```bash
curl -X PATCH https://your-app/api/models/zai%2Fglm-4.6 \
  -H "Content-Type: application/json" \
  -d '{"role":"reviewer", "enabled": true, "status":"healthy"}'
```

Valid roles: `primary`, `secondary`, `reviewer`, `exploration`,
`disabled`.

Valid statuses: `healthy`, `degraded`, `unhealthy`, `blacklisted`.

---

## 10. When a provider is blacklisted

The circuit breaker in
[`src/lib/llm/circuit-breaker.ts`](../src/lib/llm/circuit-breaker.ts)
auto-blacklists a model after 10 failures in 60 seconds. The
blacklist auto-expires after 10 minutes (half-opens to `degraded`
so the next call can succeed).

### Symptoms

- The Model Routing tab shows a model with status `blacklisted`.
- The Events tab shows `model_blacklisted` events.
- LLM calls fall back to a different provider (the provider
  hierarchy is: same-provider -> cross-provider -> zai -> deterministic).

### Recovery

The blacklist auto-expires after 10 minutes. To force-clear it:

```bash
curl -X PATCH https://your-app/api/models/MODEL_ID \
  -H "Content-Type: application/json" \
  -d '{"status":"healthy"}'
```

This sets the DB status back to `healthy`. Note: the in-memory
circuit breaker may still hold the blacklist for the current
process lifetime. The next call after a successful response clears
the breaker state.

### Diagnosing the cause

Look for `llm_call_failed` events in the event log:

```bash
curl "https://your-app/api/events?level=warn&agent=model_router&limit=20" | jq
```

Common causes:
- API key expired or revoked.
- Provider rate limit exceeded (429).
- Provider 5xx errors.
- Model deprecated by the provider.

For API key issues, rotate the key and update the env var. For rate
limits, lower the budget caps (see
[CONFIGURATION.md](./CONFIGURATION.md#8-how-to-change-budget-limits)).
For model deprecation, update the seed model in
[`src/config/providers.ts`](../src/config/providers.ts).

---

## 11. Handling a kill-switch activation

If the agent halted unexpectedly, check the kill switch:

```bash
curl https://your-app/api/agent/status | jq '.killSwitch'
```

### Possible reasons

| `paused` | `emergencyStop` | Likely cause |
|---|---|---|
| true | false | Operator paused, OR `./PAUSE` file exists, OR `PAUSE_AGENT=true` env var set. |
| false | true | Operator emergency-stopped, OR `./STOP` file exists. |
| true | true | Both flags set (perhaps from an emergency-reset that didn't fully clear). |

### Clearing the kill switch

For a soft pause:

```bash
curl -X POST https://your-app/api/agent/resume
```

For an emergency stop (clears BOTH flags):

```bash
curl -X POST https://your-app/api/agent/emergency-reset
```

If a filesystem marker is set:

```bash
rm /path/to/project/PAUSE
rm /path/to/project/STOP
```

If the env var is set:

```bash
unset PAUSE_AGENT
# (restart the dev server to pick up the env change)
```

### Important caveat

The DB flags and the filesystem/env signals are independent. To
fully resume the agent, ALL of these must be cleared:

1. The DB `paused` / `emergencyStop` flags.
2. The `./PAUSE` / `./STOP` filesystem markers (if any).
3. The `PAUSE_AGENT` env var (if set).

The dashboard's `POST /api/agent/emergency-reset` only clears the DB
flags. The filesystem markers and env var require manual clearing.

### Verifying the agent is running

After clearing:

```bash
curl https://your-app/api/agent/status | jq '.canRun'
```

You should see:

```json
{
  "canRun": true,
  "reason": "ready"
}
```

Then click **Run Cycle** in the dashboard (or call
`POST /api/agent/run-cycle`) to verify the agent processes work
normally.

---

## Cross-references

- **Architecture** — see [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Setup** — see [SETUP.md](./SETUP.md)
- **Configuration** — see [CONFIGURATION.md](./CONFIGURATION.md)
- **API reference** — see [API.md](./API.md)
- **Common issues** — see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
- **Security** — see [SECURITY.md](./SECURITY.md)
