# Architecture

This document describes the architecture of the **Autonomous Zero-Cost Crypto
Earning Agent** (CryptoEarn Agent) — a Next.js 16 + TypeScript application that
runs a multi-agent LLM orchestrator and a real-time operator dashboard inside
a single deployable unit.

> **Design philosophy.** This is **not a chatbot.** The agent never free-forms
> conversation with a user. It autonomously discovers, evaluates, executes, and
> verifies crypto earning opportunities. Every external action is gated by a
> deterministic policy engine; the LLM proposes, deterministic code decides.

---

## Table of contents

1. [System overview](#1-system-overview)
2. [The 11-stage opportunity lifecycle](#2-the-11-stage-opportunity-lifecycle)
3. [Multi-agent orchestrator architecture](#3-multi-agent-orchestrator-architecture)
4. [The 11 specialist agents](#4-the-11-specialist-agents)
5. [4-level model routing system](#5-4-level-model-routing-system)
6. [Model registry and adaptive routing](#6-model-registry-and-adaptive-routing)
7. [Deterministic vs LLM responsibilities](#7-deterministic-vs-llm-responsibilities)
8. [Wallet system](#8-wallet-system)
9. [Payment verification pipeline](#9-payment-verification-pipeline)
10. [Earnings ledger](#10-earnings-ledger)
11. [Strategy learning loop](#11-strategy-learning-loop)
12. [Security boundaries](#12-security-boundaries)
13. [File-structure diagram](#13-file-structure-diagram)
14. [Data-flow diagram](#14-data-flow-diagram)

---

## 1. System overview

The CryptoEarn Agent is one Next.js 16 app server with three logical layers:

```
+------------------------------------------------------------------+
|  Dashboard (browser)                                             |
|  src/app/page.tsx -> src/components/dashboard/*                  |
|  TanStack Query polls /api/* every 5-60 s depending on the tab.  |
+--------------------------------+---------------------------------+
                                 |
                                 | HTTPS (relative URLs only)
                                 v
+------------------------------------------------------------------+
|  Next.js 16 App Router (server runtime)                          |
|  src/app/api/*  - 25 route handlers, all `force-dynamic`         |
|                  every response carries `Cache-Control: no-store`|
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|  Orchestrator + Specialist Agents  (TypeScript, plain modules)   |
|  src/lib/orchestrator/* + src/lib/agents/*                       |
|  Pure functions of DB state + LLM responses — never throws.     |
+----+-----------+-------------+--------------+-------------+------+
     |           |             |              |             |
     v           v             v              v             v
+---------+ +----------+ +-----------+ +------------+ +-----------+
| Wallet  | | LLM      | | Economics | | Security   | | Scanners  |
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

**One process.** The dev server (`bun run dev`) starts a single Next.js
process. The orchestrator loop runs synchronously inside `POST /api/agent/run-cycle`
— there is no separate worker thread. The dashboard polls the API to refresh
state. This keeps the deploy story trivial: drag the project to GitHub,
connect to Vercel, ship.

**Zero capital.** The agent never signs transactions, never sends native
tokens, and never stores private keys. Every monitored wallet is read-only.

**Zero cost.** All LLM providers in the registry are free-tier
(OpenRouter, Gemini, Groq, Cerebras, plus the Z.AI SDK that ships
provisioned in this environment). Hard budget caps in
[`src/lib/budget/manager.ts`](../src/lib/budget/manager.ts) prevent the
agent from blowing through free-tier quotas.

---

## 2. The 11-stage opportunity lifecycle

Every opportunity walks through this exact pipeline. Statuses (in
`Opportunity.status`) mirror the stage names.

```
DISCOVER        NORMALIZE       VERIFY          SCORE           PLAN
  |                |               |               |              |
  v                v               v               v              v
discovered  canonical_id     risk + verify  expected_value  specialist
row in DB   dedup hash       tier           hourly score    picked
                                                            |
APPROVAL     EXECUTE         VERIFY RESULT  VERIFY PAYMENT   RECORD PROFIT  LEARN
  |            |                |              |                |              |
  v            v                v              v                v              v
queued      executed        reviewed       matched tx       verified       StrategyStat
                                                                     |        +
                                                                     v        |
                                                                  Earning      |
                                                                     |        |
                                                                     v        v
                                                          expected -> verified (closed loop)
```

| # | Stage | Status written | Module / Agent |
|---|---|---|---|
| 1 | DISCOVER | `discovered` | `runDiscoveryCycle()` in [`src/lib/agent/scanners/index.ts`](../src/lib/agent/scanners/index.ts) |
| 2 | NORMALIZE | (in-memory) | `normalizeOpportunity()` in [`src/lib/agent/normalize.ts`](../src/lib/agent/normalize.ts) |
| 3 | VERIFY | `verified` / `rejected` | `verifyOpportunity()` in [`src/lib/agent/verification.ts`](../src/lib/agent/verification.ts) + Verification Agent |
| 4 | SCORE | (in-memory, then persisted) | `scoreOpportunity()` in [`src/lib/agent/scorer.ts`](../src/lib/agent/scorer.ts) + `computeEconomics()` in [`src/lib/economics/engine.ts`](../src/lib/economics/engine.ts) |
| 5 | PLAN | `queued` / `planning` | `decideNextSpecialist()` in [`src/lib/orchestrator/orchestrator.ts`](../src/lib/orchestrator/orchestrator.ts) |
| 6 | APPROVAL | `approved` | Policy engine + `Approval` table |
| 7 | EXECUTE | `executed` | Execution Agent + `IdempotencyRecord` |
| 8 | VERIFY RESULT | (Task row quality score) | Review Agent |
| 9 | VERIFY PAYMENT | `awaiting_payment` -> `paid` | Payment Agent + on-chain scan |
| 10 | RECORD PROFIT | `Earning{verified:true}` | `recordVerifiedEarning()` in [`src/lib/economics/ledger.ts`](../src/lib/economics/ledger.ts) |
| 11 | LEARN | (StrategyStat increments) | `recordStrategyOutcome()` in [`src/lib/economics/strategy-stats.ts`](../src/lib/economics/strategy-stats.ts) |

**Hard gates between stages.** A stage failure aborts the pipeline:

- `riskScore > 70` (scam hard cap) -> immediate `rejected`, no further
  stages run.
- `requiredLevel >= 2` and no approved `Approval` row -> pipeline waits
  at `queued` until the operator approves from the dashboard.
- Payment verifier returns `unverified` -> pipeline sits at
  `awaiting_payment` until a matching on-chain tx lands or the 30-day
  window expires.

Each cycle the orchestrator picks up opportunities that are mid-flight
(researching / planning / approved / executed / awaiting_payment) and
resumes them before starting any new ones.

---

## 3. Multi-agent orchestrator architecture

```
                 +-----------------------+
                 |   Orchestrator        |
                 | (src/lib/orchestrator)|
                 +-----------+-----------+
                             |
        +--------------------+--------------------+
        |                    |                    |
        v                    v                    v
+----------------+   +----------------+   +----------------+
| Task Classifier|   |  Model Router  |   |  Policy Engine |
| (keywordBased) |   | (4-level)      |   | (deterministic)|
+-------+--------+   +-------+--------+   +--------+-------+
        |                    |                     |
        v                    v                     v
        +--------------------+---------------------+
                             |
                             v
                  +----------+-----------+
                  | Specialist Agent Pool |
                  | (11 agents)          |
                  +----------+-----------+
                             |
                             v
                  +----------+-----------+
                  | Deterministic Tools  |
                  | (wallet, economics,  |
                  |  scam, url, code)    |
                  +----------+-----------+
                             |
                             v
                  +----------+-----------+
                  |    Verification      |
                  |  (on-chain + ledger)|
                  +----------+-----------+
                             |
                             v
                  +----------+-----------+
                  |     Result +         |
                  |   Learning Loop      |
                  +----------------------+
```

**Key invariant:** the orchestrator is the **only** component that creates
`Task` rows (spec §4M). Agents are pure executors: they receive an
`AgentInput` (with the task row already created), do their work, return an
`AgentOutput`. This centralises the audit trail and makes it impossible for
an agent to forget to log a handoff.

See [`src/lib/orchestrator/orchestrator.ts`](../src/lib/orchestrator/orchestrator.ts)
for the walker (`processOpportunity`, `decideNextSpecialist`,
`dispatchSpecialist`, `selectNextOpportunity`, `tick`, `queueForExecution`).

See [`src/lib/orchestrator/loop.ts`](../src/lib/orchestrator/loop.ts) for the
autonomous 10-step cycle (`runCycle`, `runCycles`).

---

## 4. The 11 specialist agents

Every agent lives in [`src/lib/agents/`](../src/lib/agents/) and exports a
single `async execute(input: AgentInput): Promise<AgentOutput>` function.
All agents share the [`AgentInput` / `AgentOutput` contract](../src/lib/agents/types.ts).

| # | Agent | File | Risk Level | Responsibility |
|---|---|---|---|---|
| 1 | Scout | [`scout-agent.ts`](../src/lib/agents/scout-agent.ts) | read | Run a discovery cycle; returns a `DiscoverySummary`. Suggests `research` as the next agent. |
| 2 | Research | [`research-agent.ts`](../src/lib/agents/research-agent.ts) | read | Sanitize description, route via LLM, call `callLLM` for findings (skills match, evidence quality, competition level, recommended next step). Falls back to heuristic findings on LLM failure. Transitions opportunity `discovered -> verified` when evidence_quality >= 7 and competition_level <= 6. |
| 3 | Verification | [`verification-agent.ts`](../src/lib/agents/verification-agent.ts) | read | Combines the deterministic 8-check verifier with the Security Agent's combined analysis. Persists `riskScore`, `verificationScore`, `confidence`. Hard cap `riskScore >= 70` -> `rejected`. |
| 4 | Economics | [`economics-agent.ts`](../src/lib/agents/economics-agent.ts) | read | Looks up `SourceReputation.reliability`, computes `agentSkillMatch` from `AGENT_CAPABLE_SKILLS`, calls the deterministic engine's `scoreOpportunity`. Persists `expectedValue`, `expectedHourly`, `riskAdjustedHourly`. **No LLM call** (spec §8 — LLM never does final arithmetic). |
| 5 | Coding | [`coding-agent.ts`](../src/lib/agents/coding-agent.ts) | low | Sanitize description, LLM produces a solution outline + code skeleton in strict JSON. Runs `inspectGeneratedCode` on every file (per-file + aggregate safety). Returns `success=true` ONLY when every file passes the safety check. Operates in a sandbox: generation + safety check only, NO execution. |
| 6 | Web3 | [`web3-agent.ts`](../src/lib/agents/web3-agent.ts) | moderate | LLM produces structured analysis: contract_summary, required_interactions[], trust_assumptions[], red_flags[]. Runs `inspectGeneratedCode("solidity")` on any provided contract source. **NEVER auto-approves** contract interactions — sets `requires_human_approval=true` when any interaction's risk != `read` or the safety inspector fires. |
| 7 | Writing | [`writing-agent.ts`](../src/lib/agents/writing-agent.ts) | low | LLM drafts markdown content + meets_requirements flag. Persists draft to `Task.output`. Routes ONLY docs/content/oss_contribution/grant categories here (spec §4B "only use when the opportunity actually rewards this type of work"). |
| 8 | Security | [`security-agent.ts`](../src/lib/agents/security-agent.ts) | (none — read-only) | Combines prompt-injection + URL + code-safety verdicts. LLM ambiguity second-opinion with strict JSON, may ADD up to +20 riskScore, never reduces. `shouldBlock=true` when riskScore >= 60. Maps findings onto the 15 hostile-audit scenarios. |
| 9 | Execution | [`execution-agent.ts`](../src/lib/agents/execution-agent.ts) | low | Final pre-flight gates: idempotency check, `assertPolicy`, required Approval row for level >= 2, create `IdempotencyRecord` BEFORE acting. Currently SIMULATED — marks opportunity `executed` and stamps `externalRef=simulated:<executionId>:<ts>`. Real submission adapters slot in here. |
| 10 | Payment | [`payment-agent.ts`](../src/lib/agents/payment-agent.ts) | read | Calls `verifyPaymentForOpportunity(id)`. On match: `convertExpectedToVerified` via ledger; if no expected row, `recordVerifiedEarning` as fresh verified earning. Marks `paid` + `paymentVerified=true`. On crash records a failed strategy outcome so the learning subsystem still gets the signal. |
| 11 | Review | [`review-agent.ts`](../src/lib/agents/review-agent.ts) | read | Uses a DIFFERENT model from the primary executor (spec §4B). Calls `callLLM` for a verdict: `accept|reject|needs_revision`, qualityScore 0..10, issues[] with severity. Falls back to `needs_revision` on LLM failure (never auto-accept). Routes nextAgent back to executor when needs_revision or to `execution` when accept. |

The **orchestrator itself** is the implicit 12th "agent" — `from_agent="orchestrator"`
on every created Task. The `AgentName` union in
[`src/lib/agent/types.ts`](../src/lib/agent/types.ts) also includes `task_classifier`
and `model_router` for event-log attribution, but those are dispatched inline
rather than as separate agents.

---

## 5. 4-level model routing system

Implemented in [`src/lib/llm/router.ts`](../src/lib/llm/router.ts). The
router answers one question: *"given a task description, which model(s)
should handle it?"*

```
+--------------------------------------------------------------+
| LEVEL 1  Deterministic                                       |
| No LLM call. Dispatched to src/lib/llm/deterministic.ts.      |
| Detected by keyword: wallet / arithmetic / JSON validation / |
| file operation.                                              |
+------------------------------+-------------------------------+
                               |
                               v
+--------------------------------------------------------------+
| LEVEL 2  Cheap Classifier                                    |
| Single model, low complexity, low risk.                      |
| Keyword classifier returns task_type and required_caps.      |
+------------------------------+-------------------------------+
                               |
                               v
+--------------------------------------------------------------+
| LEVEL 3  Specialist                                          |
| Single model, specialist domain (security, web3, medium+     |
| complexity, moderate risk).                                  |
+------------------------------+-------------------------------+
                               |
                               v
+--------------------------------------------------------------+
| LEVEL 4  Multi-Model Panel                                   |
| Top-N models (default 3). Used for high-complexity or        |
| high-risk tasks. Reviews converge via the Review Agent.      |
+--------------------------------------------------------------+
```

**Routing level escalation (spec §4F):**

| Condition | Routing Level |
|---|---|
| Deterministic task keyword match | 1 |
| Risk = `high` OR complexity = `high` | 4 (panel) |
| Task type = `security` OR `web3` | 3 |
| Complexity = `medium` OR risk = `moderate` | 3 |
| Else (low complexity + low risk) | 2 |

**Complexity from description length:**

| Length (chars) | Complexity |
|---|---|
| < 100 | low |
| 100-500 | medium |
| > 500 | high |

**Keyword precedence** (first match wins):

```
web3 > security > coding > research > writing > general
```

A "verify this solidity contract is not malicious" query is classified as
`web3` (smart-contract context is the more discriminating signal) rather
than `security`. The optional `domain` hint in `classifyTask` short-circuits
the keyword scan when the caller knows the domain (e.g. the Research Agent
passes `domain: "research"`).

---

## 6. Model registry and adaptive routing

The model registry in [`src/lib/llm/registry.ts`](../src/lib/llm/registry.ts)
is backed by the `ModelRecord` Prisma table. Seed models are defined in
[`src/config/providers.ts`](../src/config/providers.ts):

| Model ID | Provider | Role | Specialty |
|---|---|---|---|
| `zai/glm-4.6` | zai | primary | All-round reasoning + coding (always-on in this env) |
| `openrouter/auto` | openrouter | primary | Auto-routed across many models |
| `gemini/gemini-2.0-flash` | gemini | secondary | Web research, fast turnaround |
| `groq/llama-3.3-70b-versatile` | groq | primary | Low latency (Llama 3.3 70B) |
| `cerebras/llama-3.1-70b` | cerebras | exploration | Ultra-low latency inference |
| `gemini/gemini-2.5-pro` | gemini | reviewer | Independent review (different model from primary) |

### Adaptive scoring (spec §4I, §4K)

```
weighted_score =
    avg_capability_for_required * 0.4
  + success_rate * 30
  + avg_quality * 3
  - avg_latency_ms * 0.001
```

Where `success_rate`, `avg_quality`, `avg_latency`, `avg_tokens` come from
the per-task-type `ModelPerformance` row if it exists; otherwise they fall
back to the seed `performance` block.

The per-task-type stats are tracked in the `ModelPerformance` table with an
exponential moving average (alpha = 0.2) for `avgLatencyMs`, `avgTokens`,
`avgQuality`, and atomic `{ increment: N }` for `attempts`, `successes`,
`failures`, `earningsUsd`. The unique key is `[modelId, taskType]`.

### Exploration vs exploitation (spec §4J)

`ROUTING_EXPLORATION` in [`src/config/providers.ts`](../src/config/providers.ts):

| Split | Percentage | Behaviour |
|---|---|---|
| `exploit_best` | 80% | Use the top-ranked eligible model |
| `explore_promising` | 15% | Pick from top-3 (60% rank 1, 30% rank 2, 10% rank 3) |
| `experiment_unknown` | 5% | Pick a random eligible model |

For panel routing (level 4), the top-N models are returned. With a 15%
chance, rank-1 is swapped for a rank-2..5 explorer so the panel sees one
slightly-off-best model.

### Circuit breaker

[`src/lib/llm/circuit-breaker.ts`](../src/lib/llm/circuit-breaker.ts) is an
in-memory per-model breaker (singleton per process):

| Failures in 60s | Status |
|---|---|
| 0 | healthy |
| 3 | degraded |
| 5 | unhealthy |
| 10 | blacklisted (10-minute cool-off) |

A successful call clears the failure window and (unless blacklisted)
flips back to `healthy`. The blacklist auto-expires (half-opens to
`degraded` when the window elapses) so the next call can succeed and
flip fully back.

### Fallback hierarchy

When the chosen model fails (after retries), the provider
([`src/lib/llm/provider.ts`](../src/lib/llm/provider.ts)) walks:

```
same-provider fallback -> cross-provider -> zai (always-on) -> deterministic -> queue
```

The result object always carries a `fallback_action` so the orchestrator
can dispatch on:

- `degrade_to_deterministic` -> route to `src/lib/llm/deterministic.ts`
- `queue_task` -> mark opportunity `queued`, wait for budget

---

## 7. Deterministic vs LLM responsibilities

The pipeline is shaped so that **the LLM proposes, deterministic code
decides.** Spec §8, §18, §21 are explicit about this.

| Layer | LLM (proposes) | Deterministic (decides) |
|---|---|---|
| Discovery | (none) | Scanner adapters normalize + dedup + insert |
| Scam detection | (none) | `detectScam()` returns riskScore 0-100, `isScam = riskScore >= 70` |
| Verification | (none) | `verifyOpportunity()` 8-check engine |
| Economics | (none) | `computeEconomics()` pure math |
| Research | Findings, evidence quality, competition level | Sanitization, status transition rules |
| Coding | Solution outline + file contents | `inspectGeneratedCode` blocks unsafe patterns |
| Web3 | Contract summary, red flags | `inspectGeneratedCode("solidity")` + `requires_human_approval` gate |
| Writing | Markdown draft | Format validation |
| Security | Ambiguity second-opinion (strict JSON, +0..20 additive) | Prompt-injection scan, URL validation, code-safety scan |
| Execution | (none — currently simulated) | Idempotency, policy gate, Approval gate |
| Payment | (none) | On-chain tx scan + ±5% amount match |
| Review | Verdict + qualityScore | Different-model enforcement; fallback `needs_revision` on failure |

**The LLM is never given a path around:**

1. The scam-risk hard cap (`riskScore > 70 -> reject`).
2. The policy engine (`assertPolicy` final gate before external action).
3. The deterministic economic math (every dollar value cited in the
   final report comes from `computeEconomics`, not from an LLM).
4. The wallet system — there is no signing code path anywhere in
   the repository.

---

## 8. Wallet system

[`src/lib/wallet/`](../src/lib/wallet/) implements spec §12. Five public
read-only wallets are configured in [`src/config/wallets.ts`](../src/config/wallets.ts):

| Label | Chain | Address | Adapter |
|---|---|---|---|
| Ronin Wallet | ronin | `0xAa4E76e5Be5334c0f2Fe0716C42B2FC61D4c150B` | `adapters/ronin.ts` |
| MetaMask (EVM) Wallet | ethereum | `0xd6DFE6b54bF3dBC919Fde57009452fe6bbb0D997` | `adapters/evm.ts` |
| Bitcoin Wallet | bitcoin | `bc1qh3areygq598ntxht0yp5yv87ej7g6aqvw8fl4z` | `adapters/bitcoin.ts` |
| Solana Wallet | solana | `2emXSLoziaB5wdC8y48ovbu41agh9PzR5ro8o7kRDUvM` | `adapters/solana.ts` |
| Tron Wallet | tron | `TJxkyJW57Tb8qmvvv5rCh3L2FYssRvWFEv` | `adapters/tron.ts` |

**Invariants:**

- **Read-only.** No private keys, seed phrases, or recovery phrases are
  ever stored, transmitted, or read. Every adapter operates exclusively
  against the public read-only REST/RPC endpoints of the chain's
  canonical explorer.
- **No signing path.** There is no signing or broadcasting code anywhere
  in the wallet subsystem.
- **Failure-tolerant.** Every adapter returns a zero-balance
  `WalletBalance` with `error` populated on failure — never throws.
  `fetchAllWallets` uses `Promise.allSettled` so a single adapter
  crash cannot block the others.
- **Snapshot file.** `refreshWallets()` writes `data/wallet-snapshot.json`
  on every cycle. `getWalletSnapshots()` reads from disk (or
  cold-starts a refresh). This decouples dashboard reads from RPC
  calls — a dashboard polling every 2 s doesn't generate 5 RPC calls
  per poll, only one disk read.
- **USD valuation conservative.** When the upstream API provides a live
  price (Blockscout's `exchange_rate`), the adapter uses it; otherwise
  it falls back to the `NATIVE_PRICE_FALLBACK_USD` constants for
  display only. Verified earnings store the USD value at the time of
  payment verification, never the display snapshot.

---

## 9. Payment verification pipeline

[`src/lib/wallet/payment-verifier.ts`](../src/lib/wallet/payment-verifier.ts)
implements spec §13.

```
scanForIncomingPayments({since?})
   |
   | for every wallet, run adapter.fetchTransactionsForChain in parallel
   v
Transaction table upsert (unique on [chain, txHash])
   |  -- existing rows NEVER overwritten: matched/verificationStatus preserved
   v
verifyPaymentForOpportunity(opportunityId)
   |
   | load opportunity.rewardAmount + rewardCurrency
   | query Transaction table for direction=incoming, recipient in WALLETS,
   |   blockTimestamp >= now - 30d, currency matches (case-insensitive)
   v
   +--- match?  amount within +/-5% of expected?
   |              |
   |              v  yes
   |    mark tx: matched=true, verificationStatus="matched",
   |            opportunityId=<id>
   |    convertExpectedToVerified(opportunityId, paymentDetails)
   |       -- upgrades the ledger row
   |    mark opportunity: status="paid", paymentVerified=true
   |    recordStrategyOutcome({ completed:true, netUsd, hoursSpent })
   |    return { matched:true, status:"matched", ... }
   |
   +--- no match?
              |
              v
              return { matched:false, status:"unverified",
                       notes:["No matching transaction found in last 30 days"] }
```

**Tolerances:**

- Amount: ±5% of `opportunity.rewardAmount`.
- Currency: case-insensitive string match.
- Time window: last 30 days.
- "Best match" picks the lowest amount-delta, preferring unmatched
  transactions over already-matched ones (so a single tx can't be
  claimed by two opportunities).
- Ronin transactions: the public Ronin RPC does not expose a key-less
  tx-list endpoint, so `fetchRoninTransactions` returns a soft error.
  The verifier falls back to EVM/Solana/Tron/BTC matching for those
  currencies.

---

## 10. Earnings ledger

[`src/lib/economics/ledger.ts`](../src/lib/economics/ledger.ts) implements
spec §14. The ledger uses the `Earning` Prisma table with two distinct
boolean flags:

```
Earning
  expected  Boolean @default(false)  -- queued, not yet observed on-chain
  verified  Boolean @default(false)  -- on-chain tx matched
```

**The two never mix.** A row is either `(expected=true, verified=false)`
or `(expected=false, verified=true)`. The lifecycle is:

```
opportunity queued             recordExpected(opportunity)
   |                                   |
   | creates Earning{ expected:true,  |
   |   verified:false,                 |
   |   netUsd=expectedValue,           |
   |   hoursSpent=estimatedHours }     |
   v                                   v
on-chain tx matched              convertExpectedToVerified(id, paymentDetails)
   |                                   |
   | mutates the same Earning row:    |
   |   expected = false                |
   |   verified = true                 |
   |   grossUsd / feesUsd / expensesUsd / netUsd
   |     = real on-chain amounts      |
   |   transactionHash / chain          |
   |   = matched tx details            |
   v                                   v
recordStrategyOutcome({ completed:true, netUsd, hoursSpent })
   -- closes the feedback loop into strategy learning
```

`recordVerifiedEarning(input)` is the standalone variant for an
out-of-band bounty payout (no expected row existed — verified earning
recorded fresh, still increments the matching StrategyStat row).

`getTotals()` produces the dashboard rollup: `verifiedNetUsd`,
`expectedNetUsd`, `totalGrossUsd`, `totalHours`, `avgHourlyReturn`,
`opportunitiesAttempted`, `opportunitiesCompleted`, `successRate`, plus
per-category and per-source breakdowns.

---

## 11. Strategy learning loop

[`src/lib/economics/strategy-stats.ts`](../src/lib/economics/strategy-stats.ts)
implements spec §15 and §16. The 11 canonical strategies mirror the
legitimate `OpportunityCategory` values:

```
github_bounty, hackathon, docs, developer_task, coding_task,
data_task, freelance, grant, ecosystem, content, oss_contribution
```

(`bounty`, `bug_bounty`, `referral` are intentionally omitted — `bounty`
and `bug_bounty` are rolled up into `github_bounty`/`ecosystem` for
strategy-learning purposes; `referral` is on the prohibited-perimeter list
in spec §3.)

### Tracking fields

| Field | Type | Description |
|---|---|---|
| `discovered` | int | Incremented when an opportunity with this category is discovered. |
| `rejected` | int | Incremented when the policy engine rejects. |
| `attempted` | int | Incremented when execution starts. |
| `completed` | int | Incremented when a verified payment lands. |
| `failed` | int | Incremented when execution fails (no payment, broken submission). |
| `totalGrossUsd` | float | Sum of gross USD across completed attempts. |
| `totalNetUsd` | float | Sum of net USD (gross - fees - expenses). |
| `totalHours` | float | Sum of hours spent on attempts. |
| `avgHourly` | float (derived) | `totalNetUsd / totalHours` |
| `successRate` | float (derived) | `completed / attempted` |

### Ranking + exploration bonus

`rankStrategies()` sorts by `effectiveAvgHourly` DESC. Strategies with
fewer than `MIN_ATTEMPTS` (3) attempts get an exploration-bonus floor of
`$5/hr` so newly-seeded strategies still get tried (spec §16). Without
this floor, a brand-new strategy with zero attempts would always rank
last and never accumulate data.

### Cycle-level selection

`selectStrategyForCycle(explorationRatio = 0.3)`:

| Roll (Math.random) | Pick |
|---|---|
| 0.0 - 0.7 | Exploit: top-ranked strategy |
| 0.7 - 0.9 | Explore: mid-ranked strategy (25-75 percentile of the pack) |
| 0.9 - 1.0 | Experimental: a low-attempts strategy (< 3 attempts) |

`Math.random()` is used here only — this is the **one** place in the
economics subsystem where randomness is allowed (spec §16
exploration-vs-exploitation is inherently stochastic). The
`computeEconomics` math stays 100% deterministic.

### Closed loop

```
discover -> recordStrategyOutcome({discovered:true})
   |
   v
attempt  -> recordStrategyOutcome({attempted:true})
   |
   v
verify   -> recordStrategyOutcome({completed:true, netUsd, hoursSpent})
   |              |
   |              v
   |        avgHourly + successRate recomputed
   |              |
   v              v
next cycle selectStrategyForCycle reads updated stats
   |
   v
agent targets the highest-ranked strategy with exploration bonus
```

---

## 12. Security boundaries

Cross-cutting, defense-in-depth layers:

```
+------------------------------------------------------------------+
|  External content (issue bodies, README files, web pages,        |
|  contract source code)                                           |
|  -- UNTRUSTED DATA (spec §21)                                    |
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|  Boundary 1: Anti-prompt-injection sanitiser                     |
|  src/lib/security/prompt-injection.ts                            |
|  - Critical patterns: +30 each (override, identity, exfil, code)|
|  - Suspicious patterns: +10 each                                 |
|  - SAFE_THRESHOLD = 40, DANGEROUS_THRESHOLD = 80                 |
|  - Above dangerous: content DROPPED, sanitized = ""              |
|  - Below dangerous: wrapped in BEGIN/END UNTRUSTED delimiters    |
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|  Boundary 2: URL validator                                       |
|  src/lib/security/url-validator.ts                              |
|  - Scheme allow-list (http/https by default)                    |
|  - Private IP / localhost / link-local rejection (SSRF guard)    |
|  - IDN homograph detection (Latin+Cyrillic mix = block)          |
|  - Suspicious-TLD list (.xyz, .top, .click, ...)                |
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|  Boundary 3: Code-safety inspector                              |
|  src/lib/security/code-safety.ts                                |
|  - Universal patterns (eval, rm -rf, sudo, long blobs)          |
|  - JS/TS patterns (child_process, fs.writeFile to system paths)  |
|  - Solidity patterns (delegatecall, selfdestruct, approve(max))  |
|  - Python / Shell patterns                                       |
|  - SAFE_THRESHOLD = 50 (riskScore < 50)                         |
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|  Boundary 4: Scam detection                                     |
|  src/lib/security/scam-detection.ts                             |
|  - Critical: +40 each (seed_phrase, private_key, drainer, etc.) |
|  - Warn: +15 each (upfront payment, referral, etc.)              |
|  - Info: +5 each                                                 |
|  - isScam = riskScore >= 70 (hard cap, policy engine rejects)    |
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|  Boundary 5: Policy engine                                       |
|  src/lib/policy.ts                                              |
|  - Hard cap: riskScore > 70 -> REJECT                           |
|  - Hard cap: capitalRequired + observe mode -> REJECT            |
|  - Hard cap: reward > $1000 + !paymentVerified -> REJECT         |
|  - Referral / airdrop -> require Level 3 (human approval)        |
|  - Band: 0-30 -> L1, 31-55 -> L2, 56-70 -> L3                    |
|  - assertPolicy = final gate before any external action          |
+--------------------------------+---------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
|  Boundary 6: Kill switch + budget caps + idempotency            |
|  src/lib/kill-switch.ts + src/lib/budget/manager.ts             |
|  - DB flag + filesystem marker + env var (OR-ed)                 |
|  - Daily / hourly / per-task token caps                         |
|  - IdempotencyRecord(executionId = `${oppId}:${action}`)        |
+------------------------------------------------------------------+
```

See [SECURITY.md](./SECURITY.md) and [THREAT_MODEL.md](./THREAT_MODEL.md)
for the full hostile audit.

---

## 13. File-structure diagram

```
cryptoearn-agent/
+-- src/
|   +-- app/
|   |   +-- api/                         # 25 route handlers (Next.js 16 App Router)
|   |   |   +-- agent/
|   |   |   |   +-- status/             # GET  - dashboard control panel
|   |   |   |   +-- pause/              # POST - soft-pause kill switch
|   |   |   |   +-- resume/             # POST - clear soft-pause
|   |   |   |   +-- emergency-stop/    # POST - hard-stop
|   |   |   |   +-- emergency-reset/   # POST - clear both flags
|   |   |   |   +-- autonomy/          # POST - set observe|assist|semi|full
|   |   |   |   +-- run-cycle/         # POST - run N cycles synchronously
|   |   |   +-- opportunities/
|   |   |   |   +-- route.ts            # GET  - list + filter + sort
|   |   |   |   +-- [id]/
|   |   |   |   |   +-- route.ts        # GET / PATCH (status override)
|   |   |   |   |   +-- process/        # POST - walk lifecycle
|   |   |   |   |   +-- verify-payment/ # POST - run payment verifier
|   |   |   |   +-- seed/              # POST - force a discovery pass
|   |   |   +-- wallet/
|   |   |   |   +-- balances/          # GET  - refresh + return snapshot
|   |   |   |   +-- transactions/      # GET / POST (scan)
|   |   |   +-- approvals/             # GET / POST decision
|   |   |   +-- ledger/                # GET  + totals/
|   |   |   +-- strategies/            # GET  - ranked strategies
|   |   |   +-- models/                # GET / PATCH [id]
|   |   |   +-- analytics/             # GET  - unified dashboard payload
|   |   |   +-- tasks/                 # GET / GET [id]
|   |   |   +-- events/                # GET  - filterable event log
|   |   +-- layout.tsx
|   |   +-- page.tsx                    # server wrapper
|   |   +-- globals.css
|   +-- components/
|   |   +-- dashboard/                  # 18 dashboard components
|   |   +-- ui/                         # 60+ shadcn primitives
|   +-- config/
|   |   +-- wallets.ts                  # WALLETS + NATIVE_PRICE_FALLBACK_USD
|   |   +-- sources.ts                  # SOURCES + AGENT_CAPABLE_SKILLS + PROHIBITED_PATTERNS
|   |   +-- providers.ts                # SEED_MODELS + PROVIDER_BASE_URL + BUDGET_LIMITS
|   +-- lib/
|   |   +-- agent/
|   |   |   +-- types.ts                # canonical types (Opportunity, AgentName, ...)
|   |   |   +-- normalize.ts            # RawOpportunityInput -> NormalizedOpportunity
|   |   |   +-- scorer.ts               # applies scam + verification verdicts
|   |   |   +-- verification.ts          # 8-check deterministic verifier
|   |   |   +-- events.ts               # append-only event log
|   |   |   +-- state.ts                # AgentState singleton + canRun
|   |   |   +-- scanners/
|   |   |       +-- index.ts             # runDiscoveryCycle
|   |   |       +-- github-scanner.ts    # GitHub Search API adapter
|   |   |       +-- mock-scanner.ts      # 14 deterministic mock opportunities
|   |   +-- agents/                      # 11 specialist agents
|   |   |   +-- types.ts                 # AgentInput / AgentOutput contract
|   |   |   +-- scout-agent.ts
|   |   |   +-- research-agent.ts
|   |   |   +-- verification-agent.ts
|   |   |   +-- economics-agent.ts
|   |   |   +-- coding-agent.ts
|   |   |   +-- web3-agent.ts
|   |   |   +-- writing-agent.ts
|   |   |   +-- security-agent.ts
|   |   |   +-- execution-agent.ts
|   |   |   +-- payment-agent.ts
|   |   |   +-- review-agent.ts
|   |   +-- economics/
|   |   |   +-- engine.ts                # pure deterministic math
|   |   |   +-- strategy-stats.ts        # strategy learning + selection
|   |   |   +-- ledger.ts                # earnings ledger
|   |   +-- llm/
|   |   |   +-- registry.ts              # ModelRecord CRUD + ModelPerformance
|   |   |   +-- router.ts                # classifyTask -> selectModel -> route
|   |   |   +-- provider.ts              # callLLM (never throws)
|   |   |   +-- circuit-breaker.ts       # in-memory per-model breaker
|   |   |   +-- deterministic.ts         # LEVEL 1 wallet/arithmetic/JSON/file
|   |   +-- wallet/
|   |   |   +-- monitor.ts               # refreshWallets + snapshot
|   |   |   +-- payment-verifier.ts      # spec §13
|   |   |   +-- adapters/
|   |   |       +-- evm.ts               # Ethereum mainnet via Blockscout
|   |   |       +-- bitcoin.ts           # blockchain.info
|   |   |       +-- solana.ts           # mainnet-beta RPC
|   |   |       +-- tron.ts             # TronGrid
|   |   |       +-- ronin.ts            # Ronin RPC
|   |   |       +-- index.ts            # adapter registry + fetchAllWallets
|   |   +-- security/
|   |   |   +-- prompt-injection.ts      # anti-injection sanitiser
|   |   |   +-- url-validator.ts        # SSRF / IDN / scheme guard
|   |   |   +-- code-safety.ts           # generated-code inspector
|   |   |   +-- scam-detection.ts       # 17-signal scam detector
|   |   |   +-- threat-model.ts         # 15 hostile-audit scenarios
|   |   +-- orchestrator/
|   |   |   +-- orchestrator.ts          # processOpportunity + dispatchSpecialist
|   |   |   +-- loop.ts                  # runCycle + runCycles
|   |   |   +-- bootstrap.ts            # one-shot startup seeding
|   |   +-- budget/
|   |   |   +-- manager.ts              # BudgetManager singleton
|   |   +-- policy.ts                   # deterministic policy engine
|   |   +-- kill-switch.ts              # OR-ed DB + filesystem + env
|   |   +-- db.ts                       # Prisma client singleton
|   |   +-- utils.ts                    # cn() tailwind helper
+-- prisma/
|   +-- schema.prisma                   # 13 models (Opportunity, Task, Earning, ...)
+-- public/
|   +-- agent-logo.png
|   +-- logo.svg
+-- docs/                                # this documentation suite
+-- package.json
+-- next.config.ts
+-- tailwind.config.ts
+-- eslint.config.mjs
+-- .env                                 # DATABASE_URL only
+-- worklog.md                           # shared handover log
```

---

## 14. Data-flow diagram

```
                          +-----------+
                          | Operator  |
                          | (browser) |
                          +-----+-----+
                                |
                                | click "Run Cycle"
                                v
                  +-------------+-------------+
                  |  POST /api/agent/run-cycle |
                  +-------------+-------------+
                                |
                                v
                  +-------------+-------------+
                  | bootstrapAgent() (1x)     |
                  |  - bootstrapModels()      |
                  |  - bootstrapStrategies()  |
                  |  - ensure AgentState      |
                  |  - initial discovery      |
                  +-------------+-------------+
                                |
                                v
                  +-------------+-------------+
                  | runCycles(1, {delayMs})   |
                  +-------------+-------------+
                                |
                                v
                  +-------------+-------------+
                  | 1. refreshKillSwitchState |  (fs markers + DB + env)
                  +-------------+-------------+
                                |
                                v
                  +-------------+-------------+
                  | 2. canRun() gate          |  -- abort if paused
                  +-------------+-------------+
                                |
                                v
                  +-------------+-------------+
                  | 3. budget.assertWithin   |  -- abort if caps exceeded
                  +-------------+-------------+
                                |
                                v
                  +-------------+-------------+
                  | 4. refreshWallets()       |  -- parallel adapter fetch
                  +-------------+-------------+
                                |
                                v
                  +-------------+-------------+
                  | 5. throttled discovery   |  -- 10-minute throttle
                  |    runDiscoveryCycle()    |
                  +-------------+-------------+
                                |
                                v
                  +-------------+-------------+
                  | 6. selectStrategyForCycle|  -- 70/20/10 explore
                  +-------------+-------------+
                                |
                                v
                  +-------------+-------------+
                  | 7. selectNextOpportunity |  -- resume mid-flight first
                  +-------------+-------------+
                                |
                                v
                  +-------------+-------------+
                  | 8. processOpportunity(id)|  -- walks lifecycle
                  +-------------+-------------+
                                |
            +-------------------+-------------------+
            |                                       |
            v                                       v
  +---------+---------+                  +----------+---------+
  | decideNextSpecialist |                | dispatchSpecialist  |
  | (status -> agent)    |                | - creates Task row  |
  +---------+---------+                  | - marks running     |
            |                              | - calls execute()   |
            v                              | - marks success/fail|
  +---------------------+                  +----------+---------+
  | specialist.execute()|                            |
  |  - sanitize inputs  |                            v
  |  - route via LLM    |                  +---------+---------+
  |  - callLLM()        |                  | logEvent + Task    |
  |  - inspect result   |                  | update             |
  +---------+-----------+                  +---------+---------+
            |                                        |
            v                                        v
  +---------+-----------+                  +---------+---------+
  | Deterministic tools |                  | DB writes          |
  | (computeEconomics,  |                  | (Opportunity, Task,|
  |  inspectGenerated   |                  |  Earning, Approval,|
  |  Code, etc.)        |                  |  IdempotencyRecord)|
  +---------+-----------+                  +---------+---------+
            |                                        |
            v                                        v
  +---------+-----------+                  +---------+---------+
  | Policy + scam gates |                  | Strategy stats    |
  | (assertPolicy,      |                  | increment          |
  |  detectScam, etc.) |                  +---------+---------+
  +---------------------+                            |
                                                     v
                                          +---------+---------+
                                          | 9. payment scan   |
                                          |    + retry await_  |
                                          |    payment opps    |
                                          +---------+---------+
                                                    |
                                                    v
                                          +---------+---------+
                                          | 10. markCycle()   |
                                          +-------------------+
                                                    |
                                                    v
                                          +---------+---------+
                                          | logEvent           |
                                          | "cycle_complete"   |
                                          +-------------------+
                                                    |
                                                    v
                                          +---------+---------+
                                          | CycleSummary[]    |
                                          | returned to API   |
                                          +-------------------+
```

---

## Cross-references

- **Setup & deployment** — see [SETUP.md](./SETUP.md)
- **Configuration files** — see [CONFIGURATION.md](./CONFIGURATION.md)
- **Day-to-day operations** — see [OPERATIONS.md](./OPERATIONS.md)
- **Strategy catalogue** — see [STRATEGIES.md](./STRATEGIES.md)
- **API reference** — see [API.md](./API.md)
- **Security overview** — see [SECURITY.md](./SECURITY.md)
- **Hostile audit (15 scenarios)** — see [THREAT_MODEL.md](./THREAT_MODEL.md)
- **Common issues** — see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
