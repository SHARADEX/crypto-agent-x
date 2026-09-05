// Source Discovery subsystem (Phase-2 spec §19, P1-9).
//
// This module discovers NEW potential opportunity sources. It is NOT a
// source-adapter itself — it inspects a candidate URL (submitted by the
// operator or surfaced by the Research Agent) and decides whether the URL
// should be added to the SOURCES array.
//
// `discoverNewSource(url)` runs a 12-step pipeline:
//   1. Validate the URL (HTTPS, not private/localhost).
//   2. Fetch the URL via researchTool.fetchUrl().
//   3. Verify the page mentions crypto/bounty/reward/grant/hackathon keywords.
//   4. Verify the organization (extract org name from page title/meta).
//   5. Inspect terms — scan for prohibited patterns (PROHIBITED_PATTERNS).
//   6. Determine reward mechanism (regex for $X USDC, prize pool, etc.).
//   7. Determine capital requirements (upfront payment? staking?).
//   8. Determine KYC requirements.
//   9. Security analysis (run `analyzeContent` from security-agent).
//   10. Reputation analysis (check SourceReputation table for this host).
//   11. Compute source_score (0..100).
//   12. If score >= 60 → return { activate: true, score, details } (but do
//       NOT auto-activate — the operator must approve via the dashboard).
//       If score < 60 → return { activate: false, score, reason }.
//
// Discovered sources are persisted to the `DiscoveredSource` Prisma model
// so the dashboard can render the approval queue across restarts. Approval
// (`activateSource(sourceId)`) registers the source in the in-memory
// SOURCES array — it does NOT persist across restarts (the operator must
// also add the source to `src/config/sources.ts`).

import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { logEvent } from "@/lib/agent/events";
import { validateUrl } from "@/lib/security/url-validator";
import { sanitizeExternalContent } from "@/lib/security/prompt-injection";
import { analyzeContent } from "@/lib/agents/security-agent";
import { getResearchTool } from "@/lib/research/research-tool";
import { PROHIBITED_PATTERNS } from "@/config/sources";
import {
  SOURCES,
  activateRuntimeSource,
  invalidateConfiguredSourcesCache,
} from "@/lib/agent/sources/index";
import { RssSource } from "@/lib/agent/sources/rss-source";
import type { OpportunitySource } from "@/lib/agent/sources/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiscoveredSourceRecord {
  id: string;
  url: string;
  host: string;
  organization: string;
  sourceScore: number;
  rewardMechanism: string;
  capitalRequired: string;
  kycRequired: string;
  details: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "stale";
  reason: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoverNewSourceResult {
  /** Whether the source scored high enough to be recommended for activation. */
  activate: boolean;
  /** 0..100 source score. */
  score: number;
  /** Human-readable reason for the verdict. */
  reason: string;
  /** Persisted DiscoveredSource row id (for the dashboard approval queue). */
  sourceId: string;
  /** URL that was inspected. */
  url: string;
  /** Extracted organization name. */
  organization: string;
  /** Computed reward-mechanism hint. */
  rewardMechanism: string;
  /** Computed capital requirement. */
  capitalRequired: string;
  /** Computed KYC requirement. */
  kycRequired: string;
  /** Full analysis details (keywords, prohibited patterns, security verdict). */
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Keywords that indicate the page is about crypto earning opportunities.
 * Used in step 3 of the pipeline. Match is case-insensitive against the
 * fetched page text.
 */
const OPPORTUNITY_KEYWORDS = [
  "bounty",
  "bounties",
  "reward",
  "prize",
  "grant",
  "hackathon",
  "usdc",
  "usdt",
  "dai",
  "ethereum",
  "solana",
  "polygon",
  "optimism",
  "arbitrum",
  "web3",
  "defi",
  "contribute",
  "opensource",
  "open-source",
  "oss",
];

/**
 * Regex patterns for reward-mechanism detection. The first match wins.
 */
const REWARD_MECHANISM_PATTERNS: Array<{ id: string; regex: RegExp }> = [
  { id: "prize_pool", regex: /prize\s*pool/i },
  { id: "matching_pool", regex: /matching\s*(pool|fund)/i },
  { id: "usdc_amount", regex: /(?:USDC|USDT|DAI)\s?\d+/i },
  { id: "dollar_amount", regex: /\$\s?\d{2,}/ },
  { id: "eth_amount", regex: /(?:ETH|SOL|MATIC)\s?\d+/i },
  { id: "reward_pool", regex: /reward\s*pool/i },
  { id: "grant", regex: /\bgrant\b/i },
  { id: "bounty", regex: /\bbounty\b/i },
];

/**
 * Capital-requirement hints. Matched against the page text.
 */
const CAPITAL_PATTERNS: Array<{ id: string; regex: RegExp }> = [
  { id: "upfront_payment", regex: /(?:upfront|deposit|required\s*payment|entry\s*fee)/i },
  { id: "staking", regex: /\bstak(?:e|ing)\b/i },
  { id: "gas_fee", regex: /\bgas\s*fee\b/i },
  { id: "none", regex: /free\s*to\s*enter|no\s*deposit|zero\s*cost/i },
];

/**
 * KYC-requirement hints.
 */
const KYC_PATTERNS: Array<{ id: "required"; regex: RegExp }> = [
  {
    id: "required",
    regex: /\bKYC\b|identity\s*verification|accredited\s*investor|AML\s*check/i,
  },
];

const ACTIVATION_THRESHOLD = 60;
const KEYWORD_MATCH_THRESHOLD = 2; // page must mention >= 2 opportunity keywords

// ---------------------------------------------------------------------------
// discoverNewSource — the 12-step pipeline
// ---------------------------------------------------------------------------

/**
 * Inspect a candidate URL and decide whether it should be added to the
 * SOURCES array. The decision is persisted to the `DiscoveredSource` table
 * for the dashboard's approval queue.
 *
 * NEVER auto-activates — even when `activate: true` is returned, the
 * operator must explicitly call {@link activateSource} (or click "Approve"
 * on the dashboard) to add the source to the in-memory SOURCES array.
 *
 * NEVER throws — every failure mode returns a structured result.
 */
export async function discoverNewSource(
  url: string
): Promise<DiscoverNewSourceResult> {
  // ---- Step 1: URL validation ------------------------------------------
  const validation = validateUrl(url);
  if (!validation.valid || !validation.safe) {
    return buildFailureResult(
      url,
      "",
      `URL rejected: ${validation.reasons.join("; ")}`,
      { step: 1, validation }
    );
  }
  const safeUrl = validation.normalized;

  let host = "";
  try {
    host = new URL(safeUrl).hostname.replace(/^www\./, "");
  } catch {
    // unreachable — validateUrl should have caught this
  }

  await logEvent(
    "scout",
    "info",
    "source_discovery_started",
    { url: safeUrl, host },
    {}
  );

  // ---- Step 2: Fetch the URL via researchTool ----------------------------
  const researchTool = getResearchTool();
  const fetchResult = await researchTool.fetchUrl(safeUrl, {
    timeoutMs: 10_000,
    maxBytes: 2 * 1024 * 1024,
  });
  if (!fetchResult.ok || !fetchResult.text) {
    return buildFailureResult(
      safeUrl,
      host,
      `Fetch failed: ${fetchResult.error ?? "no body"}`,
      { step: 2, fetchError: fetchResult.error }
    );
  }

  // The research-tool already sanitises the content (twice). For our
  // inspection we use the sanitised text — but we also re-sanitise here
  // for defense-in-depth (we're inspecting the text, not handing it to
  // the LLM, so the riskScore matters more than the wrapping).
  const sanitized = sanitizeExternalContent(fetchResult.text, `source-discovery:${safeUrl}`);
  const pageText = sanitized.safe ? sanitized.sanitized : fetchResult.text;
  const haystack = pageText.toLowerCase();

  // ---- Step 3: Verify opportunity keywords ------------------------------
  const matchedKeywords = OPPORTUNITY_KEYWORDS.filter((kw) =>
    haystack.includes(kw.toLowerCase())
  );
  if (matchedKeywords.length < KEYWORD_MATCH_THRESHOLD) {
    return buildFailureResult(
      safeUrl,
      host,
      `Page does not mention enough opportunity keywords (found ${matchedKeywords.length}/${KEYWORD_MATCH_THRESHOLD}: ${matchedKeywords.join(", ")})`,
      { step: 3, matchedKeywords, threshold: KEYWORD_MATCH_THRESHOLD }
    );
  }

  // ---- Step 4: Verify organization (extract org name from page meta) ----
  const organization = extractOrganization(pageText, host);
  if (!organization) {
    return buildFailureResult(
      safeUrl,
      host,
      "Could not extract organisation name from page title / meta",
      { step: 4 }
    );
  }

  // ---- Step 5: Inspect terms — prohibited patterns ---------------------
  const prohibitedHits: string[] = [];
  for (const pattern of PROHIBITED_PATTERNS) {
    if (pattern.test(haystack)) {
      prohibitedHits.push(pattern.source);
    }
  }
  if (prohibitedHits.length > 0) {
    return buildFailureResult(
      safeUrl,
      host,
      `Page matches ${prohibitedHits.length} prohibited pattern(s): ${prohibitedHits.join(", ")}`,
      { step: 5, prohibitedHits, organization },
      { organization }
    );
  }

  // ---- Step 6: Determine reward mechanism -------------------------------
  const rewardMechanism = detectFirstMatch(REWARD_MECHANISM_PATTERNS, haystack);

  // ---- Step 7: Determine capital requirements ---------------------------
  const capitalRequired = detectFirstMatch(CAPITAL_PATTERNS, haystack);

  // ---- Step 8: Determine KYC requirements -------------------------------
  const kycRequired = detectFirstMatch(KYC_PATTERNS, haystack) || "unknown";

  // ---- Step 9: Security analysis (analyzeContent) -----------------------
  let securityRiskScore = 0;
  let securityRecommendations: string[] = [];
  try {
    const sec = await analyzeContent(pageText, `source-discovery:${safeUrl}`);
    securityRiskScore = sec.riskScore;
    securityRecommendations = sec.recommendations;
    if (sec.shouldBlock) {
      return buildFailureResult(
        safeUrl,
        host,
        `Security agent shouldBlock (risk=${sec.riskScore}): ${sec.recommendations.slice(0, 2).join("; ")}`,
        {
          step: 9,
          securityRiskScore,
          securityRecommendations,
          organization,
          rewardMechanism,
          capitalRequired,
          kycRequired,
        },
        { organization }
      );
    }
  } catch (err) {
    // analyzeContent never throws (defensive), but be safe.
    securityRiskScore = 30;
    securityRecommendations = [
      `Security analysis failed: ${err instanceof Error ? err.message : String(err)}`,
    ];
  }

  // ---- Step 10: Reputation analysis (SourceReputation table) ------------
  let reputationScore = 50; // neutral default for unknown hosts
  let reputationOps = 0;
  let reputationScams = 0;
  try {
    const rep = await db.sourceReputation.findUnique({
      where: { source: host },
    });
    if (rep) {
      reputationScore = rep.reliability;
      reputationOps = rep.successfulOps;
      reputationScams = rep.scamDetections;
    }
  } catch (err) {
    console.warn("[source-discovery] reputation lookup failed:", err);
  }

  // ---- Step 11: Compute source_score (0..100) ---------------------------
  const score = computeSourceScore({
    keywordsMatched: matchedKeywords.length,
    rewardMechanism,
    capitalRequired,
    kycRequired,
    securityRiskScore,
    reputationScore,
    reputationOps,
    reputationScams,
  });

  const activate = score >= ACTIVATION_THRESHOLD;
  const reason = activate
    ? `Source scored ${score}/100 — meets activation threshold (${ACTIVATION_THRESHOLD}). Operator approval required.`
    : `Source scored ${score}/100 — below activation threshold (${ACTIVATION_THRESHOLD}).`;

  const details: Record<string, unknown> = {
    step: 11,
    matchedKeywords,
    rewardMechanism,
    capitalRequired,
    kycRequired,
    securityRiskScore,
    securityRecommendations,
    reputationScore,
    reputationOps,
    reputationScams,
    fetchStatus: fetchResult.status,
    fetchContentType: fetchResult.contentType,
    contentLength: fetchResult.bytes,
  };

  // ---- Step 12: Persist to DiscoveredSource ------------------------------
  let sourceId = "";
  try {
    const urlHash = sha256(safeUrl);
    // Upsert so re-discovering the same URL updates the row instead of
    // creating a duplicate.
    const row = await db.discoveredSource.upsert({
      where: { urlHash },
      create: {
        urlHash,
        url: safeUrl,
        host,
        organization,
        sourceScore: score,
        rewardMechanism,
        capitalRequired,
        kycRequired,
        details: JSON.stringify(details),
        status: activate ? "pending" : "rejected",
        reason,
      },
      update: {
        host,
        organization,
        sourceScore: score,
        rewardMechanism,
        capitalRequired,
        kycRequired,
        details: JSON.stringify(details),
        status: activate ? "pending" : "rejected",
        reason,
      },
    });
    sourceId = row.id;
  } catch (err) {
    console.error("[source-discovery] persist failed:", err);
    // Don't fail the whole pipeline if persistence breaks — return the
    // in-memory result so the caller can still see the verdict.
  }

  await logEvent(
    "scout",
    activate ? "info" : "warn",
    "source_discovery_complete",
    {
      url: safeUrl,
      host,
      organization,
      score,
      activate,
      rewardMechanism,
      capitalRequired,
      kycRequired,
      securityRiskScore,
      reputationScore,
      sourceId,
    },
    {}
  );

  return {
    activate,
    score,
    reason,
    sourceId,
    url: safeUrl,
    organization,
    rewardMechanism,
    capitalRequired,
    kycRequired,
    details,
  };
}

// ---------------------------------------------------------------------------
// getDiscoveredSources — dashboard approval queue
// ---------------------------------------------------------------------------

/**
 * Return recently-discovered sources for the dashboard's approval queue.
 * Defaults to "pending" sources (awaiting operator approval), newest first.
 * Pass `status` to fetch a different subset.
 *
 * NEVER throws — on DB error returns `[]`.
 */
export async function getDiscoveredSources(
  opts: { status?: "pending" | "approved" | "rejected" | "stale"; limit?: number } = {}
): Promise<DiscoveredSourceRecord[]> {
  try {
    const status = opts.status ?? "pending";
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const rows = await db.discoveredSource.findMany({
      where: { status },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(rowToRecord);
  } catch (err) {
    console.error("[source-discovery] getDiscoveredSources failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// activateSource — operator approval
// ---------------------------------------------------------------------------

/**
 * Mark a discovered source as approved and register it in the in-memory
 * SOURCES array. Used by the dashboard's "Approve" button.
 *
 * The source is added as a `RssSource` (the simplest adapter — works for
 * any URL that returns RSS/Atom XML). If the URL is not RSS, the source
 * will simply return `[]` from `discover()` and report `ok: false` from
 * `healthCheck()`; the operator can later add a proper adapter to config.
 *
 * Does NOT persist across restarts — the operator must also add the source
 * to `src/config/sources.ts` for it to survive a restart.
 *
 * @returns `{ ok: true, sourceId }` on success, or `{ ok: false, error }`
 *          if the discovered-source row doesn't exist or is already approved.
 */
export async function activateSource(
  sourceId: string
): Promise<{ ok: boolean; error?: string; source?: OpportunitySource }> {
  try {
    const row = await db.discoveredSource.findUnique({
      where: { id: sourceId },
    });
    if (!row) {
      return { ok: false, error: "DiscoveredSource row not found." };
    }
    if (row.status === "approved") {
      return { ok: false, error: "Source is already approved." };
    }

    // Register the source in the in-memory SOURCES array.
    const source: OpportunitySource = new RssSource({
      id: `discovered_${sha256(row.url).slice(0, 12)}`,
      name: `${row.organization || row.host} (discovered)`,
      feedUrl: row.url,
      reliabilitySeed: Math.max(0, Math.min(100, row.sourceScore)),
      defaultMaxResults: 15,
    });
    const added = activateRuntimeSource(source);
    if (!added) {
      return { ok: false, error: "Source already registered in SOURCES array." };
    }

    // Mark the row as approved.
    await db.discoveredSource.update({
      where: { id: sourceId },
      data: { status: "approved" },
    });

    // Invalidate the configured-sources cache so the next cycle picks up
    // the new source.
    invalidateConfiguredSourcesCache();

    await logEvent(
      "scout",
      "info",
      "source_discovery_activated",
      {
        sourceId,
        url: row.url,
        host: row.host,
        organization: row.organization,
        sourceScore: row.sourceScore,
        newSourceId: source.id,
      },
      {}
    );

    return { ok: true, source };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[source-discovery] activateSource failed:", err);
    return { ok: false, error: msg };
  }
}

/**
 * Mark a discovered source as rejected. The source is NOT added to the
 * SOURCES array.
 */
export async function rejectSource(
  sourceId: string,
  reason?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const row = await db.discoveredSource.findUnique({
      where: { id: sourceId },
    });
    if (!row) return { ok: false, error: "DiscoveredSource row not found." };
    await db.discoveredSource.update({
      where: { id: sourceId },
      data: { status: "rejected", reason: reason ?? row.reason },
    });
    await logEvent(
      "scout",
      "info",
      "source_discovery_rejected",
      { sourceId, url: row.url, host: row.host, reason: reason ?? row.reason },
      {}
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function extractOrganization(pageText: string, fallbackHost: string): string {
  // Try og:site_name first.
  const ogMatch = pageText.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (ogMatch && ogMatch[1]) return ogMatch[1].trim();
  // Try <title>…</title>.
  const titleMatch = pageText.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    const title = titleMatch[1].trim();
    // Strip suffixes like " | HackerNews" or " - Devpost".
    const sep = title.indexOf(" | ");
    if (sep > 0) return title.slice(0, sep).trim();
    const sep2 = title.indexOf(" - ");
    if (sep2 > 0) return title.slice(0, sep2).trim();
    return title;
  }
  // Fall back to the hostname.
  return fallbackHost;
}

function detectFirstMatch(
  patterns: Array<{ id: string; regex: RegExp }>,
  haystack: string
): string {
  for (const p of patterns) {
    if (p.regex.test(haystack)) return p.id;
  }
  return "";
}

function computeSourceScore(input: {
  keywordsMatched: number;
  rewardMechanism: string;
  capitalRequired: string;
  kycRequired: string;
  securityRiskScore: number;
  reputationScore: number;
  reputationOps: number;
  reputationScams: number;
}): number {
  let score = 0;

  // Keyword richness (max 20).
  score += Math.min(20, input.keywordsMatched * 4);

  // Reward mechanism detected (max 20).
  if (input.rewardMechanism) score += 20;

  // Capital requirements (max 15). "none" is best; "staking" / "gas_fee"
  // are tolerable; "upfront_payment" is a red flag.
  if (input.capitalRequired === "none") score += 15;
  else if (input.capitalRequired === "gas_fee") score += 10;
  else if (input.capitalRequired === "staking") score += 5;
  else if (input.capitalRequired === "upfront_payment") score -= 15;

  // KYC (max 5). KYC-required is not disqualifying but reduces score.
  if (input.kycRequired === "not_required") score += 5;
  else if (input.kycRequired === "required") score += 0;
  else score += 2; // unknown — neutral

  // Security risk (max 25). Lower risk = higher score.
  if (input.securityRiskScore < 20) score += 25;
  else if (input.securityRiskScore < 40) score += 18;
  else if (input.securityRiskScore < 60) score += 10;
  else if (input.securityRiskScore < 80) score += 0;
  else score -= 20; // very risky — penalty

  // Reputation (max 25). New host = 50/100 neutral.
  score += Math.round((input.reputationScore / 100) * 25);
  if (input.reputationScams > 0) {
    score -= Math.min(20, input.reputationScams * 5);
  }
  if (input.reputationOps > 10) {
    score += 5; // bonus for established source
  }

  return Math.max(0, Math.min(100, score));
}

function buildFailureResult(
  url: string,
  host: string,
  reason: string,
  details: Record<string, unknown>,
  opts: { organization?: string } = {}
): DiscoverNewSourceResult {
  // Persist the failure for the dashboard's approval queue (so the operator
  // can see why a URL was rejected).
  let sourceId = "";
  try {
    const urlHash = sha256(url);
    void db.discoveredSource
      .upsert({
        where: { urlHash },
        create: {
          urlHash,
          url,
          host,
          organization: opts.organization ?? "",
          sourceScore: 0,
          rewardMechanism: "",
          capitalRequired: "none",
          kycRequired: "unknown",
          details: JSON.stringify(details),
          status: "rejected",
          reason,
        },
        update: {
          host,
          organization: opts.organization ?? "",
          sourceScore: 0,
          rewardMechanism: "",
          capitalRequired: "none",
          kycRequired: "unknown",
          details: JSON.stringify(details),
          status: "rejected",
          reason,
        },
      })
      .then((row) => {
        sourceId = row.id;
      })
      .catch((err) => {
        console.error("[source-discovery] persist failure:", err);
      });
  } catch (err) {
    console.error("[source-discovery] persist failure (outer):", err);
  }

  return {
    activate: false,
    score: 0,
    reason,
    sourceId,
    url,
    organization: opts.organization ?? "",
    rewardMechanism: "",
    capitalRequired: "none",
    kycRequired: "unknown",
    details,
  };
}

function rowToRecord(row: {
  id: string;
  url: string;
  host: string;
  organization: string;
  sourceScore: number;
  rewardMechanism: string;
  capitalRequired: string;
  kycRequired: string;
  details: string;
  status: string;
  reason: string;
  createdAt: Date;
  updatedAt: Date;
}): DiscoveredSourceRecord {
  let details: Record<string, unknown> = {};
  try {
    details = row.details ? (JSON.parse(row.details) as Record<string, unknown>) : {};
  } catch {
    details = { raw: row.details };
  }
  return {
    id: row.id,
    url: row.url,
    host: row.host,
    organization: row.organization,
    sourceScore: row.sourceScore,
    rewardMechanism: row.rewardMechanism,
    capitalRequired: row.capitalRequired,
    kycRequired: row.kycRequired,
    details,
    status: row.status as DiscoveredSourceRecord["status"],
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Re-export SOURCES for convenience (callers can import from this module)
// ---------------------------------------------------------------------------

export { SOURCES } from "@/lib/agent/sources/index";
