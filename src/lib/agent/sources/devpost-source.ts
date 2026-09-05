// Devpost hackathons source adapter (Phase-2 spec §18, P1-10).
//
// Wraps the public Devpost hackathons listing endpoint:
//   https://devpost.com/api/hackathons?status=open&order_by=prize-amount
//
// The endpoint is public — no auth required. It returns a JSON list of
// open hackathons sorted by prize amount. Each hackathon becomes a
// `RawOpportunityInput` (category: `hackathon`).
//
// This is a BEST-EFFORT adapter: Devpost's API is not officially
// documented as a stable public API. When the endpoint is unreachable,
// schema changes, or the sanitiser drops the response, `discover()`
// returns `[]` and `healthCheck()` returns `{ ok: false }`.

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

export const DEVPOST_API_URL =
  "https://devpost.com/api/hackathons?status=open&order_by=prize-amount";

interface DevpostResponse {
  hackathons?: DevpostHackathon[];
  total_hackathons?: number;
  errors?: unknown;
}

interface DevpostHackathon {
  title?: string;
  url?: string;
  url_overview?: string;
  display_name?: string;
  tagline?: string;
  thumbnail_url?: string;
  prize_amount?: string | number;
  prize_amount_num?: number;
  submissions_period_end?: string;
  submissions_period_start?: string;
  registration_period_end?: string;
  organization?: string;
  themes?: Array<{ id?: number; name?: string }>;
  technologies?: Array<{ id?: number; name?: string }>;
  open_state?: string;
  location_type?: string; // "online" | "in-person" | "hybrid"
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface DevpostSourceOptions {
  endpoint?: string;
  defaultMaxResults?: number;
}

export class DevpostSource implements OpportunitySource {
  readonly id = "devpost_hackathons";
  readonly name = "Devpost Hackathons (public API)";
  readonly type = "api" as const;

  private readonly endpoint: string;
  private readonly defaultMaxResults: number;

  constructor(opts: DevpostSourceOptions = {}) {
    this.endpoint = opts.endpoint ?? DEVPOST_API_URL;
    this.defaultMaxResults = opts.defaultMaxResults ?? 20;
  }

  async discover(opts?: DiscoverOptions): Promise<RawOpportunityInput[]> {
    const limit = Math.max(1, Math.min(opts?.maxResults ?? this.defaultMaxResults, 50));
    try {
      // Devpost supports `page` + `per_page` query params, but the public
      // API shape isn't well-documented; we hit the top-N URL.
      const url = `${this.endpoint}${this.endpoint.includes("?") ? "&" : "?"}per_page=${limit}`;
      const result = await fetchJsonSafe<DevpostResponse>(url);

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

      const hackathons = result.json.hackathons ?? [];
      const out: RawOpportunityInput[] = [];
      for (const h of hackathons) {
        const raw = hackathonToRaw(h);
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
      const result = await fetchJsonSafe<DevpostResponse>(
        `${this.endpoint}${this.endpoint.includes("?") ? "&" : "?"}per_page=1`,
        { method: "GET" },
        { timeoutMs: 8_000 }
      );
      if (!result.ok) {
        return { ok: false, detail: `Devpost unreachable: ${result.error ?? "unknown"}` };
      }
      return { ok: true, detail: "Devpost API reachable", latencyMs: result.latencyMs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `Devpost unreachable: ${msg}` };
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
          organization: r.organization ?? "Devpost",
          category: r.category ?? "hackathon",
          reward: r.reward ?? { amount: 0, currency: "USDC", estimated_usd: 0 },
          deadline: r.deadline ?? null,
          requirements: r.requirements ?? [],
          skillsRequired: r.skillsRequired ?? [],
          estimatedHours: r.estimatedHours ?? 40,
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
      category: "hackathon",
      source: this.id,
    };
  }
}

// ---------------------------------------------------------------------------
// Hackathon → RawOpportunityInput mapping
// ---------------------------------------------------------------------------

function hackathonToRaw(h: DevpostHackathon): RawOpportunityInput | null {
  const title = toStr(h.title || h.display_name);
  const sourceUrl = toStr(h.url || h.url_overview);
  if (!title || !sourceUrl) return null;

  // Prize amount can come as a string "$5,000" or a number 5000 or
  // prize_amount_num.
  let prizeUsd = 0;
  if (typeof h.prize_amount_num === "number") {
    prizeUsd = h.prize_amount_num;
  } else if (typeof h.prize_amount === "number") {
    prizeUsd = h.prize_amount;
  } else {
    const cleaned = (h.prize_amount ?? "").replace(/[$,\s]/g, "");
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed) && parsed > 0) prizeUsd = parsed;
  }
  prizeUsd = clampNum(prizeUsd, 0, 10_000_000, 0);

  const deadline = h.submissions_period_end ?? h.registration_period_end ?? null;
  const organization = toStr(h.organization, "Devpost");
  const tagline = toStr(h.tagline, "");
  const themes = (h.themes ?? []).map((t) => toStr(t.name)).filter(Boolean);
  const techs = (h.technologies ?? []).map((t) => toStr(t.name)).filter(Boolean);
  const locationType = toStr(h.location_type, "online");

  const description = [
    tagline || `${title} — open hackathon on Devpost.`,
    `Prize pool: ${prizeUsd > 0 ? "$" + prizeUsd.toLocaleString() : "not disclosed"}.`,
    `Format: ${locationType}.`,
    themes.length > 0 ? `Themes: ${themes.join(", ")}.` : "",
    `Submission deadline: ${deadline ? deadline.slice(0, 10) : "see Devpost page"}.`,
  ].filter(Boolean).join(" ");

  return {
    title,
    description,
    sourceUrl,
    organization,
    category: "hackathon",
    reward: {
      amount: prizeUsd,
      currency: "USDC",
      estimated_usd: prizeUsd,
    },
    deadline,
    requirements: [
      "Register on Devpost before the deadline",
      "Submit a deployed demo + 3-minute video",
      "Open-source the code under MIT or Apache-2",
    ],
    skillsRequired: techs.length > 0 ? techs : ["typescript", "react", "nextjs"],
    estimatedHours: 40,
    difficulty: 6,
    competition: 8,
    eligibility: [
      "Open to individuals and teams (size limit per hackathon rules)",
      `Location: ${locationType}`,
    ],
    paymentMethod: prizeUsd > 0 ? "Prize pool paid per hackathon rules" : "Per hackathon rules",
    capitalRequired: false,
    source: "devpost_hackathons",
  };
}
