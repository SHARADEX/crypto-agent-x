// Shared API serialization for Opportunity rows.
//
// The Prisma `Opportunity` model stores the reward as three flat scalar columns
// (rewardAmount / rewardCurrency / rewardUsd) and its list fields
// (requirements / skillsRequired / eligibility) as JSON-encoded STRINGS.
// The canonical `Opportunity` type (src/lib/agent/types.ts) — which the whole
// dashboard consumes — nests the reward (`reward.estimated_usd`) and uses real
// string arrays.
//
// Every API route that returns opportunities must pass its rows through
// `serializeOpportunity` so all endpoints emit the SAME canonical shape.
// (Introduced in v0.4.1: previously the LIST endpoint nested the reward while
// the DETAIL endpoint returned the raw flat row, forcing client-side
// shape-tolerance hacks — see opportunity-detail-sheet.tsx history.)

import type { Opportunity } from "./types";

/** Structural input: the scalar columns of the Prisma Opportunity row. */
export interface OpportunityRowScalars {
  id: string;
  canonicalId: string;
  title: string;
  description: string;
  source: string;
  sourceUrl: string;
  organization: string;
  category: string;
  rewardAmount: number;
  rewardCurrency: string;
  rewardUsd: number;
  deadline: Date | null;
  requirements: string;
  skillsRequired: string;
  estimatedHours: number;
  difficulty: number;
  competition: number;
  eligibility: string;
  paymentMethod: string;
  paymentVerified: boolean;
  sourceVerified: boolean;
  capitalRequired: boolean;
  watched: boolean;
  watchedAt: Date | null;
  riskScore: number;
  verificationScore: number;
  confidence: number;
  status: string;
  expectedValue: number;
  expectedHourly: number;
  riskAdjustedHourly: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Parse a JSON-encoded Prisma string column into a clean string array. */
export function safeParseStringArray(
  raw: string | null | undefined
): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

/** Convert a raw Prisma Opportunity row into the canonical API shape. */
export function serializeOpportunity(
  row: OpportunityRowScalars
): Opportunity {
  return {
    id: row.id,
    canonicalId: row.canonicalId,
    title: row.title,
    description: row.description,
    source: row.source,
    sourceUrl: row.sourceUrl,
    organization: row.organization,
    category: row.category,
    reward: {
      amount: row.rewardAmount,
      currency: row.rewardCurrency,
      estimated_usd: row.rewardUsd,
    },
    deadline: row.deadline ? row.deadline.toISOString() : null,
    requirements: safeParseStringArray(row.requirements),
    skillsRequired: safeParseStringArray(row.skillsRequired),
    estimatedHours: row.estimatedHours,
    difficulty: row.difficulty,
    competition: row.competition,
    eligibility: safeParseStringArray(row.eligibility),
    paymentMethod: row.paymentMethod,
    paymentVerified: row.paymentVerified,
    sourceVerified: row.sourceVerified,
    capitalRequired: row.capitalRequired,
    watched: row.watched ?? false,
    watchedAt: row.watchedAt ? row.watchedAt.toISOString() : null,
    riskScore: row.riskScore,
    verificationScore: row.verificationScore,
    confidence: row.confidence,
    status: row.status,
    expectedValue: row.expectedValue,
    expectedHourly: row.expectedHourly,
    riskAdjustedHourly: row.riskAdjustedHourly,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
