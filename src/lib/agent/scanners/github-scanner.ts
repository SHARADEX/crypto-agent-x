// GitHub issues scanner (spec §5).
//
// Hits the GitHub Search API (60 req/hour/IP unauthenticated) and normalizes
// each `issues` search-result into a `RawOpportunityInput`. The scanner is
// defensive: any failure (network, JSON parse, rate-limit, schema) is caught
// and surfaced via the returned `error` field rather than thrown.
//
// Label → category mapping (spec §5 opportunity taxonomy):
//   label:bounty           → github_bounty
//   label:help-wanted      → developer_task
//   label:good-first-issue → coding_task
//   label:documentation    → docs
//   label:bug              → bug_bounty
//   label:hackathon        → hackathon
//   label:grant            → grant
//   default                → coding_task
//
// Reward extraction is conservative: we regex-scan the issue body for
// `$N`, `USDC N`, `USDT N`, `DAI N` patterns and take the first plausible
// match. If no match is found, reward.amount is 0 — the economics engine
// (separate task) can refine this via LLM reasoning if needed.

import { SOURCES } from "@/config/sources";
import type { OpportunityCategory } from "@/lib/agent/types";
import type { RawOpportunityInput } from "@/lib/agent/normalize";
import { BudgetManager } from "@/lib/budget/manager";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GitHubScanResult {
  opportunities: RawOpportunityInput[];
  source: string;
  fetchedAt: string;
  error?: string;
}

export interface GitHubScanOptions {
  /** Max number of opportunities to emit. Defaults to 30 (one page). */
  limit?: number;
  /** Override the source-config endpoint (used by tests). */
  endpoint?: string;
  /**
   * Optional request timeout in ms. Defaults to 10_000 (10 seconds).
   * GitHub's API is normally fast; a hung request should not block the
   * discovery cycle.
   */
  timeoutMs?: number;
}

/**
 * Fetch open GitHub issues labelled as bounties / help-wanted and return them
 * as normalized `RawOpportunityInput` objects.
 *
 * This function NEVER throws — every failure mode returns an object with
 * `opportunities: []` and a populated `error` field so the orchestrator can
 * degrade gracefully and log the failure to the event stream.
 *
 * @param opts.limit      max number of opportunities to emit
 * @param opts.endpoint   override the GitHub search URL
 * @param opts.timeoutMs  request timeout in ms (default 10s)
 */
export async function scanGitHubBounties(
  opts?: GitHubScanOptions
): Promise<GitHubScanResult> {
  const fetchedAt = new Date().toISOString();
  const limit = Math.max(1, Math.min(opts?.limit ?? 30, 100));
  const timeoutMs = Math.max(1000, opts?.timeoutMs ?? 10_000);
  const endpoint = opts?.endpoint ?? SOURCES[0]?.endpoint;

  if (!endpoint) {
    return {
      opportunities: [],
      source: "github_issues",
      fetchedAt,
      error: "No GitHub endpoint configured in SOURCES[0].",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Record the web request against the daily budget BEFORE we hit the
    // network so an over-budget state is caught before the request goes out.
    try {
      await BudgetManager.getInstance().recordWebRequest();
    } catch (err) {
      // Budget recording failures should never block discovery.
      console.warn("[github-scanner] budget recordWebRequest failed:", err);
    }

    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "CryptoEarn-Agent/0.1 (+https://example.local)",
      },
    });

    if (!res.ok) {
      const body = await safeReadText(res);
      return {
        opportunities: [],
        source: "github_issues",
        fetchedAt,
        error: `GitHub API ${res.status} ${res.statusText}: ${body.slice(0, 280)}`,
      };
    }

    const json = (await res.json()) as GitHubSearchResponse;
    const items = Array.isArray(json?.items) ? json.items : [];
    const opportunities: RawOpportunityInput[] = [];
    for (const item of items.slice(0, limit)) {
      try {
        const raw = itemToRaw(item);
        if (raw) opportunities.push(raw);
      } catch (err) {
        // Skip malformed items rather than aborting the whole batch.
        console.warn("[github-scanner] skipping malformed item:", err);
      }
    }

    return {
      opportunities,
      source: "github_issues",
      fetchedAt,
    };
  } catch (err) {
    const aborted =
      err instanceof Error && err.name === "AbortError"
        ? `GitHub API request timed out after ${timeoutMs}ms.`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      opportunities: [],
      source: "github_issues",
      fetchedAt,
      error: aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// GitHub API → RawOpportunityInput
// ---------------------------------------------------------------------------

interface GitHubSearchResponse {
  total_count?: number;
  incomplete_results?: boolean;
  items?: GitHubIssue[];
}

interface GitHubIssue {
  id?: number;
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  created_at?: string;
  updated_at?: string;
  labels?: { name?: string }[];
  user?: { login?: string; type?: string };
  repository_url?: string;
  // Some endpoints return `repository` inline
  repository?: { full_name?: string; html_url?: string };
}

const REWARD_REGEX = /(?:\$|USDC|USDT|DAI)\s?(\d+(?:\.\d+)?)/i;

/** Map a GitHub issue's labels to an opportunity category. */
function labelsToCategory(labels: { name?: string }[]): OpportunityCategory {
  const names = new Set(
    labels
      .map((l) => l?.name?.toLowerCase().trim() ?? "")
      .filter((n) => n.length > 0)
  );
  if (names.has("bounty")) return "github_bounty";
  if (names.has("bug") || names.has("bug-bounty")) return "bug_bounty";
  if (names.has("hackathon")) return "hackathon";
  if (names.has("documentation") || names.has("docs")) return "docs";
  if (names.has("help-wanted") || names.has("help wanted")) {
    return "developer_task";
  }
  if (names.has("good-first-issue") || names.has("good first issue")) {
    return "coding_task";
  }
  if (names.has("grant")) return "grant";
  if (names.has("feature") || names.has("enhancement")) return "coding_task";
  return "coding_task";
}

/** Parse the first reward-like mention from the issue body. Conservative. */
function extractReward(body: string): {
  amount: number;
  currency: string;
  estimated_usd: number;
} {
  if (!body) return { amount: 0, currency: "USDC", estimated_usd: 0 };
  const match = body.match(REWARD_REGEX);
  if (!match) return { amount: 0, currency: "USDC", estimated_usd: 0 };
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { amount: 0, currency: "USDC", estimated_usd: 0 };
  }
  // Default to USDC for $ amounts; explicit currency otherwise.
  const rawPrefix = match[0].split(/\s/)[0]?.toUpperCase() ?? "$";
  const currency = rawPrefix === "$" ? "USDC" : rawPrefix;
  return { amount, currency, estimated_usd: amount };
}

/**
 * Heuristic estimate of effort from the issue body + label set. Conservative:
 * a short body with `good-first-issue` is ~2h; a long body with `bug` is ~10h.
 */
function estimateHours(body: string, labels: { name?: string }[]): number {
  const names = new Set(
    labels
      .map((l) => l?.name?.toLowerCase().trim() ?? "")
      .filter((n) => n.length > 0)
  );
  if (names.has("good-first-issue") || names.has("good first issue")) return 2;
  if (names.has("documentation") || names.has("docs")) return 4;
  if (names.has("help-wanted") || names.has("help wanted")) return 6;
  if (names.has("bug") || names.has("bug-bounty")) return 10;
  const bodyLen = body?.length ?? 0;
  if (bodyLen > 4000) return 12;
  if (bodyLen > 1500) return 6;
  return 3;
}

/** Map difficulty (1..10) from labels. Defaults to 5 (medium). */
function estimateDifficulty(labels: { name?: string }[]): number {
  const names = new Set(
    labels
      .map((l) => l?.name?.toLowerCase().trim() ?? "")
      .filter((n) => n.length > 0)
  );
  if (names.has("good-first-issue") || names.has("good first issue")) return 2;
  if (names.has("documentation") || names.has("docs")) return 3;
  if (names.has("bug") || names.has("bug-bounty")) return 8;
  if (names.has("hackathon")) return 6;
  if (names.has("grant")) return 8;
  return 5;
}

/** Map competition (1..10) — bounties get higher competition, docs lower. */
function estimateCompetition(category: OpportunityCategory): number {
  switch (category) {
    case "github_bounty":
    case "bug_bounty":
      return 7;
    case "hackathon":
      return 8;
    case "grant":
      return 9;
    case "docs":
    case "content":
    case "oss_contribution":
      return 3;
    default:
      return 5;
  }
}

/** Extract `owner/repo` from the `repository_url` field or fall back to URL. */
function repoFullName(item: GitHubIssue): string {
  if (item.repository?.full_name) return item.repository.full_name;
  if (item.repository_url) {
    const parts = item.repository_url.split("/");
    const tail = parts.slice(-2).join("/");
    if (tail.includes("/")) return tail;
  }
  if (item.html_url) {
    try {
      const u = new URL(item.html_url);
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    } catch {
      // ignore
    }
  }
  return "unknown/unknown";
}

/** Convert one GitHub issue to a raw opportunity, or null if unusable. */
function itemToRaw(item: GitHubIssue): RawOpportunityInput | null {
  const title = (item.title ?? "").trim();
  const sourceUrl = (item.html_url ?? "").trim();
  if (!title || !sourceUrl) return null;

  const repo = repoFullName(item);
  const organization = repo.split("/")[0] ?? "unknown";
  const body = item.body ?? "";
  const labels = Array.isArray(item.labels) ? item.labels : [];

  const category = labelsToCategory(labels);
  const reward = extractReward(body);
  const estimatedHours = estimateHours(body, labels);
  const difficulty = estimateDifficulty(labels);
  const competition = estimateCompetition(category);

  return {
    title,
    description: body || `GitHub issue #${item.number ?? "?"} in ${repo}`,
    sourceUrl,
    organization,
    category,
    reward,
    deadline: null, // GitHub issues don't carry deadlines; leave to economics engine
    requirements: ["Open a PR linked to this issue", "Pass CI"],
    skillsRequired: inferSkills(body, labels),
    estimatedHours,
    difficulty,
    competition,
    eligibility: ["Sign the repo's contributor agreement"],
    paymentMethod: reward.amount > 0 ? "Per repo's bounty policy" : "",
    capitalRequired: false,
    source: "github_issues",
  };
}

function inferSkills(body: string, labels: { name?: string }[]): string[] {
  const skills: string[] = [];
  const text = `${body} ${labels.map((l) => l?.name ?? "").join(" ")}`.toLowerCase();
  if (/\btypescript\b|\bts\b/.test(text)) skills.push("typescript");
  if (/\bjavascript\b|\bjs\b/.test(text)) skills.push("javascript");
  if (/\breact\b/.test(text)) skills.push("react");
  if (/\bnext\.?js\b/.test(text)) skills.push("nextjs");
  if (/\bnode\b/.test(text)) skills.push("node");
  if (/\bpython\b|\bpy\b/.test(text)) skills.push("python");
  if (/\bsolidity\b/.test(text)) skills.push("solidity");
  if (/\brust\b/.test(text)) skills.push("rust");
  if (/\bsql\b|\bpostgres\b/.test(text)) skills.push("sql");
  if (/documentation|docs/.test(text)) skills.push("documentation");
  if (/\bsecurity\b|audit/.test(text)) skills.push("security-review");
  return skills;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
