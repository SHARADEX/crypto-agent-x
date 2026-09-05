// Gitcoin Grants source adapter (Phase-2 spec §18, P1-10).
//
// Wraps the public Gitcoin Grants Stack indexer GraphQL endpoint:
//   https://grants-stack-indexer-v2.gitcoin.co/graphql
//
// The endpoint is public — no auth required for round browsing. The adapter
// issues a small `rounds` query for active rounds, then maps each round's
// matching-pool + project count into a `RawOpportunityInput`. The grant
// program itself becomes the "opportunity" — the agent can then deep-fetch
// individual projects via `fetchDetails()`.
//
// This is a BEST-EFFORT adapter: the GraphQL schema is not officially
// documented as a stable public API, so any field may move. When the
// endpoint is unreachable, schema changes, or the sanitiser drops the
// response, `discover()` returns `[]` and `healthCheck()` returns
// `{ ok: false }`. The discovery pipeline degrades gracefully.

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

export const GITCOIN_GRAPHQL_URL =
  "https://grants-stack-indexer-v2.gitcoin.co/graphql";

const ROUNDS_QUERY = `
  query ActiveRounds($first: Int!) {
    rounds(first: $first, orderBy: matchAmountUSD, orderDirection: desc) {
      id
      roundMetadataPtr
      roundMetaPtr
      applications(first: 5) {
        id
        metadata
      }
      matchToken
      matchAmount
      matchAmountUSD
      roundEndTime
      roundStartTime
      chainId
    }
  }
`;

interface GitcoinRoundsResponse {
  data?: {
    rounds?: GitcoinRound[];
  };
  errors?: Array<{ message: string }>;
}

interface GitcoinRound {
  id?: string;
  roundMetadataPtr?: { protocol?: number; pointer?: string };
  applications?: Array<{ id?: string; metadata?: unknown }>;
  matchToken?: string;
  matchAmount?: string;
  matchAmountUSD?: string | number;
  roundEndTime?: string;
  roundStartTime?: string;
  chainId?: number;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface GitcoinSourceOptions {
  /** Override the GraphQL URL (for tests / alternative indexers). */
  endpoint?: string;
  /** Default max results. */
  defaultMaxResults?: number;
}

/**
 * Adapter for the Gitcoin Grants Stack indexer.
 *
 * Contract notes:
 *   - `discover()` issues a POST GraphQL query against the public indexer.
 *     NEVER throws — returns `[]` on any failure + logs via `logEvent`.
 *   - `healthCheck()` issues a minimal `{ rounds(first: 1) }` query.
 *   - `normalize()` is the identity pass — discover already returns
 *     `RawOpportunityInput` objects.
 */
export class GitcoinSource implements OpportunitySource {
  readonly id = "gitcoin_grants";
  readonly name = "Gitcoin Grants (public indexer)";
  readonly type = "api" as const;

  private readonly endpoint: string;
  private readonly defaultMaxResults: number;

  constructor(opts: GitcoinSourceOptions = {}) {
    this.endpoint = opts.endpoint ?? GITCOIN_GRAPHQL_URL;
    this.defaultMaxResults = opts.defaultMaxResults ?? 20;
  }

  async discover(opts?: DiscoverOptions): Promise<RawOpportunityInput[]> {
    const limit = Math.max(1, Math.min(opts?.maxResults ?? this.defaultMaxResults, 50));
    try {
      const result = await fetchJsonSafe<GitcoinRoundsResponse>(
        this.endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: ROUNDS_QUERY,
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

      const rounds = result.json.data?.rounds ?? [];
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
      for (const round of rounds) {
        const raw = roundToRaw(round);
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
      const result = await fetchJsonSafe<GitcoinRoundsResponse>(
        this.endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `query { rounds(first: 1) { id } }`,
          }),
        },
        { timeoutMs: 8_000 }
      );
      if (!result.ok) {
        return { ok: false, detail: `Gitcoin unreachable: ${result.error ?? "unknown"}` };
      }
      if (result.json?.errors && result.json.errors.length > 0) {
        return {
          ok: false,
          detail: `Gitcoin GraphQL errors: ${result.json.errors[0]?.message ?? "?"}`,
        };
      }
      return { ok: true, detail: "Gitcoin indexer reachable", latencyMs: result.latencyMs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `Gitcoin unreachable: ${msg}` };
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
          organization: r.organization ?? "Gitcoin",
          category: r.category ?? "grant",
          reward: r.reward ?? { amount: 0, currency: "USDC", estimated_usd: 0 },
          deadline: r.deadline ?? null,
          requirements: r.requirements ?? [],
          skillsRequired: r.skillsRequired ?? [],
          estimatedHours: r.estimatedHours ?? 0,
          difficulty: r.difficulty ?? 6,
          competition: r.competition ?? 8,
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
      category: "grant",
      source: this.id,
    };
  }
}

// ---------------------------------------------------------------------------
// Round → RawOpportunityInput mapping
// ---------------------------------------------------------------------------

function roundToRaw(round: GitcoinRound): RawOpportunityInput | null {
  const roundId = toStr(round.id);
  if (!roundId) return null;

  // Build a best-effort URL — Gitcoin Explorer doesn't have a stable
  // per-round public URL we can construct from just the round id + chainId,
  // so we link to the round's metadata pointer landing page.
  const sourceUrl = `https://explorer.gitcoin.co/#/round/${round.chainId ?? 1}/${roundId}`;

  const matchUsd = clampNum(
    typeof round.matchAmountUSD === "string"
      ? Number(round.matchAmountUSD)
      : round.matchAmountUSD,
    0,
    10_000_000,
    0
  );

  const matchAmountRaw = toStr(round.matchAmount, "0");
  const matchAmount = clampNum(Number(matchAmountRaw), 0, 1e9, 0);
  const matchToken = toStr(round.matchToken, "USDC").toUpperCase();

  const deadline = round.roundEndTime ?? null;
  const startTime = round.roundStartTime ?? null;

  const title = `Gitcoin Grants Round ${roundId.slice(0, 10)} — matching pool ${matchToken} ${matchAmount}`;
  const description = buildDescription(round, matchUsd, matchToken, matchAmount);

  return {
    title,
    description,
    sourceUrl,
    organization: "Gitcoin",
    category: "grant",
    reward: {
      amount: matchAmount,
      currency: matchToken,
      // USD-pegged tokens (USDC, USDT, DAI) estimate at face value.
      estimated_usd: ["USDC", "USDT", "DAI", "USD"].includes(matchToken)
        ? matchAmount
        : matchUsd,
    },
    deadline,
    requirements: [
      "Apply via the Gitcoin Explorer before the round deadline",
      "Project must meet the round's eligibility criteria",
      "Recipient address must be a valid smart contract on the round's chain",
    ],
    skillsRequired: ["solidity", "documentation", "grant-writing"],
    estimatedHours: 40,
    difficulty: 6,
    competition: 8,
    eligibility: [
      "Open-source public-goods projects",
      "Project must be deployed on the round's chain",
      startTime ? `Round starts ${startTime.slice(0, 10)}` : "",
    ].filter(Boolean) as string[],
    paymentMethod: `${matchToken} matching pool on chain ${round.chainId ?? "?"}`,
    capitalRequired: false,
    source: "gitcoin_grants",
  };
}

function buildDescription(
  round: GitcoinRound,
  matchUsd: number,
  matchToken: string,
  matchAmount: number
): string {
  const parts: string[] = [];
  parts.push(
    `Gitcoin Grants Stack round on chain ${round.chainId ?? "?"}.`
  );
  if (matchUsd > 0) {
    parts.push(
      `Matching pool estimated at $${matchUsd.toFixed(0)} USD (paid in ${matchToken}).`
    );
  } else if (matchAmount > 0) {
    parts.push(
      `Matching pool: ${matchAmount} ${matchToken}.`
    );
  }
  const appCount = round.applications?.length ?? 0;
  if (appCount > 0) {
    parts.push(`${appCount}+ projects applied to this round.`);
  }
  if (round.roundEndTime) {
    parts.push(`Round ends ${round.roundEndTime.slice(0, 10)}.`);
  }
  parts.push(
    "Quadratic funding distributes the matching pool based on contributor count — projects with broad support receive larger payouts."
  );
  return parts.join(" ");
}
