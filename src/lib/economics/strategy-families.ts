// Strategy families (Phase 3 §16, §33, §34).
//
// The agent's strategy subsystem is organised into 7 high-level "strategy
// families" — each family groups together the 11 legacy `CanonicalStrategy`
// keys (still tracked per-row in `StrategyStat`) plus a `defaultAllocation`
// percentage expressing how the agent should distribute its *effort* across
// the families.
//
// The 7 families (default allocations — Phase 3 §16, §34):
//
//   A. bounty          65%   — coding bounties, bug bounties, docs bounties,
//                               research bounties, Web3 tasks. The agent's
//                               primary revenue channel: the most proven,
//                               highest-$ / hour path with the shortest
//                               feedback loop.
//   B. freelance       10%   — crypto-paid dev, automation, AI agent dev,
//                               scripting, data processing, technical
//                               writing, design, Web3 dev. Slower to land
//                               than bounties but larger payouts.
//   C. hackathon        8%   — hackathons, coding competitions, Web3
//                               challenges, prize competitions. Rare + high
//                               variance — pays big or zero.
//   D. grant            7%   — public goods, ecosystem grants, open-source
//                               funding, builder grants. Long cycle (weeks),
//                               steady but small.
//   E. contribution      5%   — ecosystem contributor programs, DAO
//                               contribution programs, technical contributor
//                               opportunities. Building reputation + recurring
//                               compensation.
//   F. build_once        5%   — useful crypto tools, developer tools,
//                               open-source products, APIs, websites,
//                               utilities, educational tools. Build once,
//                               earn passively via tips / GitCoin / sponsors.
//   G. reward_program    0%   — ecosystem reward programs, learning/research
//                               incentives, testing programs. Starts at 0%
//                               because the agent must gather baseline data
//                               on the other 6 families first; the adaptive
//                               rebalancer can grow this once reward_program
//                               has been attempted enough times.
//                              ─────────────────────────
//                                Total        100%
//
// Every family has:
//   - `defaultAllocation`     — the Phase 3 §34 starting % (above).
//   - `defaultAllocationBounty` — the % of the bounty family that should go
//                                  to each subcategory (Phase 3 §16 spec).
//   - `minAllocation`          — hard floor the operator can never go below
//                                  (Phase 3 §26 — protects against a runaway
//                                  adaptive rebalancer zeroing a family).
//   - `maxAllocation`           — hard ceiling (Phase 3 §26 — protects
//                                  against over-concentration).
//   - `scanFrequency`           — how often the agent should re-scan the
//                                  family's sources (Phase 3 §21).
//   - `subcategories`           — the slice of the 11 canonical strategies
//                                  that belong to this family. Used by the
//                                  family rollup on the dashboard + by the
//                                  adaptive rebalancer to aggregate stats.
//
// The mapping from `OpportunityCategory` → `StrategyFamily` is fixed and
// total: every category maps to exactly one family. The legacy per-category
// `StrategyStat` rows are still written by the ledger — they continue to
// drive the per-strategy 70/20/10 explore/exploit picker *within* a family.

import type { OpportunityCategory } from "@/lib/agent/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StrategyFamily =
  | "bounty"
  | "freelance"
  | "hackathon"
  | "grant"
  | "contribution"
  | "build_once"
  | "reward_program";

export type ScanFrequency = "high" | "medium" | "low";

export interface StrategyFamilyConfig {
  family: StrategyFamily;
  displayName: string;
  description: string;
  /** Default % allocation (0-100). Sum of all families' defaults = 100. */
  defaultAllocation: number;
  /**
   * % allocation within the bounty family's subcategories
   * (Phase 3 §16 spec — only meaningful for the bounty family; the other 6
   * families set this to 0).
   */
  defaultAllocationBounty: number;
  /** Hard floor — operator + adaptive rebalancer cannot go below this. */
  minAllocation: number;
  /** Hard ceiling — operator + adaptive rebalancer cannot exceed this. */
  maxAllocation: number;
  /** How often the agent re-scans this family's sources (Phase 3 §21). */
  scanFrequency: ScanFrequency;
  /**
   * The slice of `CanonicalStrategy` keys that belong to this family.
   * Used by the dashboard rollup + by the adaptive rebalancer to aggregate
   * per-family verified $/hr.
   */
  subcategories: string[];
}

// ---------------------------------------------------------------------------
// STRATEGY_FAMILIES — the canonical 7 families
// ---------------------------------------------------------------------------

export const STRATEGY_FAMILIES: StrategyFamilyConfig[] = [
  {
    family: "bounty",
    displayName: "Bounties",
    description:
      "Coding bounties, bug bounties, docs bounties, research bounties, Web3 tasks. " +
      "The agent's primary revenue channel — short feedback loop, proven payouts.",
    defaultAllocation: 65,
    defaultAllocationBounty: 100, // 100% of the bounty family goes to subcategories (split below)
    minAllocation: 30,
    maxAllocation: 90,
    scanFrequency: "high",
    subcategories: ["coding", "security", "documentation", "research", "web3"],
  },
  {
    family: "freelance",
    displayName: "Freelance",
    description:
      "Crypto-paid development, automation, AI agent dev, scripting, data processing, " +
      "technical writing, design, Web3 dev. Slower to land than bounties, larger payouts.",
    defaultAllocation: 10,
    defaultAllocationBounty: 0,
    minAllocation: 0,
    maxAllocation: 40,
    scanFrequency: "medium",
    subcategories: ["freelance"],
  },
  {
    family: "hackathon",
    displayName: "Hackathons",
    description:
      "Hackathons, coding competitions, Web3 challenges, prize competitions. " +
      "Rare + high variance — pays big or zero.",
    defaultAllocation: 8,
    defaultAllocationBounty: 0,
    minAllocation: 0,
    maxAllocation: 30,
    scanFrequency: "low",
    subcategories: ["hackathon"],
  },
  {
    family: "grant",
    displayName: "Grants",
    description:
      "Public goods, ecosystem grants, open-source funding, builder grants. " +
      "Long cycle (weeks), steady but small.",
    defaultAllocation: 7,
    defaultAllocationBounty: 0,
    minAllocation: 0,
    maxAllocation: 25,
    scanFrequency: "low",
    subcategories: ["grant"],
  },
  {
    family: "contribution",
    displayName: "Contribution",
    description:
      "Ecosystem contributor programs, DAO contribution programs, technical contributor " +
      "opportunities. Building reputation + recurring compensation.",
    defaultAllocation: 5,
    defaultAllocationBounty: 0,
    minAllocation: 0,
    maxAllocation: 20,
    scanFrequency: "medium",
    subcategories: ["ecosystem", "oss_contribution", "developer_task"],
  },
  {
    family: "build_once",
    displayName: "Build-Once Assets",
    description:
      "Useful crypto tools, developer tools, open-source products, APIs, websites, " +
      "utilities, educational tools. Build once, earn passively via tips / GitCoin / sponsors.",
    defaultAllocation: 5,
    defaultAllocationBounty: 0,
    minAllocation: 0,
    maxAllocation: 25,
    scanFrequency: "low",
    subcategories: ["content", "data_task"],
  },
  {
    family: "reward_program",
    displayName: "Reward Programs",
    description:
      "Ecosystem reward programs, learning/research incentives, testing programs. " +
      "Starts at 0% — adaptive rebalancer grows this once baseline data exists.",
    defaultAllocation: 0,
    defaultAllocationBounty: 0,
    minAllocation: 0,
    maxAllocation: 15,
    scanFrequency: "low",
    subcategories: [],
  },
];

// ---------------------------------------------------------------------------
// STRATEGY_FAMILY_MAP — O(1) lookup
// ---------------------------------------------------------------------------

export const STRATEGY_FAMILY_MAP: Record<StrategyFamily, StrategyFamilyConfig> =
  STRATEGY_FAMILIES.reduce(
    (acc, cfg) => {
      acc[cfg.family] = cfg;
      return acc;
    },
    {} as Record<StrategyFamily, StrategyFamilyConfig>
  );

// ---------------------------------------------------------------------------
// CATEGORY_TO_FAMILY — maps the legacy OpportunityCategory → StrategyFamily.
//
// Every `OpportunityCategory` value MUST appear in exactly one family. If a
// new category is added to `types.ts` it MUST be added here too — the unit
// test `assertEveryCategoryMapped` (called by `bootstrapAllocations`)
// enforces this invariant at runtime.
// ---------------------------------------------------------------------------

export const CATEGORY_TO_FAMILY: Record<OpportunityCategory, StrategyFamily> = {
  // bounty family — coding + security + docs + research + web3 bounties
  bounty: "bounty",
  github_bounty: "bounty",
  bug_bounty: "bounty",
  docs: "bounty",
  coding_task: "bounty",
  // research → bounty (Web3 task + research bounties are the same loop)
  // (we don't have a dedicated "research" category — covered by docs + coding_task)

  // freelance family
  freelance: "freelance",

  // hackathon family
  hackathon: "hackathon",

  // grant family
  grant: "grant",

  // contribution family
  ecosystem: "contribution",
  oss_contribution: "contribution",
  developer_task: "contribution",

  // build_once family — content + data-task automation assets
  content: "build_once",
  data_task: "build_once",

  // reward_program — no direct category mapping; this family is mostly
  // populated by the discovery subsystem surfacing program-style opportunities.
  // `referral` is prohibited by §3 (do-not-build list) so it lives nowhere.
  referral: "reward_program",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up the family config for a given family key. Returns `undefined` if
 * the family is not in the canonical 7.
 */
export function getFamilyConfig(
  family: string
): StrategyFamilyConfig | undefined {
  return STRATEGY_FAMILY_MAP[family as StrategyFamily];
}

/**
 * Map an `OpportunityCategory` to its `StrategyFamily`. Returns `"bounty"`
 * (the default family) for unknown / unmapped categories so callers never
 * throw.
 */
export function categoryToFamily(category: string): StrategyFamily {
  const mapped = CATEGORY_TO_FAMILY[category as OpportunityCategory];
  if (mapped) return mapped;
  // Unknown category — fall back to the bounty family (the largest default
  // allocation). The operator will see it surface in the dashboard and can
  // re-classify via the strategy allocation UI.
  console.warn(
    `[strategy-families] unmapped category '${category}' — defaulting to 'bounty'. ` +
      `Update CATEGORY_TO_FAMILY in src/lib/economics/strategy-families.ts.`
  );
  return "bounty";
}

/**
 * Map a canonical strategy key (e.g. `github_bounty`, `freelance`,
 * `oss_contribution`) to its `StrategyFamily`. The strategy keys come from
 * the legacy `StrategyStat.strategy` column. We treat each key the same as
 * its corresponding `OpportunityCategory`.
 */
export function strategyKeyToFamily(strategyKey: string): StrategyFamily {
  return categoryToFamily(strategyKey);
}

/**
 * Return the subcategories (legacy canonical strategy keys) that belong to
 * the given family. Empty array for families with no subcategory breakdown
 * (e.g. reward_program).
 */
export function familySubcategories(family: StrategyFamily): string[] {
  return STRATEGY_FAMILY_MAP[family]?.subcategories ?? [];
}

/**
 * Sum the `defaultAllocation` of every family. MUST equal 100. Used by
 * `bootstrapAllocations` to validate the seed.
 */
export function sumDefaultAllocations(): number {
  return STRATEGY_FAMILIES.reduce(
    (sum, cfg) => sum + cfg.defaultAllocation,
    0
  );
}

/**
 * Iterate every `OpportunityCategory` value + assert it appears in
 * `CATEGORY_TO_FAMILY`. Returns the list of unmapped categories (empty if
 * everything is mapped). Used by `bootstrapAllocations` to fail loudly if a
 * new category was added to `types.ts` without updating the family map.
 */
export function findUnmappedCategories(): string[] {
  const allCategories: OpportunityCategory[] = [
    "bounty",
    "github_bounty",
    "bug_bounty",
    "hackathon",
    "docs",
    "developer_task",
    "coding_task",
    "data_task",
    "freelance",
    "grant",
    "ecosystem",
    "referral",
    "content",
    "oss_contribution",
  ];
  return allCategories.filter((c) => !(c in CATEGORY_TO_FAMILY));
}

/**
 * The list of all 7 family keys (in canonical order).
 */
export const STRATEGY_FAMILY_KEYS: StrategyFamily[] = STRATEGY_FAMILIES.map(
  (cfg) => cfg.family
);
