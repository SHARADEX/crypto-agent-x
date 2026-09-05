// Bounty RSS Aggregator source adapter (Phase-2 spec §18, P1-10).
//
// A META-SOURCE that aggregates multiple RSS feeds configured via the
// `BOUNTY_RSS_FEEDS` env var (comma-separated URLs). When the env var is
// absent or empty, the adapter is registered but `discover()` returns `[]`
// (so the discovery cycle still runs end-to-end without crashing).
//
// The aggregator instantiates one RssSource per feed URL and dispatches
// `discover()` on each in parallel via `Promise.allSettled`. Results are
// flattened and labelled with the aggregator's `id` as the source.
//
// Default curated feeds (when BOUNTY_RSS_FEEDS is unset):
//   - Ethereum Foundation blog
//   - Solana Foundation blog
//   - Gitcoin blog
//
// The operator can override with BOUNTY_RSS_FEEDS=url1,url2,...

import { RssSource } from "@/lib/agent/sources/rss-source";
import type { RawOpportunityInput } from "@/lib/agent/normalize";
import { logEvent } from "@/lib/agent/events";
import type {
  DiscoverOptions,
  HealthCheckResult,
  OpportunitySource,
} from "@/lib/agent/sources/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default curated RSS feeds used when BOUNTY_RSS_FEEDS is unset. The list
 * is intentionally short and limited to high-signal sources that frequently
 * publish bounty / grant / hackathon announcements.
 */
export const DEFAULT_BOUNTY_RSS_FEEDS: Array<{
  id: string;
  name: string;
  url: string;
  reliabilitySeed: number;
}> = [
  {
    id: "rss_ethereum_foundation",
    name: "Ethereum Foundation Blog",
    url: "https://blog.ethereum.org/feed.xml",
    reliabilitySeed: 90,
  },
  {
    id: "rss_solana_foundation",
    name: "Solana Foundation News",
    url: "https://solana.com/news/rss.xml",
    reliabilitySeed: 80,
  },
  {
    id: "rss_gitcoin_blog",
    name: "Gitcoin Blog",
    url: "https://gitcoin.co/blog/rss.xml",
    reliabilitySeed: 85,
  },
];

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface BountyRssAggregatorOptions {
  /** Override the aggregator's source id (default: "bounty_rss_aggregator"). */
  id?: string;
  /** Override the aggregator's display name. */
  name?: string;
  /** Override the list of feeds (skips env-var parsing when provided). */
  feeds?: Array<{ id: string; name: string; url: string; reliabilitySeed?: number }>;
  /** Per-feed max results (default 15). */
  perFeedMaxResults?: number;
}

interface FeedConfig {
  id: string;
  name: string;
  url: string;
  reliabilitySeed: number;
}

/**
 * Meta-source that aggregates multiple RSS feeds. Wraps one RssSource per
 * feed URL and dispatches `discover()` on each in parallel.
 *
 * When `BOUNTY_RSS_FEEDS` env var is set, the aggregator uses the env
 * list; otherwise it falls back to {@link DEFAULT_BOUNTY_RSS_FEEDS}.
 *
 * Each child feed's opportunities are re-labelled with the aggregator's
 * `id` as the source — so `SourceReputation` tracks the aggregator as a
 * single composite source, not per-feed.
 */
export class BountyRssAggregatorSource implements OpportunitySource {
  readonly id: string;
  readonly name: string;
  readonly type = "rss" as const;

  private readonly feeds: FeedConfig[];
  private readonly perFeedMaxResults: number;
  private readonly childSources: RssSource[];

  constructor(opts: BountyRssAggregatorOptions = {}) {
    this.id = opts.id ?? "bounty_rss_aggregator";
    this.name = opts.name ?? "Bounty RSS Aggregator (BOUNTY_RSS_FEEDS)";
    this.perFeedMaxResults = opts.perFeedMaxResults ?? 15;
    this.feeds = (opts.feeds ?? parseFeedsFromEnv()).map((f) => ({
      id: f.id,
      name: f.name,
      url: f.url,
      reliabilitySeed: f.reliabilitySeed ?? 60,
    }));

    this.childSources = this.feeds.map(
      (f) =>
        new RssSource({
          id: f.id,
          name: f.name,
          feedUrl: f.url,
          reliabilitySeed: f.reliabilitySeed,
          defaultMaxResults: this.perFeedMaxResults,
        })
    );
  }

  /** Expose the configured child feeds (for the dashboard / debugging). */
  getFeedConfigs(): readonly FeedConfig[] {
    return this.feeds;
  }

  async discover(opts?: DiscoverOptions): Promise<RawOpportunityInput[]> {
    if (this.childSources.length === 0) return [];

    const settled = await Promise.allSettled(
      this.childSources.map((src) => src.discover(opts))
    );

    const out: RawOpportunityInput[] = [];
    const errors: Record<string, string> = {};

    settled.forEach((result, idx) => {
      const feed = this.feeds[idx];
      if (!feed) return;
      if (result.status === "fulfilled") {
        // Re-label each raw opportunity with the aggregator's source id so
        // the SourceReputation counters track the aggregator.
        for (const raw of result.value) {
          out.push({ ...raw, source: this.id });
        }
      } else {
        const msg =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        errors[feed.id] = msg;
      }
    });

    if (Object.keys(errors).length > 0) {
      await logEvent(
        "scout",
        "warn",
        "rss_aggregator_partial_failure",
        {
          source: this.id,
          failedFeeds: Object.keys(errors),
          errors,
        },
        {}
      ).catch(() => null);
    }

    if (out.length > 0) {
      await logEvent(
        "scout",
        "info",
        "source_discovered",
        {
          source: this.id,
          count: out.length,
          feeds: this.feeds.length,
          failedFeeds: Object.keys(errors).length,
        },
        {}
      ).catch(() => null);
    }
    return out;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (this.childSources.length === 0) {
      return {
        ok: false,
        detail: "no RSS feeds configured (set BOUNTY_RSS_FEEDS or rely on defaults)",
      };
    }
    // Health = at least one feed reachable. Don't block on all feeds — a
    // single reach is enough to consider the aggregator operational.
    const results = await Promise.allSettled(
      this.childSources.map((s) => s.healthCheck())
    );
    const okCount = results.filter(
      (r) => r.status === "fulfilled" && r.value.ok
    ).length;
    const total = this.childSources.length;
    if (okCount === 0) {
      return {
        ok: false,
        detail: `all ${total} RSS feed(s) unreachable`,
      };
    }
    return {
      ok: true,
      detail: `${okCount}/${total} RSS feed(s) reachable`,
    };
  }

  normalize(raw: unknown): RawOpportunityInput {
    if (raw && typeof raw === "object") {
      const r = raw as Partial<RawOpportunityInput>;
      if (r.title && r.sourceUrl) {
        return {
          title: r.title,
          description: r.description ?? "",
          sourceUrl: r.sourceUrl,
          organization: r.organization ?? "",
          category: r.category ?? "content",
          reward: r.reward ?? { amount: 0, currency: "USDC", estimated_usd: 0 },
          deadline: r.deadline ?? null,
          requirements: r.requirements ?? [],
          skillsRequired: r.skillsRequired ?? [],
          estimatedHours: r.estimatedHours ?? 0,
          difficulty: r.difficulty ?? 5,
          competition: r.competition ?? 5,
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
// Env-var parsing
// ---------------------------------------------------------------------------

/**
 * Parse the `BOUNTY_RSS_FEEDS` env var into a list of feed configs.
 *
 * Format: comma-separated URLs. Each URL is assigned a stable id derived
 * from its hostname + path (slugified). When the env var is unset or
 * empty, returns {@link DEFAULT_BOUNTY_RSS_FEEDS}.
 */
function parseFeedsFromEnv(): FeedConfig[] {
  const raw = process.env.BOUNTY_RSS_FEEDS ?? "";
  const urls = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (urls.length === 0) {
    return DEFAULT_BOUNTY_RSS_FEEDS.map((f) => ({ ...f }));
  }

  return urls.map((url) => {
    let host = url;
    let slug = "feed";
    try {
      const u = new URL(url);
      host = u.hostname.replace(/^www\./, "");
      slug = host.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    } catch {
      // Malformed URL — still register it with a fallback slug.
      slug = "feed_" + Math.abs(hashString(url)).toString(36);
    }
    return {
      id: `rss_${slug}`,
      name: `${host} (env)`,
      url,
      reliabilitySeed: 60, // Unknown feed — neutral reliability.
    };
  });
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}
