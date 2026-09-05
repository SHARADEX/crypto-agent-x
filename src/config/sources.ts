// Opportunity source configuration (spec §5, Phase-2 §18, §19).
//
// Each source is a public, free, no-auth (or token-optional) endpoint where
// the Scout agent looks for legitimate crypto earning opportunities. New
// adapters can be added without touching the orchestrator.
//
// The `SOURCES` array is consumed by `src/lib/agent/sources/index.ts`
// (buildSources()) to instantiate the GitHub + Mock adapters. The
// best-effort adapters (Gitcoin, Devpost, OnlyDust, Hashnode, RSS
// aggregator) are instantiated unconditionally from the adapter modules —
// they self-register and are health-gated by `getConfiguredSources()` at
// runtime. The entries here are for the GitHub + Mock sources (which need
// per-instance config) and as a documented catalog of every source the
// agent knows about.

export interface SourceConfig {
  id: string;
  name: string;
  type: "github" | "mock" | "rss" | "api" | "web";
  enabled: boolean;
  reliabilitySeed: number; // 0..100 starting reliability (spec §22)
  endpoint?: string;
  notes?: string;
}

export const SOURCES: SourceConfig[] = [
  {
    id: "github_issues",
    name: "GitHub Issues (bounty-labeled)",
    type: "github",
    enabled: true,
    reliabilitySeed: 90,
    endpoint:
      "https://api.github.com/search/issues?q=label:bounty+state:open&sort=created&order=desc&per_page=30",
    notes:
      "Public GitHub Search API. No token required for low-volume reads (60 req/hour per IP). Wrapped by GithubBountiesSource.",
  },
  {
    id: "github_help_wanted",
    name: "GitHub Issues (help-wanted + crypto rewards)",
    type: "github",
    enabled: true,
    reliabilitySeed: 80,
    endpoint:
      "https://api.github.com/search/issues?q=label:help-wanted+state:open&sort=created&order=desc&per_page=30",
    notes: "Broader pool; lower bounty density but high OSS contribution value.",
  },
  {
    id: "mock_bounties",
    name: "Mock Bounty Board (simulated)",
    type: "mock",
    enabled: true,
    reliabilitySeed: 70,
    notes:
      "Deterministic seed opportunities used to demonstrate the full lifecycle without spending real money (spec §43). Wrapped by MockSource.",
  },
  {
    id: "mock_hackathons",
    name: "Mock Hackathon Board (simulated)",
    type: "mock",
    enabled: true,
    reliabilitySeed: 65,
    notes: "Simulated hackathon prize pools for lifecycle demonstration.",
  },
  {
    id: "gitcoin_grants",
    name: "Gitcoin Grants (public indexer)",
    type: "api",
    enabled: true,
    reliabilitySeed: 85,
    endpoint: "https://grants-stack-indexer-v2.gitcoin.co/graphql",
    notes:
      "Public GraphQL endpoint — no auth required for round browsing. Best-effort: schema may change. Adapter: GitcoinSource.",
  },
  {
    id: "devpost_hackathons",
    name: "Devpost Hackathons (public API)",
    type: "api",
    enabled: true,
    reliabilitySeed: 80,
    endpoint: "https://devpost.com/api/hackathons?status=open&order_by=prize-amount",
    notes:
      "Public REST endpoint — no auth required. Returns open hackathons sorted by prize amount. Best-effort: schema may change. Adapter: DevpostSource.",
  },
  {
    id: "onlydust_contributions",
    name: "OnlyDust OSS Contributions (public indexer)",
    type: "api",
    enabled: true,
    reliabilitySeed: 75,
    endpoint: "https://indexer.onlydust.com/graphql",
    notes:
      "Public GraphQL endpoint — best-effort. Surfaces active OSS contribution opportunities with USDC-on-Optimism bounties. Adapter: OnlyDustSource.",
  },
  {
    id: "hashnode_posts",
    name: "Hashnode Tech Bounty Posts (public API)",
    type: "api",
    enabled: true,
    reliabilitySeed: 60,
    endpoint: "https://gql.hashnode.com/",
    notes:
      "Public GraphQL endpoint — best-effort. Surfaces crypto/bounty-related blog posts from Hashnode publications. Adapter: HashnodeSource.",
  },
  {
    id: "bounty_rss_aggregator",
    name: "Bounty RSS Aggregator (BOUNTY_RSS_FEEDS)",
    type: "rss",
    enabled: true,
    reliabilitySeed: 70,
    notes:
      "Meta-source that aggregates RSS feeds configured via the BOUNTY_RSS_FEEDS env var (comma-separated URLs). Defaults to Ethereum Foundation, Solana Foundation, and Gitcoin blog feeds. Adapter: BountyRssAggregatorSource.",
  },
];

// Skills the agent can credibly offer. Used by the Research agent to estimate
// probability-of-success per opportunity.
export const AGENT_CAPABLE_SKILLS = [
  "typescript",
  "javascript",
  "react",
  "nextjs",
  "node",
  "python",
  "solidity",
  "rust",
  "move",
  "sql",
  "prisma",
  "tailwind",
  "documentation",
  "testing",
  "ci-cd",
  "security-review",
  "smart-contract-audit",
  "devops",
  "data-analysis",
];

// Categories the agent considers LEGITIMATE (spec §3 — do-not-build list).
export const PROHIBITED_PATTERNS: RegExp[] = [
  /wash\s*trad/i,
  /fake\s*referr/i,
  /engagement\s*bot/i,
  /stolen\s*credential/i,
  /account\s*bypass/i,
  /sybil\s*attack/i,
  /free\s*money\s*no\s*work/i,
  /guaranteed\s*profit/i,
  /private\s*key\s*required/i,
  /seed\s*phrase\s*required/i,
];
