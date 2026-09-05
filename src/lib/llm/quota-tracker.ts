// Per-provider quota tracker (Phase-2 P2-7 / spec §11).
//
// Tracks in-memory, per-provider: total requests + tokens this process has
// issued, the last-seen rate-limit headers, and an optional manual cooldown
// (set when a 429 is received). The router consults `canCall(provider)` when
// selecting a model so it can prefer providers with plenty of remaining
// quota and skip ones that are currently in cooldown.
//
// This is distinct from `BudgetManager` (which tracks aggregate tokens across
// ALL providers against the daily / hourly / per-task budget caps) — the
// QuotaTracker is per-provider rate-limit awareness.

import type { RateLimitHeaders } from "@/lib/llm/providers/types";

export interface QuotaEntry {
  requests: number;
  tokens: number;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
  lastError?: string;
  cooldownUntil: number;
  lastUpdatedAt: number;
}

export interface QuotaReportEntry {
  provider: string;
  requests: number;
  tokens: number;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
  cooldownUntil: number;
  inCooldown: boolean;
  lastError?: string;
}

const entries = new Map<string, QuotaEntry>();

function getEntry(name: string): QuotaEntry {
  let e = entries.get(name);
  if (!e) {
    e = {
      requests: 0,
      tokens: 0,
      cooldownUntil: 0,
      lastUpdatedAt: 0,
    };
    entries.set(name, e);
  }
  return e;
}

class QuotaTracker {
  /**
   * Record one observed usage + rate-limit snapshot. Called after every
   * provider call so the tracker always has fresh data.
   */
  record(
    provider: string,
    usage: {
      requests?: number;
      tokens?: number;
      lastError?: string;
      cooldownUntil?: number;
    },
    rateLimit?: RateLimitHeaders
  ): void {
    if (!provider) return;
    const e = getEntry(provider);
    if (usage.requests !== undefined) e.requests += usage.requests;
    if (usage.tokens !== undefined) e.tokens += usage.tokens;
    if (rateLimit) {
      if (rateLimit.remaining !== undefined) e.rateLimitRemaining = rateLimit.remaining;
      if (rateLimit.reset !== undefined) e.rateLimitReset = rateLimit.reset * 1000;
      if (rateLimit.retryAfter && rateLimit.retryAfter > 0) {
        e.cooldownUntil = Math.max(e.cooldownUntil, Date.now() + rateLimit.retryAfter * 1000);
      }
    }
    if (usage.lastError) e.lastError = usage.lastError;
    if (usage.cooldownUntil && usage.cooldownUntil > Date.now()) {
      e.cooldownUntil = Math.max(e.cooldownUntil, usage.cooldownUntil);
    }
    e.lastUpdatedAt = Date.now();
  }

  /** True if the provider is in cooldown OR has zero remaining rate-limit. */
  canCall(provider: string): boolean {
    const e = entries.get(provider);
    if (!e) return true; // no data — assume yes; a real call will reveal
    if (e.cooldownUntil > Date.now()) return false;
    if (e.rateLimitRemaining !== undefined && e.rateLimitRemaining === 0) {
      return false;
    }
    return true;
  }

  /** Manually push a provider into cooldown (e.g. on a 429). */
  setCooldown(provider: string, seconds: number): void {
    if (!provider || !Number.isFinite(seconds) || seconds <= 0) return;
    const e = getEntry(provider);
    e.cooldownUntil = Math.max(e.cooldownUntil, Date.now() + seconds * 1000);
  }

  /** Clear a provider's cooldown (operator override). */
  clearCooldown(provider: string): void {
    const e = entries.get(provider);
    if (!e) return;
    e.cooldownUntil = 0;
  }

  /** Read a snapshot for the dashboard. */
  getQuotaReport(): QuotaReportEntry[] {
    const now = Date.now();
    const out: QuotaReportEntry[] = [];
    for (const [name, e] of entries.entries()) {
      out.push({
        provider: name,
        requests: e.requests,
        tokens: e.tokens,
        rateLimitRemaining: e.rateLimitRemaining,
        rateLimitReset: e.rateLimitReset,
        cooldownUntil: e.cooldownUntil,
        inCooldown: e.cooldownUntil > now,
        lastError: e.lastError,
      });
    }
    return out.sort((a, b) => a.provider.localeCompare(b.provider));
  }

  /** Test-only: clear everything. */
  resetForTests(): void {
    entries.clear();
  }
}

export const quotaTracker = new QuotaTracker();
