// OnlyDust source adapter (Phase-2 spec §18, P1-10).
//
// Wraps the OnlyDust public GraphQL indexer:
//   https://indexer.onlydust.com/graphql
//
// The endpoint is best-effort public — no auth required for browsing
// contribution opportunities. The adapter issues a small `projects` query
// for active OSS contribution opportunities, then maps each project into a
// `RawOpportunityInput` (category: `oss_contribution`).
//
// OnlyDust's primary value is bountied OSS contributions — contributors
// receive USDC on Optimism after their PR is merged. This adapter surfaces
// the projects with active contribution opportunities.
//
// BEST-EFFORT: when the endpoint is unreachable, schema changes, or the
// sanitiser drops the response, `discover()` returns `[]` and
// `healthCheck()` returns `{ ok: false }`.

import { fetchJsonSafe } from "@/lib/agent/sources/_http";
import type { RawOpportunityInput } from "@/lib/agent/normalize";
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

export const ONLYDUST_GRAPHQL_URL = "https://indexer.onlydust.com/graphql";

const PROJECTS_QUERY = `
  query ActiveProjects($first: Int!) {
    projects(first: $first, orderBy: CONTRIBUTIONS_COUNT, orderDirection: desc) {
      id
      name
      slug
      description
      logoUrl
      contributorsCount
      contributionsCount
      repoUrl
      url
      categories
    }
  }
`;

interface OnlyDustResponse {
  data?: {
    projects?: OnlyDustProject[];
  };
  errors?: Array<{ message: string }>;
}

interface OnlyDustProject {
  id?: string;
  name?: string;
  slug?: string;
  description?: string;
  logoUrl?: string;
  contributorsCount?: number;
  contributionsCount?: number;
  repoUrl?: string;
  url?: string;
  categories?: string[];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface OnlyDustSourceOptions {
  endpoint?: string;
  defaultMaxResults?: number;
}

export class OnlyDustSource implements OpportunitySource {
  readonly id = "onlydust_contributions";
  readonly name = "OnlyDust OSS Contributions (public indexer)";
  readonly type = "api" as const;

  private readonly endpoint: string;
  private readonly defaultMaxResults: number;

  constructor(opts: OnlyDustSourceOptions = {}) {
    this.endpoint = opts.endpoint ?? ONLYDUST_GRAPHQL_URL;
    this.defaultMaxResults = opts.defaultMaxResults ?? 20;
  }

  async discover(opts?: DiscoverOptions): Promise<RawOpportunityInput[]> {
    const limit = Math.max(1, Math.min(opts?.maxResults ?? this.defaultMaxResults, 50));
    try {
      const result = await fetchJsonSafe<OnlyDustResponse>(
        this.endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: PROJECTS_QUERY,
            variables: { first: limit },
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

      const projects = result.json.data?.projects ?? [];
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
      for (const p of projects) {
        const raw = projectToRaw(p);
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
      const result = await fetchJsonSafe<OnlyDustResponse>(
        this.endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `query { projects(first: 1) { id name } }`,
          }),
        },
        { timeoutMs: 8_000 }
      );
      if (!result.ok) {
        return { ok: false, detail: `OnlyDust unreachable: ${result.error ?? "unknown"}` };
      }
      if (result.json?.errors && result.json.errors.length > 0) {
        return {
          ok: false,
          detail: `OnlyDust GraphQL errors: ${result.json.errors[0]?.message ?? "?"}`,
        };
      }
      return { ok: true, detail: "OnlyDust indexer reachable", latencyMs: result.latencyMs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `OnlyDust unreachable: ${msg}` };
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
          organization: r.organization ?? "OnlyDust",
          category: r.category ?? "oss_contribution",
          reward: r.reward ?? { amount: 0, currency: "USDC", estimated_usd: 0 },
          deadline: r.deadline ?? null,
          requirements: r.requirements ?? [],
          skillsRequired: r.skillsRequired ?? [],
          estimatedHours: r.estimatedHours ?? 5,
          difficulty: r.difficulty ?? 3,
          competition: r.competition ?? 3,
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
      category: "oss_contribution",
      source: this.id,
    };
  }
}

// ---------------------------------------------------------------------------
// Project → RawOpportunityInput mapping
// ---------------------------------------------------------------------------

function projectToRaw(p: OnlyDustProject): RawOpportunityInput | null {
  const name = toStr(p.name);
  const slug = toStr(p.slug);
  if (!name && !slug) return null;

  // Source URL: prefer the explicit url field, fall back to repo URL,
  // last resort construct a profile URL from slug.
  const sourceUrl =
    toStr(p.url) ||
    toStr(p.repoUrl) ||
    (slug ? `https://www.onlydust.com/projects/${slug}` : "");
  if (!sourceUrl) return null;

  const contributions = clampNum(p.contributionsCount, 0, 100_000, 0);
  const contributors = clampNum(p.contributorsCount, 0, 100_000, 0);

  // OnlyDust rewards are typically small USDC bounties on Optimism, paid
  // after PR merge. We don't have the exact per-project reward amount from
  // the listing query — leave amount 0 and let the economics engine refine.
  const rewardAmount = 0;

  const categories = (p.categories ?? [])
    .map((c) => toStr(c))
    .filter(Boolean);
  const description = [
    toStr(p.description) || `${name} — OnlyDust contribution opportunity.`,
    `${contributors} contributor(s); ${contributions} contribution(s) recorded.`,
    categories.length > 0 ? `Categories: ${categories.join(", ")}.` : "",
    "OnlyDust bounties are paid in USDC on Optimism after PR merge.",
  ].filter(Boolean).join(" ");

  const skillsRequired = inferSkills(toStr(p.description) + " " + categories.join(" "));

  return {
    title: `OnlyDust: Contribute to ${name}`,
    description,
    sourceUrl,
    organization: "OnlyDust",
    category: "oss_contribution",
    reward: {
      amount: rewardAmount,
      currency: "USDC",
      estimated_usd: rewardAmount,
    },
    deadline: null, // OnlyDust projects are rolling; no fixed deadline.
    requirements: [
      "Open a PR linked to an open contribution on the OnlyDust dashboard",
      "Pass repo's review + CI",
      "Maintainer marks the contribution as accepted",
    ],
    skillsRequired,
    estimatedHours: 5,
    difficulty: 3,
    competition: 3,
    eligibility: ["Have an OnlyDust account", "Be a first-time or returning contributor"],
    paymentMethod: "USDC on Optimism (after PR merge, via OnlyDust)",
    capitalRequired: false,
    source: "onlydust_contributions",
  };
}

function inferSkills(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  if (/\btypescript\b|\bts\b/.test(lower)) out.push("typescript");
  if (/\bjavascript\b|\bjs\b/.test(lower)) out.push("javascript");
  if (/\breact\b/.test(lower)) out.push("react");
  if (/\bnode\b/.test(lower)) out.push("node");
  if (/\bsolidity\b/.test(lower)) out.push("solidity");
  if (/\brust\b/.test(lower)) out.push("rust");
  if (/\bcairo\b/.test(lower)) out.push("cairo");
  if (/\bmove\b/.test(lower)) out.push("move");
  if (/\bsql\b/.test(lower)) out.push("sql");
  if (/documentation|docs/.test(lower)) out.push("documentation");
  return out.length > 0 ? out : ["typescript"];
}
