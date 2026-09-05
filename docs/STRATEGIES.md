# Strategies

This document describes the 11 supported opportunity categories
(strategies) and how the agent approaches each, the strategy learning
loop, and how to add custom strategies.

---

## Table of contents

1. [The 11 supported strategies](#1-the-11-supported-strategies)
2. [Strategy learning loop](#2-strategy-learning-loop)
3. [Exploration vs exploitation (70/20/10)](#3-exploration-vs-exploitation-702010)
4. [How strategies are ranked](#4-how-strategies-are-ranked)
5. [How to add a custom strategy](#5-how-to-add-a-custom-strategy)
6. [Expected outcomes per strategy](#6-expected-outcomes-per-strategy)

---

## 1. The 11 supported strategies

The agent tracks 11 canonical strategies (spec §15). They mirror the
legitimate `OpportunityCategory` values defined in
[`src/lib/agent/types.ts`](../src/lib/agent/types.ts):

| # | Strategy | Description | Typical reward range | Typical time horizon |
|---|---|---|---|---|
| 1 | `github_bounty` | GitHub issues with `label:bounty` or `label:help-wanted` from OSS projects. | $50 - $2,000 | 2-20 hours |
| 2 | `hackathon` | Hackathon prize pools (ETHGlobal, Solana Ignition, etc.). | $1,000 - $25,000 | 24-72 hours |
| 3 | `docs` | Documentation bounties (write a tutorial, improve a README, etc.). | $100 - $1,000 | 1-8 hours |
| 4 | `developer_task` | Developer tasks (build an integration, write an SDK, etc.). | $500 - $5,000 | 5-40 hours |
| 5 | `coding_task` | General coding tasks (bug fixes, feature implementations, etc.). | $100 - $1,500 | 1-10 hours |
| 6 | `data_task` | Data labeling, scraping, or analysis tasks. | $50 - $500 | 1-5 hours |
| 7 | `freelance` | Freelance contracts (typically via a platform like Gitcoin). | $500 - $5,000 | 5-40 hours |
| 8 | `grant` | Ecosystem grants (Optimism RetroPGF, Ethereum Foundation Grants, etc.). | $5,000 - $50,000 | 20-200 hours |
| 9 | `ecosystem` | Ecosystem contribution programs (Lens, OnlyDust, etc.). | $200 - $2,000 | 4-30 hours |
| 10 | `content` | Content creation bounties (blog posts, video tutorials, etc.). | $100 - $1,000 | 2-15 hours |
| 11 | `oss_contribution` | Open-source contributions (Mirror.xyz, Juicebox DAO, etc.). | $50 - $500 | 2-10 hours |

### Omitted from canonical strategies

| Category | Why omitted |
|---|---|
| `bounty` | Rolled up into `github_bounty` (same skills, time horizon, risk profile). |
| `bug_bounty` | Rolled up into `github_bounty` for strategy-learning purposes; legit bug bounties are categorized via the source (e.g. Immunfi would surface here). |
| `referral` | On the prohibited-perimeter list (spec §3). The policy engine always requires Level 3 human approval for referral/airdrop, so they never auto-execute. |

### How the agent approaches each

The orchestrator's `decideNextSpecialist()` in
[`src/lib/orchestrator/orchestrator.ts`](../src/lib/orchestrator/orchestrator.ts)
routes the opportunity to the right specialist based on its category:

| Category | Specialist | Why |
|---|---|---|
| `github_bounty`, `coding_task`, `developer_task`, `data_task`, `freelance`, `ecosystem` | Coding Agent | Code generation fits these categories. |
| `hackathon` | Coding Agent | Same as above (or Web3 Agent if the description mentions smart contracts — currently a future improvement). |
| `docs`, `content`, `oss_contribution`, `grant` | Writing Agent | Markdown content fits these categories. |
| (future) smart-contract bounties | Web3 Agent | Currently the coding agent detects Solidity in the description and adjusts. |

Spec §4B: "Only use [the Writing Agent] when the opportunity actually
rewards this type of work." The orchestrator honours this by routing
only docs/content/oss_contribution/grant to the Writing Agent.

---

## 2. Strategy learning loop

The strategy learning subsystem in
[`src/lib/economics/strategy-stats.ts`](../src/lib/economics/strategy-stats.ts)
tracks per-strategy statistics. Every time the agent discovers,
attempted, completed, failed, or rejected an opportunity, it records
the outcome against the matching `StrategyStat` row (keyed by
`strategy` = the opportunity category).

### Lifecycle of a strategy stat row

```
bootstrapStrategies()              (called once at agent startup)
   |
   v
StrategyStat { attempted:0, completed:0, failed:0, totalNetUsd:0, totalHours:0,
               avgHourly:0, successRate:0, ... }
   |
   | agent discovers an opportunity with this category
   v
recordStrategyOutcome({ discovered:true })   -- discovered++
   |
   | agent attempts the opportunity (status="queued")
   v
recordStrategyOutcome({ attempted:true })    -- attempted++
   |
   | agent completes the opportunity (verified payment lands)
   v
recordStrategyOutcome({ completed:true, netUsd:X, hoursSpent:Y })
   |
   |   -- completed++
   |   -- totalNetUsd += X
   |   -- totalHours += Y
   |   -- avgHourly = totalNetUsd / totalHours
   |   -- successRate = completed / attempted
   |
   v
next cycle: selectStrategyForCycle reads the updated stats
   |
   v
agent targets the highest-ranked strategy with exploration bonus
```

### Closed feedback loop

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

This is spec §15's self-improvement loop. Every verified earning feeds
back into the strategy-learning subsystem, which informs the next
`selectStrategyForCycle` decision, which informs the next opportunity
the agent targets.

---

## 3. Exploration vs exploitation (70/20/10)

Implemented in `selectStrategyForCycle()` in
[`src/lib/economics/strategy-stats.ts`](../src/lib/economics/strategy-stats.ts).

| Roll (Math.random) | Pick |
|---|---|
| 0.0 - 0.7 | **Exploit (70%):** top-ranked strategy (best `effectiveAvgHourly`) |
| 0.7 - 0.9 | **Explore (20%):** mid-ranked strategy (25-75 percentile of the pack) |
| 0.9 - 1.0 | **Experimental (10%):** a low-attempts strategy (< 3 attempts) |

### Why exploration matters

A pure exploit strategy (always pick the top-ranked) would never try
new strategies. A pure explore strategy (always pick random) would
never benefit from learned stats. The 70/20/10 split balances both.

The split is parametric via `explorationRatio` (default `0.3` = 70/30
exploit/explore). The explore portion is further split 2:1 between
"explore mid-ranked" and "experimental low-attempts".

### The ONE place randomness is allowed

`Math.random()` is used here only — this is the **one** place in the
economics subsystem where randomness is allowed (spec §16
exploration-vs-exploitation is inherently stochastic). The
`computeEconomics` math stays 100% deterministic.

---

## 4. How strategies are ranked

`rankStrategies()` in
[`src/lib/economics/strategy-stats.ts`](../src/lib/economics/strategy-stats.ts)
sorts strategies by `effectiveAvgHourly` (descending).

### The exploration bonus

Strategies with fewer than `MIN_ATTEMPTS` (3) attempts get an
exploration-bonus floor of `$5/hr` so newly-seeded strategies still
get tried (spec §16). The bonus is a synthetic floor on `avgHourly`:

```typescript
effectiveAvgHourly =
  strategy.attempted < MIN_ATTEMPTS
    ? Math.max(strategy.avgHourly, EXPLORATION_BONUS_HOURLY)  // $5/hr floor
    : strategy.avgHourly;
```

### Why a floor of $5/hr?

Without this floor, a brand-new strategy with zero attempts would
always rank last and never accumulate data. The floor puts a
brand-new strategy somewhere in the middle of the pack — exploitable
enough to be tried, but not so high it displaces a proven winner.

### Each row carries both values

The `/api/strategies` endpoint returns each row with both:

```json
{
  "strategy": "github_bounty",
  "avgHourly": 25.50,
  "effectiveAvgHourly": 25.50,   // same as avgHourly (3+ attempts)
  "attempted": 5,
  "completed": 4,
  "successRate": 0.8,
  "totalNetUsd": 510.00,
  ...
}
```

For a new strategy:

```json
{
  "strategy": "data_task",
  "avgHourly": 0,                 // no attempts yet
  "effectiveAvgHourly": 5,         // exploration bonus floor
  "attempted": 0,
  "completed": 0,
  "successRate": 0,
  "totalNetUsd": 0,
  ...
}
```

### What counts as "an attempt"

A strategy's `attempted` counter is incremented when the orchestrator
calls `queueForExecution(opportunityId)` (which transitions the
opportunity from `verified` to `queued`). This means:

- Discovery does NOT count as an attempt (just `discovered++`).
- Rejection does NOT count as an attempt (just `rejected++`).
- Only actual execution attempts count.

This prevents the strategy ranking from being polluted by
opportunities the agent never seriously pursued.

### What counts as "completed"

The `completed` counter is incremented only when a verified payment
lands on a monitored wallet for an opportunity in this category.
Specifically:

- `recordVerifiedEarning(input)` is called (standalone verified earning).
- OR `convertExpectedToVerified(opportunityId, paymentDetails)` upgrades
  an existing expected earning to verified.

Both call `recordStrategyOutcome({ completed:true, netUsd, hoursSpent })`
so the strategy-learning subsystem gets the signal.

### What counts as "failed"

The `failed` counter is incremented when the Payment Agent fails to
verify a payment within the 30-day window (or when execution crashes).
Specifically, in the Payment Agent's catch branch:

```typescript
catch (err) {
  // Record a failed strategy outcome so the learning subsystem gets the signal.
  await recordStrategyOutcome(opportunity.category, {
    failed: true,
    netUsd: 0,
    hoursSpent: opportunity.estimatedHours,
  });
}
```

---

## 5. How to add a custom strategy

### Step 1: Add to `CANONICAL_STRATEGIES`

Open [`src/lib/economics/strategy-stats.ts`](../src/lib/economics/strategy-stats.ts)
and add your strategy to the array:

```typescript
export const CANONICAL_STRATEGIES = [
  "github_bounty",
  "hackathon",
  "docs",
  "developer_task",
  "coding_task",
  "data_task",
  "freelance",
  "grant",
  "ecosystem",
  "content",
  "oss_contribution",
  "your_new_strategy",   // <-- add here
] as const;
```

### Step 2: Add to `OpportunityCategory` (if it's a new category)

Open [`src/lib/agent/types.ts`](../src/lib/agent/types.ts) and add
the category to the union:

```typescript
export type OpportunityCategory =
  | "bounty"
  | "github_bounty"
  | "bug_bounty"
  | "hackathon"
  | "docs"
  | "developer_task"
  | "coding_task"
  | "data_task"
  | "freelance"
  | "grant"
  | "ecosystem"
  | "referral"
  | "content"
  | "oss_contribution"
  | "your_new_strategy";   // <-- add here
```

### Step 3: Add reward cap (if needed)

Open [`src/lib/security/scam-detection.ts`](../src/lib/security/scam-detection.ts)
and add the cap to `REWARD_CAP_BY_CATEGORY`:

```typescript
const REWARD_CAP_BY_CATEGORY: Record<OpportunityCategory, number> = {
  // ...
  your_new_strategy: 20_000,   // <-- add here
};
```

This is the cap above which the reward becomes implausible for the
category and the `unrealistic_reward` scam signal fires (+15 to
riskScore).

### Step 4: Restart the dev server

The next `bootstrapAgent()` call will upsert the new strategy row
into the `StrategyStat` table with zero counts. The exploration
bonus in `rankStrategies()` ensures it gets tried at least 3 times
before being ranked on raw `avgHourly`.

### Step 5: Optional — extend the mock scanner

If you want to test the new strategy with deterministic seed data,
add a mock opportunity with `category: "your_new_strategy"` in
[`src/lib/agent/scanners/mock-scanner.ts`](../src/lib/agent/scanners/mock-scanner.ts).
Follow the existing mock pattern:

```typescript
{
  source: "mock_bounties",
  sourceUrl: "https://example.com/your-new-strategy-bounty",
  title: "Your New Strategy Bounty - $500 for X implementation",
  description: "...",
  organization: "Your Org",
  category: "your_new_strategy",
  reward: { amount: 500, currency: "USDC", estimated_usd: 500 },
  deadline: daysFromNow(7),
  requirements: ["..."],
  skillsRequired: ["typescript"],
  estimatedHours: 10,
  difficulty: 4,
  competition: 3,
  eligibility: [],
  paymentMethod: "USDC on completion",
  capitalRequired: false,
},
```

### Step 6: Optional — add a real scanner

If you have a real source for your new strategy (e.g. a grants API),
implement a scanner adapter in
[`src/lib/agent/scanners/`](../src/lib/agent/scanners/) and register
it in [`src/config/sources.ts`](../src/config/sources.ts). See
[CONFIGURATION.md](./CONFIGURATION.md#6-how-to-add-a-new-opportunity-source)
for details.

---

## 6. Expected outcomes per strategy

Based on the mock scanner data + spec examples + the deterministic
economic engine (spec §8), here's what you can expect per strategy
in a typical cycle.

### Mock data seed (14 opportunities)

The mock scanner in
[`src/lib/agent/scanners/mock-scanner.ts`](../src/lib/agent/scanners/mock-scanner.ts)
generates 14 deterministic opportunities:

| # | Category | Reward USD | Estimated Hours | Difficulty | Org |
|---|---|---|---|---|---|
| 1 | `github_bounty` | $500 | 8 | 5 | Lens Protocol |
| 2 | `bug_bounty` | $2,000 | 20 | 8 | Solana Foundation |
| 3 | `hackathon` | $5,000 | 36 | 7 | Gitcoin |
| 4 | `docs` | $300 | 4 | 3 | OnlyDust |
| 5 | `developer_task` | $1,500 | 16 | 6 | Replit |
| 6 | `coding_task` | $800 | 6 | 4 | Vercel |
| 7 | `data_task` | $200 | 3 | 3 | Dune |
| 8 | `freelance` | $3,000 | 24 | 7 | Optimism Foundation |
| 9 | `grant` | $25,000 | 100 | 9 | Ethereum Foundation |
| 10 | `ecosystem` | $1,000 | 12 | 5 | Polygon Labs |
| 11 | `content` | $250 | 5 | 3 | Mirror.xyz |
| 12 | `oss_contribution` | $150 | 4 | 3 | Juicebox DAO |
| 13 | (SCAM) referral | $5,000 | 0.1 | 1 | (fake airdrop) |
| 14 | (SCAM) referral | 5 SOL | 0.1 | 1 | (fake wallet drainer) |

The two scam opportunities (#13, #14) trigger the scam detector
(riskScore = 100, hard-capped, immediately `rejected`). The other 12
should flow through the pipeline normally.

### Spec §8 critical test

The economic engine was verified end-to-end against the spec's two
test cases (see the worklog Task ID 4 entry):

**Case 1 — "$20 @ 90% probability, 30 min of work"**

```
Inputs: rewardUsd=20, estimatedHours=0.5, difficulty=1, competition=1,
        riskScore=10, verificationScore=100, sourceReliability=75,
        agentSkillMatch=1.0, capitalRequired=false, deadlineHours=null.

probability_of_success   = 0.81
payment_probability      = 0.90
expected_value           = $14.58
expected_hourly          = $29.16
risk_adjusted_hourly     = $26.24
unified_score            = 85.48    (spec target: [85, 95])
```

**Case 2 — "$500 @ 2% probability, 30 hours of work"**

```
Inputs: rewardUsd=500, estimatedHours=30, difficulty=10, competition=10,
        riskScore=10, verificationScore=50, sourceReliability=50,
        agentSkillMatch=0, capitalRequired=false, deadlineHours=null.

probability_of_success   = 0.02     (matches spec example 0.02)
payment_probability      = 0.50     (matches spec example 0.5)
expected_value           = $5.00     (matches spec example $5)
expected_hourly          = $0.1667  (matches spec example $0.17)
risk_adjusted_hourly     = $0.1500  (matches spec example ~0.15)
unified_score            = 21.16    (spec target: [15, 25])
```

**Verdict:** Case 1 (85.48) outscores Case 2 (21.16) by 64.31 points.
Spec §8 critical test PASSES.

### Unified-score calibration curve

```
$0.01/hr ->   0.00   $0.50/hr -> 35.95   $5/hr ->  64.97
$0.05/hr ->   0.95   $1.00/hr -> 46.49   $10/hr -> 72.49
$0.10/hr ->  11.49   $2.00/hr -> 55.02   $30/hr -> 84.42
$0.15/hr ->  17.65                       $100/hr -> 97.49
```

Centered at $1/hr = score 50 (neutral). Multiplier 25 above $1/hr
(gentle climb), multiplier 35 below $1/hr (steep drop). The
asymmetry lets a poor hourly return pull the score down to 15-25
while a great hourly return pushes it up to 85-95.

### Expected per-strategy outcomes (mock data)

Based on the mock seed + the spec §8 math, here's what the agent
should converge on after 10-20 cycles (when strategies have
enough attempts to lose the exploration bonus):

| Strategy | Expected avgHourly | Expected successRate | Notes |
|---|---|---|---|
| `github_bounty` | $30-60/hr | 60-80% | High volume, mid reward, mid hours |
| `bug_bounty` | $50-100/hr | 30-50% | High reward, long hours, low success rate |
| `hackathon` | $50-150/hr | 20-40% | Big prize pools, intense time, low win rate |
| `docs` | $40-80/hr | 80-95% | Low reward, low hours, high success rate |
| `developer_task` | $50-100/hr | 60-80% | Mid-high reward, mid-long hours |
| `coding_task` | $50-150/hr | 70-90% | Low-mid reward, low-mid hours, high success |
| `data_task` | $40-80/hr | 80-95% | Low reward, low hours |
| `freelance` | $40-100/hr | 50-70% | High reward, long hours, mid success rate |
| `grant` | $100-300/hr | 20-40% | Very high reward, very long hours, low win rate |
| `ecosystem` | $40-80/hr | 60-80% | Mid reward, mid hours |
| `content` | $30-60/hr | 80-95% | Low reward, mid hours, high success rate |
| `oss_contribution` | $30-60/hr | 70-90% | Low reward, low-mid hours |

These are illustrative — the actual numbers depend on:
- Real opportunity discovery rates (the GitHub scanner is the only
  real source; the rest are mock data).
- Real on-chain payment verification (the monitored wallets start
  at $0 balance; verified earnings require real incoming txs).
- Real LLM-driven execution outcomes (the execution agent is
  currently SIMULATED — it marks opportunities `executed` with
  `externalRef=simulated:...` but doesn't actually submit PRs).

### Important: simulated earnings

The agent currently uses simulated execution. The earnings shown in
the dashboard's Ledger tab will be **expected** (verified=false,
expected=true) until:

1. The execution agent is wired to real submission adapters
   (GitHub PR API, hackathon submission endpoints, doc PRs).
2. Real on-chain payments land on the monitored wallets.

Until then, the strategy learning loop is fed by mock outcomes only
— the agent learns from the simulation, not from real earnings.

See [README.md](../README.md#important-disclaimers) for the full
disclaimers.

---

## Cross-references

- **Architecture** — see [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Configuration** — see [CONFIGURATION.md](./CONFIGURATION.md)
- **Operations** — see [OPERATIONS.md](./OPERATIONS.md)
- **API reference** — see [API.md](./API.md)
