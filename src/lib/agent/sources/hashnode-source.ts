// Hashnode source adapter (Phase-2 spec §18, P1-10).
//
// Wraps Hashnode's public GraphQL API at https://gql.hashnode.com/ for tech
// bounty posts. Hashnode is a developer-blogging platform; many Web3 teams
// publish bounty announcements / hackathon listings there. The adapter
// issues a small `searchPosts` query for posts tagged with crypto/bounty
// keywords.
//
// BEST-EFFORT: when the endpoint is unreachable, schema changes, or the
// sanitiser drops the response, `discover()` returns `[]` and
// `healthCheck()` returns `{ ok: false }`.

import { fetchJsonSafe } from "@/lib/agent/sources/_http";
import type { RawOpportunityInput } from "@/lib/agent/normalize";
import type { OpportunityCategory } from "@/lib/agent/types";
import { logEvent } from "@/lib/agent/events";
import type {
  DiscoverOptions,
  HealthCheckResult,
  OpportunitySource,
} from "@/lib/agent/sources/types";
import { clampNum, toStr } from "@/lib/agent/sources/_http";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HASHNODE_GRAPHQL_URL = "https://gql.hashnode.com/";

const SEARCH_QUERY = `
  query SearchPosts($filter: SearchPostFilter!) {
    searchPosts(filter: $filter) {
      edges {
        node {
          id
          title
          url
          brief
          content {
            markdown
          }
          publication {
            name
            url
          }
          tags {
            name
          }
          publishedAt
        }
      }
    }
  }
`;

interface HashnodeResponse {
  data?: {
    searchPosts?: {
      edges?: Array<{
        node?: HashnodePost;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

interface HashnodePost {
  id?: string;
  title?: string;
  url?: string;
  brief?: string;
  content?: { markdown?: string };
  publication?: { name?: string; url?: string };
  tags?: Array<{ name?: string }>;
  publishedAt?: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface HashnodeSourceOptions {
  endpoint?: string;
  defaultMaxResults?: number;
}

export class HashnodeSource implements OpportunitySource {
  readonly id = "hashnode_posts";
  readonly name = "Hashnode Tech Bounty Posts (public API)";
  readonly type = "api" as const;

  private readonly endpoint: string;
  private readonly defaultMaxResults: number;

  constructor(opts: HashnodeSourceOptions = {}) {
    this.endpoint = opts.endpoint ?? HASHNODE_GRAPHQL_URL;
    this.defaultMaxResults = opts.defaultMaxResults ?? 15;
  }

  async discover(opts?: DiscoverOptions): Promise<RawOpportunityInput[]> {
    const limit = Math.max(1, Math.min(opts?.maxResults ?? this.defaultMaxResults, 50));
    try {
      const result = await fetchJsonSafe<HashnodeResponse>(
        this.endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: SEARCH_QUERY,
            variables: {
              filter: {
                queryString: "bounty OR reward OR hackathon OR grant crypto",
                from: 0,
                size: limit,
              },
            },
          }),
        }
      );

      if (!result.ok || !result.json) {
        if (result.error) {
          await logEvent(
            "scout",
            "warn",
            "source_discover_error",
            { source: this.id, error: result.error, status: result.status },
            {}
          ).catch(() => null);
        }
        return [];
      }

      const edges = result.json.data?.searchPosts?.edges ?? [];
      if (result.json.errors && result.json.errors.length > 0) {
        await logEvent(
          "scout",
          "warn",
          "source_discover_graphql_errors",
          {
            source: this.id,
            errors: result.json.errors.map((e) => e.message).slice(0, 3),
          },
          {}
        ).catch(() => null);
      }

      const out: RawOpportunityInput[] = [];
      for (const edge of edges) {
        const raw = postToRaw(edge.node);
        if (raw) out.push(raw);
      }

      if (out.length > 0) {
        await logEvent(
          "scout",
          "info",
          "source_discovered",
          { source: this.id, count: out.length },
          {}
        ).catch(() => null);
      }
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logEvent(
        "scout",
        "error",
        "source_discover_threw",
        { source: this.id, error: msg },
        {}
      ).catch(() => null);
      return [];
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const result = await fetchJsonSafe<HashnodeResponse>(
        this.endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `query { searchPosts(filter: { queryString: "crypto", from: 0, size: 1 }) { edges { node { id } } } }`,
          }),
        },
        { timeoutMs: 8_000 }
      );
      if (!result.ok) {
        return { ok: false, detail: `Hashnode unreachable: ${result.error ?? "unknown"}` };
      }
      if (result.json?.errors && result.json.errors.length > 0) {
        return {
          ok: false,
          detail: `Hashnode GraphQL errors: ${result.json.errors[0]?.message ?? "?"}`,
        };
      }
      return { ok: true, detail: "Hashnode API reachable", latencyMs: result.latencyMs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `Hashnode unreachable: ${msg}` };
    }
  }

  normalize(raw: unknown): RawOpportunityInput {
    if (raw && typeof raw === "object") {
      const r = raw as Partial<RawOpportunityInput>;
      if (r.title && r.sourceUrl) {
        return {
          title: r.title,
          description: r.description ?? "",
          sourceUrl: r.sourceUrl,
          organization: r.organization ?? "Hashnode",
          category: r.category ?? "content",
          reward: r.reward ?? { amount: 0, currency: "USDC", estimated_usd: 0 },
          deadline: r.deadline ?? null,
          requirements: r.requirements ?? [],
          skillsRequired: r.skillsRequired ?? [],
          estimatedHours: r.estimatedHours ?? 0,
          difficulty: r.difficulty ?? 4,
          competition: r.competition ?? 4,
          eligibility: r.eligibility ?? [],
          paymentMethod: r.paymentMethod ?? "",
          capitalRequired: r.capitalRequired ?? false,
          source: this.id,
        };
      }
    }
    return {
      title: "",
      description: "",
      sourceUrl: "",
      organization: "",
      category: "content",
      source: this.id,
    };
  }
}

// ---------------------------------------------------------------------------
// Post → RawOpportunityInput mapping
// ---------------------------------------------------------------------------

function postToRaw(p?: HashnodePost): RawOpportunityInput | null {
  if (!p) return null;
  const title = toStr(p.title);
  const sourceUrl = toStr(p.url);
  if (!title || !sourceUrl) return null;

  const brief = toStr(p.brief);
  const markdown = toStr(p.content?.markdown);
  const description = brief || markdown.slice(0, 500);
  const organization = toStr(p.publication?.name, "Hashnode");
  const tags = (p.tags ?? []).map((t) => toStr(t.name)).filter(Boolean);
  const haystack = `${title} ${description} ${tags.join(" ")}`;

  const category = inferCategory(haystack);
  const { reward, paymentMethod } = inferReward(haystack);

  return {
    title,
    description: description || title,
    sourceUrl,
    organization,
    category,
    reward,
    deadline: p.publishedAt ?? null,
    requirements: [],
    skillsRequired: inferSkills(haystack),
    estimatedHours: 0, // Hashnode posts are informational; not actionable bounties.
    difficulty: 4,
    competition: 4,
    eligibility: [],
    paymentMethod,
    capitalRequired: false,
    source: "hashnode_posts",
  };
}

function inferCategory(haystack: string): OpportunityCategory {
  const lower = haystack.toLowerCase();
  if (/\bgrant\b/.test(lower)) return "grant";
  if (/\bhackathon\b/.test(lower)) return "hackathon";
  if (/\bbug\s*bounty\b/.test(lower)) return "bug_bounty";
  if (/\bbounty\b/.test(lower)) return "github_bounty";
  return "content";
}

function inferReward(haystack: string): {
  reward: { amount: number; currency: string; estimated_usd: number };
  paymentMethod: string;
} {
  const match = haystack.match(/(?:\$|USDC|USDT|DAI|ETH|SOL|MATIC)\s?(\d+(?:[,.]\d{3})*(?:\.\d+)?)/i);
  if (!match) {
    return {
      reward: { amount: 0, currency: "USDC", estimated_usd: 0 },
      paymentMethod: "",
    };
  }
  const numStr = (match[1] ?? "").replace(/[,\s]/g, "");
  const amount = clampNum(Number(numStr), 0, 10_000_000, 0);
  if (amount <= 0) {
    return {
      reward: { amount: 0, currency: "USDC", estimated_usd: 0 },
      paymentMethod: "",
    };
  }
  const prefix = (match[0].split(/\s|\d/)[0] ?? "$").toUpperCase();
  const currency =
    prefix === "$"
      ? "USDC"
      : ["USDC", "USDT", "DAI", "ETH", "SOL", "MATIC"].includes(prefix)
        ? prefix
        : "USDC";
  return {
    reward: {
      amount,
      currency,
      estimated_usd: ["USDC", "USDT", "DAI", "USD"].includes(currency) ? amount : 0,
    },
    paymentMethod: `${currency} (per post — informational)`,
  };
}

function inferSkills(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  if (/\btypescript\b/.test(lower)) out.push("typescript");
  if (/\breact\b/.test(lower)) out.push("react");
  if (/\bsolidity\b/.test(lower)) out.push("solidity");
  if (/\brust\b/.test(lower)) out.push("rust");
  if (/\bsolana\b/.test(lower)) out.push("rust");
  if (/\bdocumentation\b|\bdocs\b/.test(lower)) out.push("documentation");
  return out;
}
