# API Reference

This document is the complete reference for every HTTP endpoint
exposed by the CryptoEarn Agent. All endpoints are implemented as
Next.js 16 App Router route handlers under
[`src/app/api/`](../src/app/api/).

Every route:

- Is `force-dynamic` (never statically optimized).
- Returns `Cache-Control: no-store`.
- Calls `bootstrapAgent()` first (idempotent — first call seeds the
  DB; subsequent calls are no-ops).
- Returns JSON.
- Never throws uncaught — every error is caught and returned as a
  JSON `{ error: string }` with status 500.

---

## Table of contents

1. [Conventions](#1-conventions)
2. [Agent Control](#2-agent-control)
3. [Opportunities](#3-opportunities)
4. [Wallets](#4-wallets)
5. [Approvals](#5-approvals)
6. [Ledger](#6-ledger)
7. [Strategies](#7-strategies)
8. [Models](#8-models)
9. [Analytics](#9-analytics)
10. [Tasks](#10-tasks)
11. [Events](#11-events)
12. [Root](#12-root)

---

## 1. Conventions

### Base URL

In development: `http://localhost:3000`.
In production: your deployment URL (e.g. `https://cryptoearn-agent.vercel.app`).

### Authentication

None. The dashboard runs in the same origin and the API is open to
anyone with the URL. For production, put the deployment behind
authentication (Vercel Password / Cloudflare Access / etc.).

### Content-Type

- `GET` requests: no body.
- `POST` / `PATCH` requests: `application/json` body (when a body is
  expected). Missing / invalid JSON bodies are handled gracefully —
  the endpoint either falls back to defaults or returns HTTP 400.

### Error responses

```json
{ "error": "human-readable error message" }
```

| Status | Meaning |
|---|---|
| 200 | Success |
| 400 | Bad request (missing required field, invalid enum value) |
| 404 | Resource not found |
| 500 | Server error (DB failure, unexpected exception) |

### Path parameters

Dynamic `[id]` parameters use the Next.js 16 Promise-params signature.
URL-encode special characters (e.g. `zai/glm-4.6` -> `zai%2Fglm-4.6`).

### Rate limits

None enforced at the API layer. The agent's own LLM/RPC/web rate
limits are enforced by the budget manager (see
[OPERATIONS.md](./OPERATIONS.md#5-monitoring-budgets)).

---

## 2. Agent Control

Endpoints for the dashboard's top-level control panel.

### GET /api/agent/status

Returns the agent's runtime state plus everything the dashboard needs
to render the top-level control panel in a single round-trip.

```bash
curl https://your-app/api/agent/status
```

**Response:**

```json
{
  "running": false,
  "paused": false,
  "emergencyStop": false,
  "autonomyMode": "observe",
  "lastCycleAt": "2024-12-12T10:30:00.000Z",
  "lastCycleResult": "processed:verified",
  "cycleCount": 42,
  "canRun": {
    "canRun": true,
    "reason": "ready"
  },
  "budget": {
    "day": { "llmRequests": 47, "llmTokens": 38291, "webRequests": 12, "rpcRequests": 5, "executionTimeMs": 23891 },
    "hour": { "llmRequests": 5, "llmTokens": 2981, "webRequests": 0, "rpcRequests": 0, "executionTimeMs": 1200 },
    "limits": { "dailyLlmTokens": 250000, "hourlyLlmTokens": 40000, "perTaskLlmTokens": 8000 }
  },
  "killSwitch": {
    "paused": false,
    "emergencyStop": false,
    "reason": null,
    "fetchedAt": 1702376400000
  },
  "walletSummary": {
    "totalUsd": 0,
    "fetchedAt": "2024-12-12T10:30:00.000Z"
  }
}
```

### POST /api/agent/pause

Engage the soft-pause kill switch. In-flight cycles finish but no new
cycles start.

```bash
curl -X POST https://your-app/api/agent/pause \
  -H "Content-Type: application/json" \
  -d '{"reason":"investigating issue"}'
```

**Body:**

```json
{ "reason": "string (optional)" }
```

**Response:** Updated `state` + `killSwitch` snapshot.

### POST /api/agent/resume

Clear the soft-pause flag.

```bash
curl -X POST https://your-app/api/agent/resume
```

**Response:** Updated `state` + `killSwitch` snapshot.

### POST /api/agent/emergency-stop

Engage the hard-stop kill switch. In-flight tasks MUST abort as soon
as possible.

```bash
curl -X POST https://your-app/api/agent/emergency-stop \
  -H "Content-Type: application/json" \
  -d '{"reason":"suspected compromise"}'
```

**Body:**

```json
{ "reason": "string (optional)" }
```

**Response:** Updated `state` + `killSwitch` snapshot.

### POST /api/agent/emergency-reset

Clears BOTH the emergency-stop AND the soft-pause flags. Use this
when the operator has resolved whatever triggered the emergency stop.

```bash
curl -X POST https://your-app/api/agent/emergency-reset
```

**Response:** Updated `state` + `killSwitch` snapshot.

### POST /api/agent/autonomy

Switch the agent's autonomy mode.

```bash
curl -X POST https://your-app/api/agent/autonomy \
  -H "Content-Type: application/json" \
  -d '{"mode":"semi"}'
```

**Body:**

```json
{ "mode": "observe|assist|semi|full" }
```

Returns HTTP 400 if `mode` is missing or not one of the four valid
values.

**Response:** Updated `state`.

### POST /api/agent/run-cycle

Run one or more autonomous cycles synchronously and return the
summaries.

```bash
# One cycle
curl -X POST https://your-app/api/agent/run-cycle \
  -H "Content-Type: application/json" \
  -d '{}'

# Five cycles, 2-second delay between each
curl -X POST https://your-app/api/agent/run-cycle \
  -H "Content-Type: application/json" \
  -d '{"cycles": 5, "delayMs": 2000}'
```

**Body:**

```json
{
  "cycles": "number (default 1, max 20)",
  "delayMs": "number (default 1000, max 60000)"
}
```

**Response:**

```json
{
  "cycles": [
    {
      "cycle": 43,
      "startedAt": "...",
      "finishedAt": "...",
      "skipped": false,
      "discovered": 44,
      "discoveredNew": 0,
      "selectedOpportunityId": "opp_...",
      "strategy": "github_bounty",
      "processed": { "opportunityId": "...", "finalStatus": "verified", ... },
      "paymentsVerified": 0,
      "errors": []
    }
  ],
  "count": 1
}
```

Hard caps: `cycles` max 20, `delayMs` max 60000. The endpoint is
synchronous — for >5 cycles the request may exceed the dev server's
HTTP timeout.

---

## 3. Opportunities

Endpoints for browsing and managing opportunities.

### GET /api/opportunities

List opportunities with filters + sort.

```bash
curl "https://your-app/api/opportunities?status=discovered&category=github_bounty&sort=score&limit=50&offset=0"
```

**Query params:**

| Param | Default | Description |
|---|---|---|
| `status` | (none) | Filter by status: `discovered`, `researching`, `verified`, `rejected`, `queued`, `planning`, `approved`, `executing`, `executed`, `awaiting_payment`, `paid`, `failed` |
| `category` | (none) | Filter by category: `github_bounty`, `hackathon`, `docs`, etc. |
| `source` | (none) | Filter by source: `github_issues`, `mock_bounties`, etc. |
| `sort` | `score` | One of `score` (riskAdjustedHourly DESC), `reward` (rewardUsd DESC), `newest` (createdAt DESC), `deadline` (deadline ASC) |
| `limit` | `50` | Max rows (hard cap 200) |
| `offset` | `0` | Pagination offset |

**Response:**

```json
{
  "opportunities": [
    {
      "id": "opp_...",
      "canonicalId": "sha256...",
      "title": "...",
      "description": "...",
      "source": "github_issues",
      "sourceUrl": "https://github.com/...",
      "organization": "...",
      "category": "github_bounty",
      "reward": { "amount": 500, "currency": "USDC", "estimated_usd": 500 },
      "deadline": "2024-12-19T00:00:00.000Z",
      "requirements": ["..."],
      "skillsRequired": ["typescript"],
      "estimatedHours": 8,
      "difficulty": 5,
      "competition": 4,
      "eligibility": [],
      "paymentMethod": "...",
      "paymentVerified": true,
      "sourceVerified": true,
      "capitalRequired": false,
      "riskScore": 0,
      "verificationScore": 100,
      "confidence": 1.0,
      "status": "verified",
      "expectedValue": 350,
      "expectedHourly": 43.75,
      "riskAdjustedHourly": 40.0,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "count": 50,
  "total": 44,
  "filteredTotal": 12
}
```

### GET /api/opportunities/[id]

Return a single opportunity, including related tasks, earnings,
transactions, approvals, and events.

```bash
curl https://your-app/api/opportunities/opp_...
```

**Response:**

```json
{
  "opportunity": {
    "id": "opp_...",
    "title": "...",
    // ... (all fields from the Opportunity model)
    "tasks": [ ... ],         // up to 200 most recent
    "earnings": [ ... ],       // up to 50 most recent
    "transactions": [ ... ],   // up to 50 most recent
    "approvals": [ ... ],      // up to 50 most recent
    "events": [ ... ]          // up to 100 most recent
  }
}
```

Returns HTTP 404 if the opportunity doesn't exist.

### PATCH /api/opportunities/[id]

Operator override — manually update the opportunity's status. Only
the `status` field is mutable.

```bash
curl -X PATCH https://your-app/api/opportunities/opp_... \
  -H "Content-Type: application/json" \
  -d '{"status":"verified"}'
```

**Body:**

```json
{ "status": "OpportunityStatus" }
```

Valid statuses: `discovered`, `researching`, `verified`, `rejected`,
`queued`, `planning`, `approved`, `executing`, `executed`,
`awaiting_payment`, `paid`, `failed`.

Returns HTTP 400 if `status` is missing or invalid. HTTP 404 if the
opportunity doesn't exist.

**Response:** The updated opportunity.

The change is logged via `logEvent("opportunity_status_overridden",
...)`.

### POST /api/opportunities/[id]/process

Run the orchestrator's `processOpportunity(id)` against this
opportunity. Walks the opportunity through its full lifecycle
(research -> verification -> economics -> planning -> execution ->
review -> payment).

```bash
curl -X POST https://your-app/api/opportunities/opp_.../process
```

**Response:**

```json
{
  "result": {
    "opportunityId": "opp_...",
    "initialStatus": "discovered",
    "finalStatus": "verified",
    "steps": [
      {
        "agent": "research",
        "taskId": "task_...",
        "success": true,
        "nextAgent": "verification",
        "notes": []
      }
    ],
    "aborted": false
  }
}
```

### POST /api/opportunities/[id]/verify-payment

Run the payment verifier against this opportunity. The verifier
looks up the opportunity's expected reward (amount + currency) and
searches the `Transaction` table for a matching incoming payment on
one of our monitored wallets.

```bash
curl -X POST https://your-app/api/opportunities/opp_.../verify-payment
```

**Response:**

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

### POST /api/opportunities/seed

Force a fresh discovery pass — bypasses the 10-minute throttle the
autonomous loop applies.

```bash
curl -X POST https://your-app/api/opportunities/seed
```

**Response:** The `DiscoverySummary`:

```json
{
  "summary": {
    "discovered": 44,
    "new": 0,
    "duplicates": 44,
    "rejected": 0,
    "byCategory": { "github_bounty": 31, "hackathon": 1, "docs": 1, ... },
    "startedAt": "...",
    "finishedAt": "...",
    "skipped": false,
    "scannerErrors": []
  }
}
```

---

## 4. Wallets

### GET /api/wallet/balances

Force a refresh of every monitored wallet's balance, then return
the snapshot.

```bash
curl https://your-app/api/wallet/balances
```

**Response:**

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

The refresh respects the kill switch — if the agent is paused or
emergency-stopped, the monitor returns the last cached snapshot
rather than hitting any RPC.

### GET /api/wallet/transactions

Return the most recent N transactions from the DB.

```bash
curl "https://your-app/api/wallet/transactions?limit=50&chain=ethereum"
```

**Query params:**

| Param | Default | Description |
|---|---|---|
| `limit` | `50` | Max rows (hard cap 200) |
| `chain` | (none) | Filter by chain: `ethereum`, `bitcoin`, `solana`, `tron`, `ronin` |

**Response:**

```json
{
  "transactions": [
    {
      "id": "tx_...",
      "opportunityId": null,
      "chain": "ethereum",
      "txHash": "0x...",
      "fromAddress": "0x...",
      "toAddress": "0x...",
      "amount": 50,
      "currency": "USDC",
      "usdValue": 50,
      "tokenContract": null,
      "blockTimestamp": "2024-12-12T10:00:00.000Z",
      "confirmations": 12,
      "direction": "incoming",
      "matched": false,
      "verificationStatus": "unverified",
      "createdAt": "2024-12-12T10:30:00.000Z"
    }
  ],
  "count": 1
}
```

### POST /api/wallet/transactions

Trigger a payment scan across every monitored wallet.

```bash
curl -X POST https://your-app/api/wallet/transactions \
  -H "Content-Type: application/json" \
  -d '{"since": "2024-12-11T00:00:00Z"}'
```

**Body:**

```json
{ "since": "ISO date string (optional, default 24h ago)" }
```

**Response:** The `ScanPaymentsSummary`:

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

---

## 5. Approvals

### GET /api/approvals

List `Approval` rows.

```bash
curl "https://your-app/api/approvals?status=pending&limit=50"
```

**Query params:**

| Param | Default | Description |
|---|---|---|
| `status` | `pending` | One of `pending`, `approved`, `rejected`, `skipped` |
| `limit` | `50` | Max rows (hard cap 200) |

Each row includes the related opportunity (id, title, category,
source, rewardUsd, riskScore, expectedValue, riskAdjustedHourly).

**Response:**

```json
{
  "approvals": [
    {
      "id": "approval_...",
      "opportunityId": "opp_...",
      "taskId": null,
      "riskLevel": "moderate",
      "executionLevel": 2,
      "reason": "referral/airdrop category requires human approval...",
      "status": "pending",
      "decidedAt": null,
      "decidedBy": null,
      "createdAt": "...",
      "opportunity": { "id": "opp_...", "title": "...", ... }
    }
  ],
  "count": 1
}
```

### POST /api/approvals/[id]

Record an operator decision on a pending Approval row.

```bash
curl -X POST https://your-app/api/approvals/approval_... \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve", "decidedBy":"alice"}'
```

**Body:**

```json
{
  "decision": "approve|reject|skip",
  "decidedBy": "string (optional, default 'operator')"
}
```

Returns HTTP 400 if `decision` is missing or invalid.

**Side effects:**

- The `Approval` row's `status` / `decidedAt` / `decidedBy` are updated.
- The decision is logged via `logEvent("approval_<decision>d", ...)`.
- On `approve`: the related opportunity (if any) is queued for
  execution via `queueForExecution(opportunityId)`.

**Response:**

```json
{
  "approval": { "id": "approval_...", "status": "approved", ... },
  "queueResult": {
    "queued": true,
    "requiresApproval": false,
    "reason": "riskScore=30, autonomyMode=semi"
  }
}
```

---

## 6. Ledger

### GET /api/ledger

Return `LedgerEntry` rows from the `Earning` table.

```bash
curl "https://your-app/api/ledger?verified=true&limit=50&source=github_issues&category=github_bounty"
```

**Query params:**

| Param | Default | Description |
|---|---|---|
| `verified` | (none) | `true` = only verified rows; `false` = only expected (not-yet-verified) rows; (none) = both |
| `limit` | `50` | Max rows (hard cap 200) |
| `source` | (none) | Filter by source (applied post-fetch) |
| `category` | (none) | Filter by category (applied post-fetch) |

**Response:**

```json
{
  "ledger": [
    {
      "id": "earning_...",
      "opportunityId": "opp_...",
      "source": "github_issues",
      "category": "github_bounty",
      "grossUsd": 500,
      "feesUsd": 0,
      "expensesUsd": 4,
      "netUsd": 496,
      "hoursSpent": 8,
      "hourlyReturn": 62,
      "currency": "USDC",
      "verified": true,
      "expected": false,
      "transactionHash": "0x...",
      "chain": "ethereum",
      "strategy": "github_bounty",
      "createdAt": "..."
    }
  ],
  "count": 1
}
```

### GET /api/ledger/totals

Aggregate the entire ledger into a single snapshot.

```bash
curl https://your-app/api/ledger/totals
```

**Response:**

```json
{
  "totals": {
    "verifiedNetUsd": 496,
    "expectedNetUsd": 1000,
    "totalGrossUsd": 1500,
    "totalHours": 12,
    "avgHourlyReturn": 41.33,
    "opportunitiesAttempted": 5,
    "opportunitiesCompleted": 4,
    "successRate": 0.8,
    "byCategory": {
      "github_bounty": { "netUsd": 496, "hoursSpent": 8, "attempts": 2 }
    },
    "bySource": {
      "github_issues": { "netUsd": 496, "hoursSpent": 8, "attempts": 2 }
    }
  }
}
```

---

## 7. Strategies

### GET /api/strategies

Return the ranked strategy stats.

```bash
curl https://your-app/api/strategies
```

Each row carries both the raw `avgHourly` and the
exploration-boosted `effectiveAvgHourly` (the latter is what the
strategy selector uses).

**Response:**

```json
{
  "strategies": [
    {
      "id": "stat_...",
      "strategy": "github_bounty",
      "discovered": 32,
      "rejected": 2,
      "attempted": 5,
      "completed": 4,
      "failed": 1,
      "totalGrossUsd": 2000,
      "totalNetUsd": 1980,
      "totalHours": 40,
      "avgHourly": 49.5,
      "successRate": 0.8,
      "updatedAt": "...",
      "effectiveAvgHourly": 49.5
    }
    // ... 10 more
  ],
  "count": 11
}
```

---

## 8. Models

### GET /api/models

Return the LLM model registry.

```bash
curl "https://your-app/api/models?enabled=true&role=primary&status=healthy"
```

**Query params:**

| Param | Default | Description |
|---|---|---|
| `enabled` | (none) | `true` = only enabled models; `false` = only disabled |
| `role` | (none) | One of `primary`, `secondary`, `reviewer`, `exploration`, `disabled` |
| `status` | (none) | One of `healthy`, `degraded`, `unhealthy`, `blacklisted` |

Each row carries the deserialized JSON fields (`capabilities`,
`performance`, `limits`).

**Response:**

```json
{
  "models": [
    {
      "model_id": "zai/glm-4.6",
      "provider": "zai",
      "api_type": "zai",
      "enabled": true,
      "role": "primary",
      "status": "healthy",
      "capabilities": {
        "reasoning": 9.2, "coding": 9.0, "research": 8.8, ...
      },
      "performance": {
        "success_rate": 0.92, "average_quality": 8.9, ...
      },
      "limits": {
        "requests_per_minute": 30, ...
      },
      "earnings_contribution_usd": 0
    }
    // ... 5 more
  ],
  "count": 6
}
```

### PATCH /api/models/[id]

Update a model record's role / enabled flag / health status.

```bash
curl -X PATCH https://your-app/api/models/zai%2Fglm-4.6 \
  -H "Content-Type: application/json" \
  -d '{"role":"reviewer", "enabled": true, "status":"healthy"}'
```

Note: URL-encode `/` as `%2F` in the path.

**Body:**

```json
{
  "role": "primary|secondary|reviewer|exploration|disabled (optional)",
  "enabled": "boolean (optional)",
  "status": "healthy|degraded|unhealthy|blacklisted (optional)"
}
```

At least one of the three fields must be set; otherwise HTTP 400.
Returns HTTP 404 if the model doesn't exist.

**Response:** The updated model record (with deserialized JSON fields).

The change is logged via `logEvent("model_record_updated", ...)`.

---

## 9. Analytics

### GET /api/analytics

Unified analytics payload for the dashboard's main overview screen.
Pulls together everything the dashboard needs in ONE round-trip.

```bash
curl https://your-app/api/analytics
```

**Response (truncated for brevity):**

```json
{
  "totalVerifiedEarningsUsd": 496,
  "totalExpectedEarningsUsd": 1000,
  "totalGrossUsd": 1500,
  "opportunitiesDiscovered": 44,
  "opportunitiesAttempted": 5,
  "opportunitiesCompleted": 4,
  "successRate": 0.8,
  "avgHourlyReturn": 41.33,
  "totalHoursSpent": 12,
  "topStrategies": [ ... ],         // top 5 by avgHourly
  "topModels": [ ... ],             // top 5 by earnings contribution
  "recentEvents": [ ... ],          // last 20 agent events
  "budgetReport": { ... },          // same shape as /api/agent/status budget
  "walletSummary": {
    "totalUsd": 0,
    "fetchedAt": "...",
    "walletCount": 5
  },
  "charts": {
    "earningsOverTime": [           // last 14 days, by day
      { "date": "2024-12-01", "verifiedUsd": 0, "expectedUsd": 0 },
      // ... 13 more
    ],
    "opportunitiesByCategory": [
      { "category": "github_bounty", "count": 31 },
      // ...
    ],
    "opportunitiesByStatus": [
      { "status": "discovered", "count": 20 },
      // ...
    ],
    "earningsByCategory": [
      { "category": "github_bounty", "netUsd": 496, "hoursSpent": 8, "attempts": 2 }
    ],
    "earningsBySource": [
      { "source": "github_issues", "netUsd": 496, "hoursSpent": 8, "attempts": 2 }
    ]
  }
}
```

This endpoint runs all reads in parallel via `Promise.all`. On a
cold cache this is ~5 DB queries + 4 lib calls + 1 file read (wallet
snapshot) — typically completes in <200ms.

---

## 10. Tasks

### GET /api/tasks

List recent `Task` rows.

```bash
curl "https://your-app/api/tasks?status=success&limit=50"
```

**Query params:**

| Param | Default | Description |
|---|---|---|
| `status` | (none) | One of `pending`, `running`, `success`, `failed`, `skipped`, `cancelled` |
| `limit` | `50` | Max rows (hard cap 200) |

**Response:**

```json
{
  "tasks": [
    {
      "id": "task_...",
      "opportunityId": "opp_...",
      "parentTaskId": null,
      "fromAgent": "orchestrator",
      "toAgent": "research",
      "objective": "Deep-research the opportunity...",
      "input": "{}",
      "output": "{ ... }",
      "status": "success",
      "riskLevel": "read",
      "executionLevel": 0,
      "modelId": "zai/glm-4.6",
      "tokensUsed": 1450,
      "latencyMs": 1800,
      "qualityScore": 8.5,
      "startedAt": "...",
      "completedAt": "...",
      "createdAt": "..."
    }
  ],
  "count": 1
}
```

### GET /api/tasks/[id]

Return a single Task by id, including its related opportunity (if
any) and its recent events.

```bash
curl https://your-app/api/tasks/task_...
```

**Response:**

```json
{
  "task": {
    "id": "task_...",
    "opportunityId": "opp_...",
    // ... (all Task fields)
    "opportunity": {
      "id": "opp_...",
      "title": "...",
      "category": "github_bounty",
      "source": "github_issues",
      "rewardUsd": 500,
      "status": "verified"
    },
    "events": [ ... ]   // up to 100 most recent events for this task
  }
}
```

Returns HTTP 404 if the task doesn't exist.

---

## 11. Events

### GET /api/events

List recent `AgentEvent` rows from the append-only event log.

```bash
curl "https://your-app/api/events?level=warn&agent=orchestrator&opportunityId=opp_...&limit=100"
```

**Query params:**

| Param | Default | Description |
|---|---|---|
| `level` | (none) | One of `debug`, `info`, `warn`, `error`, `critical` |
| `agent` | (none) | Agent name: `orchestrator`, `task_classifier`, `model_router`, `scout`, `research`, `verification`, `economics`, `coding`, `web3`, `writing`, `security`, `execution`, `payment`, `review` |
| `opportunityId` | (none) | Filter by opportunity id |
| `limit` | `100` | Max rows (hard cap 500) |

**Response:**

```json
{
  "events": [
    {
      "id": "evt_...",
      "taskId": "task_...",
      "opportunityId": "opp_...",
      "agent": "orchestrator",
      "level": "info",
      "event": "cycle_complete",
      "payload": { ... },
      "createdAt": "2024-12-12T10:30:00.000Z"
    }
  ],
  "count": 1
}
```

The `payload` field is JSON-parsed into a structured object. If the
stored payload wasn't valid JSON, it's wrapped as `{ raw: "..." }`.

---

## 12. Root

### GET /api

Health check.

```bash
curl https://your-app/api
```

**Response:**

```json
{ "message": "Hello, world!" }
```

This is the legacy route from the initial Next.js scaffold. Useful
for verifying the dev server is running.

---

## Quick reference: curl examples

```bash
# Agent control
curl https://your-app/api/agent/status
curl -X POST https://your-app/api/agent/pause -H "Content-Type: application/json" -d '{"reason":"lunch"}'
curl -X POST https://your-app/api/agent/resume
curl -X POST https://your-app/api/agent/emergency-stop -d '{"reason":"compromise"}'
curl -X POST https://your-app/api/agent/emergency-reset
curl -X POST https://your-app/api/agent/autonomy -H "Content-Type: application/json" -d '{"mode":"semi"}'
curl -X POST https://your-app/api/agent/run-cycle -H "Content-Type: application/json" -d '{"cycles":1}'

# Opportunities
curl "https://your-app/api/opportunities?status=verified&limit=20"
curl https://your-app/api/opportunities/opp_...
curl -X PATCH https://your-app/api/opportunities/opp_... -H "Content-Type: application/json" -d '{"status":"verified"}'
curl -X POST https://your-app/api/opportunities/opp_.../process
curl -X POST https://your-app/api/opportunities/opp_.../verify-payment
curl -X POST https://your-app/api/opportunities/seed

# Wallets
curl https://your-app/api/wallet/balances
curl "https://your-app/api/wallet/transactions?limit=50&chain=ethereum"
curl -X POST https://your-app/api/wallet/transactions -H "Content-Type: application/json" -d '{}'

# Approvals
curl https://your-app/api/approvals
curl -X POST https://your-app/api/approvals/approval_... -H "Content-Type: application/json" -d '{"decision":"approve"}'

# Ledger
curl "https://your-app/api/ledger?verified=true"
curl https://your-app/api/ledger/totals

# Strategies + Models
curl https://your-app/api/strategies
curl https://your-app/api/models
curl -X PATCH https://your-app/api/models/zai%2Fglm-4.6 -H "Content-Type: application/json" -d '{"status":"healthy"}'

# Analytics + Tasks + Events
curl https://your-app/api/analytics
curl "https://your-app/api/tasks?status=success&limit=20"
curl https://your-app/api/tasks/task_...
curl "https://your-app/api/events?level=critical&limit=20"
```

---

## Cross-references

- **Architecture** — see [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Operations** — see [OPERATIONS.md](./OPERATIONS.md)
- **Configuration** — see [CONFIGURATION.md](./CONFIGURATION.md)
- **Common issues** — see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
