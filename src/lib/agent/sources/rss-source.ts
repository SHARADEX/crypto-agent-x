// RSS feed source adapter (Phase-2 spec §18, P1-10).
//
// A generic RSS/Atom feed adapter. The constructor takes `{ id, name,
// feedUrl, reliabilitySeed }` so multiple instances can be registered:
// one for "Web3 Foundation blog", one for "Solana news", etc.
//
// The adapter parses RSS XML via a regex-based extractor (no DOM-parser
// dependency — keeps the bundle lean). It maps each `<item>` /
// `<entry>` into a `RawOpportunityInput`. The mapping is conservative:
// only items that mention crypto/bounty/reward/grant keywords are emitted.
//
// A meta-aggregator `BountyRssAggregatorSource` (rssac-source.ts) wraps
// multiple RssSource instances configured via the `BOUNTY_RSS_FEEDS` env
// var. This file is the per-feed adapter; rssac-source.ts is the aggregator.

import { fetchTextSafe } from "@/lib/agent/sources/_http";
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
// Regex-based RSS / Atom parser (no DOM dependency)
// ---------------------------------------------------------------------------

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string | null;
  guid: string | null;
  categories: string[];
}

// Match <item>...</item> (RSS 2.0) or <entry>...</entry> (Atom). The
// regex is non-greedy + global so we can iterate matches.
const ITEM_REGEX =
  /<(?:item|entry)[\s\S]*?>([\s\S]*?)<\/(?:item|entry)>/gi;

function extractField(
  source: string,
  tagName: string
): string {
  // Try both <tag>...</tag> and <tag attr="...">...</tag>.
  const re = new RegExp(
    `<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    "i"
  );
  const m = source.match(re);
  return m ? decodeXml(m[1] ?? "").trim() : "";
}

function extractLink(source: string): string {
  // RSS 2.0: <link>https://...</link>
  // Atom: <link href="https://..."/>
  const atomMatch = source.match(/<link[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
  if (atomMatch) return atomMatch[1] ?? "";
  return extractField(source, "link");
}

function extractCategories(source: string): string[] {
  const out: string[] = [];
  // RSS: <category>foo</category>  (multiple)
  // Atom: <category term="foo"/>
  const re = /<category[^>]*?(?:term=["']([^"']+)["'])?[^>]*>([^<]*)<\/category>|<category[^>]*?term=["']([^"']+)["'][^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const v = (m[1] || m[2] || (m[3] ?? "")).trim();
    if (v) out.push(v);
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c)
    .trim();
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  let match: RegExpExecArray | null;
  while ((match = ITEM_REGEX.exec(xml)) !== null) {
    const inner = match[1] ?? "";
    if (!inner) continue;
    const title = extractField(inner, "title");
    const link = extractLink(inner);
    const description = extractField(inner, "description");
    const pubDate =
      extractField(inner, "pubDate") ||
      extractField(inner, "published") ||
      extractField(inner, "updated") ||
      null;
    const guid = extractField(inner, "guid") || extractField(inner, "id") || null;
    const categories = extractCategories(inner);
    if (title || link) {
      items.push({ title, link, description, pubDate, guid, categories });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Opportunity relevance filter (only emit items that mention reward keywords)
// ---------------------------------------------------------------------------

const REWARD_KEYWORDS =
  /\b(bounty|bounties|reward|prize|grant|hackathon|usdc|usdt|dai|eth|sol|matic|funded|paid|compensat|\$\s?\d)/i;

function looksLikeOpportunity(item: RssItem): boolean {
  const haystack = `${item.title} ${item.description} ${item.categories.join(" ")}`;
  return REWARD_KEYWORDS.test(haystack);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface RssSourceOptions {
  id: string;
  name: string;
  feedUrl: string;
  /** 0..100 reliability seed (informational only — surfaced in healthCheck detail). */
  reliabilitySeed?: number;
  /** Default max items per discover() call. */
  defaultMaxResults?: number;
  /**
   * Override the host string used as `organization` on mapped opportunities.
   * Defaults to the feed URL's hostname.
   */
  organization?: string;
}

export class RssSource implements OpportunitySource {
  readonly id: string;
  readonly name: string;
  readonly type = "rss" as const;

  private readonly feedUrl: string;
  private readonly defaultMaxResults: number;
  private readonly reliabilitySeed?: number;
  private readonly organizationOverride?: string;

  constructor(opts: RssSourceOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.feedUrl = opts.feedUrl;
    this.defaultMaxResults = opts.defaultMaxResults ?? 20;
    this.reliabilitySeed = opts.reliabilitySeed;
    this.organizationOverride = opts.organization;
  }

  async discover(opts?: DiscoverOptions): Promise<RawOpportunityInput[]> {
    const limit = Math.max(1, Math.min(opts?.maxResults ?? this.defaultMaxResults, 50));
    try {
      const result = await fetchTextSafe(this.feedUrl);
      if (!result.ok || !result.text) {
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

      const items = parseRss(result.text);
      const relevant = items.filter(looksLikeOpportunity).slice(0, limit);
      const out: RawOpportunityInput[] = relevant
        .map((item) => itemToRaw(item, this.id, this.organization()))
        .filter((r): r is RawOpportunityInput => Boolean(r));

      if (out.length > 0) {
        await logEvent(
          "scout",
          "info",
          "source_discovered",
          { source: this.id, count: out.length, total: items.length },
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
      const result = await fetchTextSafe(this.feedUrl, { method: "GET" }, { timeoutMs: 8_000 });
      if (!result.ok) {
        return { ok: false, detail: `RSS feed unreachable: ${result.error ?? "unknown"}` };
      }
      // Verify the body looks like RSS/Atom (channel or feed root element).
      const looksRss = /<(?:rss|feed|channel|rdf:rdf)\b/i.test(result.text);
      if (!looksRss) {
        return {
          ok: false,
          detail: `RSS feed did not return XML (content-type: ${result.contentType})`,
        };
      }
      return { ok: true, detail: "RSS feed reachable", latencyMs: result.latencyMs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `RSS feed unreachable: ${msg}` };
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
          organization: r.organization ?? this.organization(),
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

  private organization(): string {
    if (this.organizationOverride) return this.organizationOverride;
    try {
      const u = new URL(this.feedUrl);
      return u.hostname.replace(/^www\./, "");
    } catch {
      return this.name;
    }
  }
}

// ---------------------------------------------------------------------------
// Item → RawOpportunityInput mapping
// ---------------------------------------------------------------------------

const REWARD_AMOUNT_REGEX = /(?:\$|USDC|USDT|DAI|ETH|SOL|MATIC)\s?(\d+(?:[,.]\d{3})*(?:\.\d+)?)/i;

function itemToRaw(
  item: RssItem,
  source: string,
  organization: string
): RawOpportunityInput | null {
  const title = toStr(item.title);
  const sourceUrl = toStr(item.link || item.guid);
  if (!title || !sourceUrl) return null;

  const description = toStr(item.description);
  const haystack = `${title} ${description}`;

  // Conservative reward extraction.
  let rewardAmount = 0;
  let rewardCurrency = "USDC";
  const match = haystack.match(REWARD_AMOUNT_REGEX);
  if (match) {
    const numStr = (match[1] ?? "").replace(/[,\s]/g, "");
    const n = Number(numStr);
    if (Number.isFinite(n) && n > 0) {
      rewardAmount = clampNum(n, 0, 10_000_000, 0);
      const prefix = (match[0].split(/\s|\d/)[0] ?? "$").toUpperCase();
      rewardCurrency =
        prefix === "$" ? "USDC" : ["USDC", "USDT", "DAI", "ETH", "SOL", "MATIC"].includes(prefix) ? prefix : "USDC";
    }
  }

  // Category inference from text + categories.
  const category = inferCategory(haystack, item.categories);

  return {
    title,
    description: description || title,
    sourceUrl,
    organization,
    category,
    reward: {
      amount: rewardAmount,
      currency: rewardCurrency,
      estimated_usd: ["USDC", "USDT", "DAI", "USD"].includes(rewardCurrency) ? rewardAmount : 0,
    },
    deadline: item.pubDate, // RSS pubDate often IS the publication date, not the deadline — but we surface it.
    requirements: [],
    skillsRequired: inferSkills(haystack),
    estimatedHours: 0,
    difficulty: 5,
    competition: 5,
    eligibility: [],
    paymentMethod: rewardAmount > 0 ? `${rewardCurrency} per post rules` : "",
    capitalRequired: false,
    source,
  };
}

function inferCategory(haystack: string, categories: string[]): OpportunityCategory {
  const lower = `${haystack} ${categories.join(" ")}`.toLowerCase();
  if (/\bgrant\b/.test(lower)) return "grant";
  if (/\bhackathon\b/.test(lower)) return "hackathon";
  if (/\bbounty\b|\breward\b/.test(lower)) return "github_bounty";
  if (/\bbug\s*bounty\b/.test(lower)) return "bug_bounty";
  if (/\bdocs\b|\bdocumentation\b|\btutorial\b|\bguide\b/.test(lower)) return "docs";
  if (/\bcontribution\b|\bopensource\b|\bopen-source\b/.test(lower)) return "oss_contribution";
  if (/\bcontent\b|\barticle\b|\bessay\b/.test(lower)) return "content";
  return "content";
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
