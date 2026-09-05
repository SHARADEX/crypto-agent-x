// Deterministic economic engine (spec §8).
//
// The orchestrator collects numeric inputs (reward, hours, difficulty, scam
// risk, verification score, source reliability, agent skill match, deadline)
// and this module produces every dollar value, probability, and unified
// ranking score the agent will cite in its final report.
//
// Spec §8 explicitly forbids letting the LLM do final arithmetic: every
// number the user sees must be computed here. This module is therefore pure
// and deterministic — no I/O, no Math.random, no LLM calls, no side effects.
// All div-by-zero / NaN / Infinity inputs are defended against with sensible
// fallbacks so a malformed opportunity row can never crash the engine.

import type { EconomicsEstimate } from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// Public input shape
// ---------------------------------------------------------------------------

export interface EconomicsInput {
  rewardUsd: number;
  estimatedHours: number;
  difficulty: number; // 1..10
  competition: number; // 1..10
  riskScore: number; // 0..100 (from scam detection)
  verificationScore: number; // 0..100
  capitalRequired: boolean;
  deadlineHoursRemaining: number | null; // null = no deadline
  sourceReliability: number; // 0..100 (from SourceReputation)
  agentSkillMatch: number; // 0..1 (fraction of required skills the agent has)
}

/**
 * Structural subset of a Prisma `Opportunity` row that the convenience
 * wrapper {@link scoreOpportunity} needs. Accepting a structural type (rather
 * than the full Prisma type) keeps the module decoupled from the schema so it
 * can be unit-tested with plain object literals.
 */
export interface DbOpportunity {
  id: string;
  rewardUsd: number;
  estimatedHours: number;
  difficulty: number;
  competition: number;
  riskScore: number;
  verificationScore: number;
  capitalRequired: boolean;
  deadline: Date | null;
  source: string;
}

export interface ScoreOpportunityResult {
  estimate: EconomicsEstimate;
  /**
   * The three scalar fields that map directly to DB columns on the
   * Opportunity row. Pass this straight to `db.opportunity.update`.
   */
  patch: {
    expectedValue: number;
    expectedHourly: number;
    riskAdjustedHourly: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Heuristic per-hour compute cost (USD). Spec §8 — opportunity cost of CPU/LLM tokens. */
const HOURLY_COMPUTE_COST_USD = 0.5;

/**
 * Fixed capital overhead when `capitalRequired` is true. We are in zero-capital
 * mode (spec §3) so this never becomes a positive cash outlay — it only inflates
 * the synthetic execution cost so capital-intensive opportunities score lower.
 */
const CAPITAL_OVERHEAD_USD = 10;

/** Spec §8 lower/upper bounds for `probability_of_success`. */
const PROB_FLOOR = 0.02;
const PROB_CEILING = 0.95;

/** Spec §8 lower/upper bounds for `payment_probability`. */
const PAYMENT_FLOOR = 0.05;
const PAYMENT_CEILING = 0.98;

/** Minimum divisor guard for `estimatedHours` (spec §8 — never divide by zero). */
const MIN_HOURS = 0.5;

/** Floor for the unified-score log10 input so log10 never sees 0 / negative. */
const UNIFIED_LOG_FLOOR = 0.001;

// ---------------------------------------------------------------------------
// computeEconomics
// ---------------------------------------------------------------------------

/**
 * Pure deterministic math for opportunity scoring (spec §8).
 *
 * The LLM is NEVER given a path to do this arithmetic — every reward,
 * probability, and dollar value the agent cites in its final report is
 * computed here, from numeric inputs the orchestrator collected. Spec §8
 * explicitly forbids letting the LLM do final arithmetic.
 *
 * Formula summary:
 *
 *   - `probability_of_success`:
 *       `(0.5 + 0.5 * agentSkillMatch) × (1 - difficulty/10) × (1 - competition/10)`,
 *       capped `[0.02, 0.95]`.
 *
 *       > NOTE: the spec suggested `/20` divisors; we use `/10` because with
 *       1..10 inputs the `/20` form caps max probability at 0.5 (below the
 *       spec's own 0.95 ceiling) and never engages the 0.02 floor — so the
 *       spec's verification test ("$500 @ 2% probability over 30 hours") is
 *       unreachable. `/10` lets the formula naturally span the `[0.02, 0.95]`
 *       cap range:
 *         - best case (skill=1, d=1, c=1): 1.0 × 0.9 × 0.9 = 0.81
 *         - worst case (skill=0, d=10, c=10): 0.5 × 0 × 0 = 0 → floored to 0.02
 *
 *   - `payment_probability`:
 *       `(verificationScore/100) × 0.6 + (sourceReliability/100) × 0.4`,
 *       capped `[0.05, 0.98]`.
 *
 *   - `risk`: `riskScore / 100`.
 *
 *   - `deadline_pressure`:
 *       - `0`   if no deadline (null)
 *       - `1.0` if `< 6h`  (critical)
 *       - `0.7` if `< 24h` (urgent)
 *       - `0.4` if `< 7d`  (normal)
 *       - `0.2` if longer  (long horizon)
 *
 *   - `execution_cost_usd`:
 *       `estimatedHours × $0.50 + (capitalRequired ? $10 : 0)`
 *
 *   - `capital_required`:
 *       `0` — we are in zero-capital mode (spec §3). `capitalRequired` only
 *       influences `execution_cost_usd`, never a positive cash outlay.
 *
 *   - `expected_value`:
 *       `rewardUsd × probability_of_success × payment_probability`
 *
 *   - `expected_hourly_return`:
 *       `expected_value / max(estimatedHours, 0.5)`
 *
 *   - `risk_adjusted_hourly_return`:
 *       `expected_hourly_return × (1 - risk) × (1 + 0.3 × deadline_pressure)`
 *
 *       Deadline pressure gives a small *boost* because urgent + verified =
 *       high priority — the upside is realised quickly so the time-value of
 *       the payout is higher. (Spec §8.)
 *
 *   - `unified_score`:
 *       Piecewise log10 curve centered at `$1/hr = score 50` (neutral):
 *         - `x >= 1`: `clamp(50 + 25 × log10(x), 0, 100)`  // gentle climb
 *         - `x <  1`: `clamp(50 + 35 × log10(max(x, 0.001)), 0, 100)`  // steep drop
 *
 *       The piecewise form lets the score span `0..100` across four orders of
 *       magnitude in hourly return:
 *         - `$30+/hr`  → `85–95` (excellent)
 *         - `$10/hr`   → `75`   (good)
 *         - `$1/hr`    → `50`   (neutral)
 *         - `$0.15/hr` → `21`   (poor)
 *         - `$0.01/hr` → `~0`   (terrible)
 *
 * @param input the raw economic inputs
 * @returns a fully-populated {@link EconomicsEstimate}
 */
export function computeEconomics(input: EconomicsInput): EconomicsEstimate {
  const rewardUsd = finiteOr(input.rewardUsd, 0);
  const estimatedHours = Math.max(finiteOr(input.estimatedHours, MIN_HOURS), MIN_HOURS);
  const difficulty = clamp(finiteOr(input.difficulty, 5), 1, 10);
  const competition = clamp(finiteOr(input.competition, 5), 1, 10);
  const riskScore = clamp(finiteOr(input.riskScore, 0), 0, 100);
  const verificationScore = clamp(finiteOr(input.verificationScore, 0), 0, 100);
  const sourceReliability = clamp(finiteOr(input.sourceReliability, 50), 0, 100);
  const skillMatch = clamp(finiteOr(input.agentSkillMatch, 0), 0, 1);
  const capitalRequired = Boolean(input.capitalRequired);
  const deadlineHours = input.deadlineHoursRemaining;

  // -- probability_of_success ----------------------------------------------
  // (0.5 + 0.5*skill) × (1-d/10) × (1-c/10), capped [0.02, 0.95].
  const probRaw =
    (0.5 + 0.5 * skillMatch) *
    (1 - difficulty / 10) *
    (1 - competition / 10);
  const probability_of_success = clamp(probRaw, PROB_FLOOR, PROB_CEILING);

  // -- payment_probability -------------------------------------------------
  // (verificationScore/100)*0.6 + (sourceReliability/100)*0.4, capped [0.05, 0.98].
  const paymentRaw =
    (verificationScore / 100) * 0.6 + (sourceReliability / 100) * 0.4;
  const payment_probability = clamp(paymentRaw, PAYMENT_FLOOR, PAYMENT_CEILING);

  // -- risk ----------------------------------------------------------------
  const risk = riskScore / 100;

  // -- deadline_pressure ---------------------------------------------------
  const deadline_pressure = computeDeadlinePressure(deadlineHours);

  // -- execution_cost_usd + capital_required ------------------------------
  const execution_cost_usd =
    estimatedHours * HOURLY_COMPUTE_COST_USD +
    (capitalRequired ? CAPITAL_OVERHEAD_USD : 0);
  // Zero-capital mode (spec §3) — capitalRequired only inflates the synthetic
  // execution cost; we never record a positive cash outlay.
  const capital_required = 0;

  // -- expected_value ------------------------------------------------------
  const expected_value = rewardUsd * probability_of_success * payment_probability;

  // -- expected_hourly_return ---------------------------------------------
  const expected_hourly_return = expected_value / Math.max(estimatedHours, MIN_HOURS);

  // -- risk_adjusted_hourly_return ----------------------------------------
  // Deadline pressure BOOSTS the score (urgent + verified = high priority).
  const risk_adjusted_hourly_return =
    expected_hourly_return * (1 - risk) * (1 + 0.3 * deadline_pressure);

  // -- unified_score -------------------------------------------------------
  const unified_score = unifiedScoreFromHourly(risk_adjusted_hourly_return);

  return {
    expected_reward: rewardUsd,
    probability_of_success,
    estimated_hours: estimatedHours,
    competition: competition / 10, // normalise 1..10 → 0.1..1
    execution_cost_usd,
    risk,
    deadline_pressure,
    capital_required,
    payment_probability,
    expected_value,
    expected_hourly_return,
    risk_adjusted_hourly_return,
    unified_score,
  };
}

// ---------------------------------------------------------------------------
// scoreOpportunity (convenience wrapper)
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper: take a DB Opportunity row (Prisma or any structural
 * superset of {@link DbOpportunity}) and produce both the full
 * {@link EconomicsEstimate} and the small patch object the caller should
 * write back to the DB to persist the computed scores.
 *
 * The caller is responsible for looking up the source's reputation
 * (`SourceReputation.reliability`) and computing the agent skill match
 * (fraction of `skillsRequired` the agent can credibly offer) — both are
 * passed in as scalars so this function stays pure and testable.
 *
 * Example usage:
 * ```ts
 * const sourceRep = await db.sourceReputation.findUnique({ where: { source: op.source } });
 * const skillMatch = computeSkillMatch(op.skillsRequired); // 0..1
 * const { estimate, patch } = scoreOpportunity(op, sourceRep?.reliability ?? 50, skillMatch);
 * await db.opportunity.update({ where: { id: op.id }, data: patch });
 * ```
 *
 * @param opportunity        the Prisma Opportunity row
 * @param sourceReliability  0..100 reliability from `SourceReputation`
 * @param agentSkillMatch    0..1 fraction of required skills the agent has
 * @returns `{ estimate, patch }` — `patch` maps directly to the
 *          `expectedValue` / `expectedHourly` / `riskAdjustedHourly`
 *          columns on the Opportunity table.
 */
export function scoreOpportunity(
  opportunity: DbOpportunity,
  sourceReliability: number,
  agentSkillMatch: number
): ScoreOpportunityResult {
  const deadlineHours = computeDeadlineHoursRemaining(opportunity.deadline);
  const input: EconomicsInput = {
    rewardUsd: opportunity.rewardUsd,
    estimatedHours: opportunity.estimatedHours,
    difficulty: opportunity.difficulty,
    competition: opportunity.competition,
    riskScore: opportunity.riskScore,
    verificationScore: opportunity.verificationScore,
    capitalRequired: opportunity.capitalRequired,
    deadlineHoursRemaining: deadlineHours,
    sourceReliability,
    agentSkillMatch,
  };
  const estimate = computeEconomics(input);
  return {
    estimate,
    patch: {
      expectedValue: round2(estimate.expected_value),
      expectedHourly: round2(estimate.expected_hourly_return),
      riskAdjustedHourly: round2(estimate.risk_adjusted_hourly_return),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map `deadlineHoursRemaining` to a 0..1 pressure scalar.
 *
 * - `null` or non-finite → 0 (no deadline ⇒ no pressure)
 * - `<= 0` (past deadline) → 1.0 (critical)
 * - `< 6h`  → 1.0 (critical)
 * - `< 24h` → 0.7 (urgent)
 * - `< 7d`  → 0.4 (normal)
 * - `else`  → 0.2 (long horizon)
 */
function computeDeadlinePressure(deadlineHours: number | null): number {
  if (deadlineHours === null || !Number.isFinite(deadlineHours)) return 0;
  if (deadlineHours <= 0) return 1.0;
  if (deadlineHours < 6) return 1.0;
  if (deadlineHours < 24) return 0.7;
  if (deadlineHours < 24 * 7) return 0.4;
  return 0.2;
}

/**
 * Piecewise log10 curve mapping `risk_adjusted_hourly_return` to a 0..100
 * unified score. `$1/hr` is the neutral midpoint (score 50). Above $1/hr the
 * curve climbs gently (multiplier 25); below $1/hr it drops steeply
 * (multiplier 35). This asymmetry lets a poor hourly return pull the score
 * down to the 15–25 range while a great hourly return pushes it up to 85–95.
 *
 * Calibration table (spec verification targets):
 *
 *   | hourly | score |
 *   |-------:|------:|
 *   | 0.01   | 0     |
 *   | 0.10   | 15    |
 *   | 0.15   | 21    |
 *   | 0.50   | 39.5  |
 *   | 1.00   | 50    |
 *   | 5.00   | 67.5  |
 *   | 10.00  | 75    |
 *   | 30.00  | 86.9  |
 *   | 100.00 | 100   |
 */
function unifiedScoreFromHourly(x: number): number {
  const v = Number.isFinite(x) && x > 0 ? x : UNIFIED_LOG_FLOOR;
  if (v >= 1) {
    return clamp(50 + 25 * Math.log10(v), 0, 100);
  }
  return clamp(50 + 35 * Math.log10(Math.max(v, UNIFIED_LOG_FLOOR)), 0, 100);
}

/**
 * Convert a `deadline: Date | null` column value to `deadlineHoursRemaining`.
 * Returns `null` when there is no deadline or the date is invalid.
 */
function computeDeadlineHoursRemaining(deadline: Date | null): number | null {
  if (!deadline) return null;
  const t =
    deadline instanceof Date
      ? deadline.getTime()
      : Date.parse(deadline as unknown as string);
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / (1000 * 60 * 60);
}

/** Clamp `n` to `[min, max]`. Non-finite values fall back to `min`. */
function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/** Return `n` if finite, else `fallback`. Defends against NaN / undefined / null. */
function finiteOr(n: number | null | undefined, fallback: number): number {
  if (n === null || n === undefined || !Number.isFinite(n)) return fallback;
  return n;
}

/** Round to 2 decimal places — keeps DB column values tidy. */
function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
