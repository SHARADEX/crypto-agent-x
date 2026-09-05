// Mock opportunity scanner (spec §5, §43).
//
// Produces a deterministic set of seed opportunities covering the full
// OpportunityCategory spectrum. Used to exercise the entire lifecycle
// (normalize → verify → score → policy → persist) without spending real
// money or hitting external APIs. Two deliberately scam-shaped entries are
// included so the scam-detection engine has something to flag in dev.
//
// The dataset is fully deterministic — there is no Math.random() anywhere.
// Deadlines are computed relative to the current time with fixed day offsets
// so the agent always sees a spread of CRITICAL / URGENT / NORMAL / LONG
// buckets (spec §24).

import type { OpportunityCategory } from "@/lib/agent/types";
import type { RawOpportunityInput } from "@/lib/agent/normalize";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MockScanResult {
  opportunities: RawOpportunityInput[];
  source: string;
  fetchedAt: string;
  error?: string;
}

/**
 * Return a deterministic set of mock opportunities covering every category in
 * the spectrum, plus two deliberately scam-shaped entries to exercise the scam
 * detector. Safe to call in tests — the output is identical across invocations
 * modulo the (fixed-offset) deadline timestamps.
 */
export function scanMockOpportunities(): MockScanResult {
  const fetchedAt = new Date().toISOString();
  try {
    return {
      opportunities: MOCK_OPPORTUNITIES.map((seed) => seedToRaw(seed)),
      source: "mock_bounties",
      fetchedAt,
    };
  } catch (err) {
    return {
      opportunities: [],
      source: "mock_bounties",
      fetchedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Seed definitions (deterministic)
// ---------------------------------------------------------------------------

interface MockSeed {
  title: string;
  description: string;
  sourceUrl: string;
  organization: string;
  category: OpportunityCategory;
  rewardAmount: number;
  rewardCurrency: string;
  deadlineDays: number;
  requirements: string[];
  skillsRequired: string[];
  estimatedHours: number;
  difficulty: number;
  competition: number;
  eligibility: string[];
  paymentMethod: string;
  capitalRequired: boolean;
}

const MOCK_OPPORTUNITIES: MockSeed[] = [
  {
    title: "Lens Protocol: Implement profile-metadata GraphQL resolver",
    description:
      "Lens Protocol is looking for a contributor to extend the profile-metadata GraphQL resolver to support new EIP-712 typed-data fields. PR must include unit tests, an integration test against the local sandbox, and a CHANGELOG entry. Payment in USDC on Polygon upon merge.",
    sourceUrl: "https://github.com/lens-protocol/lens-sdk/issues/412",
    organization: "Lens Protocol",
    category: "github_bounty",
    rewardAmount: 400,
    rewardCurrency: "USDC",
    deadlineDays: 14,
    requirements: [
      "Open a draft PR within 48h of assignment",
      "Cover new EIP-712 fields with unit tests",
      "Update CHANGELOG.md",
    ],
    skillsRequired: ["typescript", "graphql", "react"],
    estimatedHours: 12,
    difficulty: 5,
    competition: 4,
    eligibility: ["18+", "KYC for payouts > $500"],
    paymentMethod: "USDC on Polygon",
    capitalRequired: false,
  },
  {
    title: "Solana Foundation: Bug bounty — SIMD-0165 priority fee race",
    description:
      "High-severity finding in the SIMD-0165 priority-fee estimator. Reproduce the race condition under load and propose a deterministic fix. Bounty payable in SOL or USDC after Triage team validation.",
    sourceUrl:
      "https://github.com/solana-foundation/solana-improvement-docs/issues/165",
    organization: "Solana Foundation",
    category: "bug_bounty",
    rewardAmount: 1500,
    rewardCurrency: "USDC",
    deadlineDays: 21,
    requirements: [
      "Provide a minimal reproducible test case",
      "Propose a patch with rationale",
      "Cooperate with Solana security team under embargo",
    ],
    skillsRequired: ["rust", "solana", "security-review"],
    estimatedHours: 30,
    difficulty: 9,
    competition: 8,
    eligibility: [
      "No current Solana Labs employees",
      "Disclose only through official bug bounty program",
    ],
    paymentMethod: "USDC on Solana",
    capitalRequired: false,
  },
  {
    title: "Gitcoin Grant Round: Build a public-goods funding dashboard",
    description:
      "Hackathon prize for the best open-source dashboard visualizing Gitcoin Grants round contributions. Judging criteria: originality, code quality, deployability. Top-3 prizes paid in USDC on Optimism.",
    sourceUrl: "https://gitcoin.co/hackathon/gitcoin-round-22/dashboard",
    organization: "Gitcoin",
    category: "hackathon",
    rewardAmount: 1200,
    rewardCurrency: "USDC",
    deadlineDays: 25,
    requirements: [
      "Submit a deployed demo URL",
      "Open-source the code under MIT",
      "3-minute demo video",
    ],
    skillsRequired: ["typescript", "react", "nextjs"],
    estimatedHours: 40,
    difficulty: 6,
    competition: 7,
    eligibility: ["Open to individuals and teams of up to 4"],
    paymentMethod: "USDC on Optimism",
    capitalRequired: false,
  },
  {
    title: "OnlyDust: Write contributor onboarding guide for new repos",
    description:
      "Author a comprehensive onboarding guide for first-time OnlyDust contributors. Includes setup walkthrough, common contribution patterns, and a glossary. Paid in USDC on acceptance; reuse permitted under CC-BY.",
    sourceUrl: "https://onlydust.com/contributions/onboarding-guide",
    organization: "OnlyDust",
    category: "docs",
    rewardAmount: 150,
    rewardCurrency: "USDC",
    deadlineDays: 10,
    requirements: [
      "3000–5000 words",
      "3 diagrams (Mermaid or images)",
      "Reviewed by OnlyDust maintainer",
    ],
    skillsRequired: ["documentation", "markdown"],
    estimatedHours: 8,
    difficulty: 3,
    competition: 3,
    eligibility: ["Strong English writing", "GitHub account required"],
    paymentMethod: "USDC on Optimism",
    capitalRequired: false,
  },
  {
    title: "Replit: Add Postgres connection-pool metrics endpoint",
    description:
      "Replit's bountied developer task: add a /v1/db/pool-metrics endpoint to the hosted Postgres adapter that reports active/idle connection counts. PR must include OpenAPI schema update and integration test.",
    sourceUrl: "https://github.com/replit/web/pull/2231",
    organization: "Replit",
    category: "developer_task",
    rewardAmount: 300,
    rewardCurrency: "USDC",
    deadlineDays: 7,
    requirements: [
      "OpenAPI spec updated",
      "Integration test under tests/integration/",
      "Backwards-compatible: feature-flagged by default",
    ],
    skillsRequired: ["typescript", "node", "sql"],
    estimatedHours: 10,
    difficulty: 5,
    competition: 5,
    eligibility: ["No active Replit employees"],
    paymentMethod: "USDC on Ethereum",
    capitalRequired: false,
  },
  {
    title: "Vercel: Edge runtime — fix FormData multipart parsing",
    description:
      "Edge runtime's FormData parser mishandles nested multipart boundaries when Content-Length is omitted. Reproduce, fix, and add a regression test. $250 USDC on merge to main.",
    sourceUrl: "https://github.com/vercel/edge-runtime/issues/188",
    organization: "Vercel",
    category: "coding_task",
    rewardAmount: 250,
    rewardCurrency: "USDC",
    deadlineDays: 5,
    requirements: [
      "Minimal repro",
      "Fix + regression test",
      "Benchmarks before/after",
    ],
    skillsRequired: ["typescript", "node", "testing"],
    estimatedHours: 6,
    difficulty: 4,
    competition: 4,
    eligibility: ["Sign Vercel CLA"],
    paymentMethod: "USDC on Polygon",
    capitalRequired: false,
  },
  {
    title: "Dune: Curate Lens engagement dashboard dataset",
    description:
      "Build a curated SQL dataset on Dune that surfaces daily active Lens profiles, post counts, and mirror velocity. Top-3 entries paid in Dune credits (redeemable for USDC).",
    sourceUrl: "https://dune.com/bounties/lens-engagement-2025",
    organization: "Dune",
    category: "data_task",
    rewardAmount: 200,
    rewardCurrency: "USDC",
    deadlineDays: 18,
    requirements: [
      "SQL queries must be reproducible",
      "Document column semantics",
      "Submit via Dune bounty form",
    ],
    skillsRequired: ["sql", "data-analysis"],
    estimatedHours: 7,
    difficulty: 4,
    competition: 6,
    eligibility: ["Public Dune account required"],
    paymentMethod: "USDC on Ethereum",
    capitalRequired: false,
  },
  {
    title: "Optimism RPC Foundation: Implement retry-with-backoff client",
    description:
      "Freelance engagement: deliver a production-grade TypeScript RPC client with exponential backoff, circuit breaker, and per-endpoint health tracking. 3-week engagement, milestone payments.",
    sourceUrl: "https://jobs.optimism.io/freelance/rpc-client-2025",
    organization: "Optimism Foundation",
    category: "freelance",
    rewardAmount: 1200,
    rewardCurrency: "USDC",
    deadlineDays: 21,
    requirements: [
      "Deliverable: npm package + docs",
      "Milestone 1: backoff + retry — $400",
      "Milestone 2: circuit breaker + tests — $800",
    ],
    skillsRequired: ["typescript", "node", "devops"],
    estimatedHours: 35,
    difficulty: 7,
    competition: 6,
    eligibility: [
      "Prior RPC client experience",
      "Sign Optimism contractor agreement",
    ],
    paymentMethod: "USDC on Optimism",
    capitalRequired: false,
  },
  {
    title: "Ethereum Foundation: Ecosystem support grant — open-source tooling",
    description:
      "ESP grant for open-source developer tooling that benefits the Ethereum ecosystem. Rolling application; grant size $5k–$50k depending on scope. Funding disbursed in USDC after milestone reviews.",
    sourceUrl: "https://esp.ethereum.foundation/grants",
    organization: "Ethereum Foundation",
    category: "grant",
    rewardAmount: 5000,
    rewardCurrency: "USDC",
    deadlineDays: 30,
    requirements: [
      "Detailed proposal (max 6 pages)",
      "Open-source license (MIT / Apache-2 / GPLv3)",
      "Quarterly milestone reports",
    ],
    skillsRequired: ["typescript", "solidity", "documentation"],
    estimatedHours: 80,
    difficulty: 8,
    competition: 9,
    eligibility: [
      "Open to individuals and organizations",
      "Cannot be a direct EF grantee in the same calendar year",
    ],
    paymentMethod: "USDC on Ethereum",
    capitalRequired: false,
  },
  {
    title: "Polygon: Developer ecosystem — build a starter template",
    description:
      "Polygon ecosystem reward for an opinionated Next.js + Prisma + viem starter template that demonstrates a complete Polygon zkEVM dApp. $400 USDC on merge + showcase on Polygon builders hub.",
    sourceUrl: "https://github.com/0xPolygon/dev-starter-template/issues/1",
    organization: "Polygon Labs",
    category: "ecosystem",
    rewardAmount: 400,
    rewardCurrency: "USDC",
    deadlineDays: 14,
    requirements: [
      "Next.js 16 + TypeScript + Tailwind",
      "WalletConnect + viem integration",
      "README with deployment steps",
    ],
    skillsRequired: ["typescript", "nextjs", "react", "solidity"],
    estimatedHours: 16,
    difficulty: 6,
    competition: 5,
    eligibility: ["Open globally"],
    paymentMethod: "USDC on Polygon",
    capitalRequired: false,
  },
  {
    title: "Mirror.xyz: Long-form piece on onchain identity primitives",
    description:
      "Write a 2500–4000 word essay on the evolution of onchain identity primitives (ENS, Lens, WorldID). $100 USDC on publication; recurring royalty split via Mirror's writing NFT.",
    sourceUrl: "https://mirror.xyz/bounties/onchain-identity-essay",
    organization: "Mirror.xyz",
    category: "content",
    rewardAmount: 100,
    rewardCurrency: "USDC",
    deadlineDays: 12,
    requirements: [
      "Original work (no AI-generated copy)",
      "3 illustrations or charts",
      "Cross-publish on Mirror",
    ],
    skillsRequired: ["documentation", "writing", "research"],
    estimatedHours: 10,
    difficulty: 4,
    competition: 4,
    eligibility: ["English fluency", "Active writing portfolio"],
    paymentMethod: "USDC on Optimism",
    capitalRequired: false,
  },
  {
    title: "Juicebox: Add GraphQL subscription support for project events",
    description:
      "Open-source contribution to Juicebox DAO's protocol subgraph: emit project events through a GraphQL subscription endpoint. $75 bounty via OnlyDust — great first-time contribution.",
    sourceUrl: "https://github.com/jbx-protocol/juice-subgraph/issues/77",
    organization: "Juicebox DAO",
    category: "oss_contribution",
    rewardAmount: 75,
    rewardCurrency: "USDC",
    deadlineDays: 30,
    requirements: [
      "Add subscription resolvers",
      "Update schema.graphql",
      "Add a smoke test",
    ],
    skillsRequired: ["typescript", "graphql"],
    estimatedHours: 5,
    difficulty: 3,
    competition: 3,
    eligibility: ["Beginner-friendly", "Sign contributor agreement"],
    paymentMethod: "USDC on Optimism",
    capitalRequired: false,
  },

  // -- Deliberate scams (exercise the scam-detection engine) ---------------

  {
    title:
      "FREE ETH Airdrop — Connect Wallet to Claim $5000 Guaranteed Profit",
    description:
      "Connect your wallet to claim your free 5 ETH airdrop worth $5000. Guaranteed profit, no work required. Just connect your wallet and approve the claim transaction. Limited time offer, invite your friends to earn $500 per referral. This is a 100% free money opportunity. Provide your 12-word seed phrase to verify ownership and unlock the bonus.",
    sourceUrl: "https://airdrop-eth-claim-free.xyz",
    organization: "x",
    category: "ecosystem",
    rewardAmount: 5000,
    rewardCurrency: "ETH",
    deadlineDays: 1,
    requirements: [
      "Connect wallet to claim",
      "Approve the claim transaction",
      "Provide 12-word seed phrase to verify ownership",
      "Invite 5 friends to unlock $500 referral bonus",
    ],
    skillsRequired: [],
    estimatedHours: 0,
    difficulty: 1,
    competition: 1,
    eligibility: ["Anyone with an ETH wallet"],
    paymentMethod: "Direct ETH transfer (wallet connection required)",
    capitalRequired: false,
  },
  {
    title:
      "URGENT: Verify your wallet — provide private key to claim 5 SOL airdrop",
    description:
      "We detected unclaimed 5 SOL on your wallet. To claim, send your private key to verify@solana-airdrop-claim.io and we will credit the SOL within 24 hours. New protocol, fully trusted. No deposit required upfront. Just provide the private key and your wallet will be credited. Wallet drainer warning: do not paste your key on other sites.",
    sourceUrl: "https://solana-airdrop-claim.io/verify",
    organization: "",
    category: "ecosystem",
    rewardAmount: 5000,
    rewardCurrency: "SOL",
    deadlineDays: 2,
    requirements: [
      "Private key required to verify wallet ownership",
      "Email your key to verify@solana-airdrop-claim.io",
    ],
    skillsRequired: [],
    estimatedHours: 0,
    difficulty: 1,
    competition: 1,
    eligibility: ["Anyone with a Solana wallet"],
    paymentMethod: "Direct SOL transfer (private key required)",
    capitalRequired: false,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return an ISO date `days` days from now. */
function daysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function seedToRaw(seed: MockSeed): RawOpportunityInput {
  return {
    title: seed.title,
    description: seed.description,
    sourceUrl: seed.sourceUrl,
    organization: seed.organization,
    category: seed.category,
    reward: {
      amount: seed.rewardAmount,
      currency: seed.rewardCurrency,
      estimated_usd: seed.rewardCurrency === "USDC" ? seed.rewardAmount : 0,
    },
    deadline: daysFromNow(seed.deadlineDays),
    requirements: seed.requirements,
    skillsRequired: seed.skillsRequired,
    estimatedHours: seed.estimatedHours,
    difficulty: seed.difficulty,
    competition: seed.competition,
    eligibility: seed.eligibility,
    paymentMethod: seed.paymentMethod,
    capitalRequired: seed.capitalRequired,
    source: "mock_bounties",
  };
}
