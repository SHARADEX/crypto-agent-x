// Typed fetch wrappers for the CryptoEarn Agent dashboard.
//
// Every function maps 1:1 to a backend API route under /src/app/api/* and
// returns the already-typed JSON shape. The wrappers normalize error
// handling so callers can just `await api.foo()` and either get a typed
// payload or throw an Error.
//
// All URLs are RELATIVE (per project gateway rules) — the Caddy gateway
// forwards `/api/*` to port 3000. We never write `http://localhost:3000`.

import type {
  AgentEventLog,
  AgentName,
  AgentRuntimeState,
  ApprovalRequest,
  AutonomyMode,
  BudgetReport,
  Chain,
  LedgerEntry,
  ModelRecord,
  ModelRole,
  ModelStatus,
  Opportunity,
  OpportunityCategory,
  OpportunityStatus,
  TaskStatus,
  EventLevel,
} from "@/lib/agent/types";
import type { ProviderStatus } from "@/lib/llm/providers/types";

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

export interface AgentStatusResponse extends AgentRuntimeState {
  canRun: { canRun: boolean; allowed?: boolean; reason?: string };
  budget: BudgetReport;
  killSwitch: {
    paused: boolean;
    emergencyStop: boolean;
    reason?: string;
    fetchedAt: string;
  };
  walletSummary?: {
    totalUsd: number;
    fetchedAt: string;
  };
}

export interface OpportunityListResponse {
  opportunities: Opportunity[];
  count: number;
  total: number;
  filteredTotal: number;
}

export interface TaskRow {
  id: string;
  opportunityId?: string;
  fromAgent: AgentName;
  toAgent: AgentName;
  objective: string;
  input: string; // JSON string
  output?: string; // JSON string
  constraints: string;
  riskLevel: string;
  executionLevel: number;
  status: TaskStatus;
  modelId?: string;
  tokensUsed: number;
  latencyMs: number;
  qualityScore?: number;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface TaskListResponse {
  tasks: TaskRow[];
  count: number;
}

export interface TransactionRow {
  id: string;
  walletId: string;
  opportunityId?: string;
  txHash: string;
  chain: Chain;
  fromAddress: string;
  toAddress: string;
  amount: number;
  currency: string;
  usdValue: number;
  direction: "incoming" | "outgoing";
  verified: boolean;
  matched: boolean;
  createdAt: string;
}

export interface TransactionListResponse {
  transactions: TransactionRow[];
  count: number;
}

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "improve"
  | "rework"
  | "request_changes"
  | "ask_agent"
  | "skip"
  | "pause";

export type ApprovalDecision =
  | "approve"
  | "reject"
  | "improve"
  | "rework"
  | "request_changes"
  | "ask_agent"
  | "skip"
  | "pause";

export type FeedbackType =
  | "ui"
  | "functionality"
  | "bugs"
  | "performance"
  | "visuals"
  | "gameplay"
  | "security"
  | "documentation"
  | "code_quality"
  | "requirements_mismatch"
  | "missing_feature"
  | "other";

export type FeedbackPriority = "low" | "medium" | "high" | "critical";

export interface ApprovalRow extends ApprovalRequest {
  feedback?: string | null;
  feedbackType?: FeedbackType | null;
  feedbackPriority?: FeedbackPriority | null;
  feedbackTargetAreas?: string | null;
  decidedAt?: string | null;
  decidedBy?: string | null;
  opportunity?: {
    id: string;
    title: string;
    description?: string;
    category: string;
    source: string;
    requirements?: string;
    rewardUsd: number;
    riskScore: number;
    expectedValue: number;
    riskAdjustedHourly: number;
    status?: string;
  };
}

export interface ApprovalListResponse {
  approvals: ApprovalRow[];
  count: number;
}

export interface IterationRow {
  id: string;
  taskId: string;
  iterationNumber: number;
  version: string;
  artifactJson: string;
  feedbackId: string | null;
  feedbackText: string | null;
  feedbackType: string | null;
  feedbackPriority: string | null;
  modelId: string | null;
  agentName: string | null;
  qualityScore: number | null;
  testResults: string | null;
  securityResults: string | null;
  status: string;
  tokensUsed: number;
  timeSpentMs: number;
  estimatedValueAdded: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface IterationsListResponse {
  iterations: IterationRow[];
  count: number;
  iterationCount: number;
  maxIterations: number;
  currentIterationId: string | null;
}

export interface IterationEconomics {
  expectedValueBefore: number;
  expectedValueAfter: number;
  incrementalExpectedValue: number;
  additionalTimeMs: number;
  incrementalHourlyReturnUsd: number;
  recommendation: "worth_it" | "marginal" | "not_worth_it";
  reason: string;
}

export interface QualityGateCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface QualityGateResult {
  checks: QualityGateCheck[];
  overall: "pass" | "warn" | "fail";
}

export interface ImprovementPlan {
  requestedChanges: string[];
  filesAffected: string[];
  expectedImprovements: string[];
  risk: "low" | "medium" | "high";
  estimatedTime: number;
  estimatedTokens: number;
  specialistAgent: "coding" | "web3" | "writing" | "security";
  modelId: string;
  testPlan: string[];
  source: "llm" | "heuristic_fallback";
}

export interface CompareIterationsResult {
  versionA: string;
  versionB: string;
  filesAdded: string[];
  filesRemoved: string[];
  filesChanged: Array<{ path: string; beforeLines: number; afterLines: number }>;
  /** Phase-3 dev-review #2: per-file line-level diff. Only present when the
   *  caller passes `includeLineDiffs: true` to `api.iterations.compare()`. */
  fileDiffs?: Array<{
    path: string;
    hunks: Array<{
      type: "added" | "removed" | "context";
      lineNo: number;
      text: string;
    }>;
  }>;
  qualityDelta: number;
  testResultsDelta: { passedDelta: number; failedDelta: number };
  safetyDelta: number;
  notes: string[];
}

export interface ApprovalDecisionResponse {
  approval: ApprovalRow;
  queueResult?: {
    queued: boolean;
    requiresApproval: boolean;
    reason: string;
  };
  iteration?: IterationRow;
  plan?: ImprovementPlan;
  planError?: string;
  reasonCategory?: string;
  canIterate?: boolean;
  iterationError?: string;
}

export interface WalletBalanceRow {
  label: string;
  chain: Chain;
  address: string;
  nativeBalance: number;
  nativeSymbol: string;
  usdValue: number;
  tokens: {
    contract: string;
    symbol: string;
    balance: number;
    usdValue: number;
  }[];
  fetchedAt: string;
  error?: string;
}

export interface WalletBalancesResponse {
  wallets: WalletBalanceRow[];
  totalUsd: number;
  fetchedAt: string;
}

export interface StrategyRow {
  strategy: string;
  discovered: number;
  attempted: number;
  completed: number;
  failed: number;
  successRate: number;
  totalNetUsd: number;
  avgHourly: number;
  effectiveAvgHourly: number;
  totalHours: number;
  attempts: number;
}

export interface StrategyListResponse {
  strategies: StrategyRow[];
  count: number;
}

// ---------------------------------------------------------------------------
// Strategy families + adaptive allocation (Phase 3 §16–§26).
// ---------------------------------------------------------------------------

export type StrategyFamily =
  | "bounty"
  | "freelance"
  | "hackathon"
  | "grant"
  | "contribution"
  | "build_once"
  | "reward_program";

export type StrategyFamilyTrend = "up" | "down" | "flat";

export interface FamilyStatsRollup {
  discovered: number;
  attempted: number;
  completed: number;
  failed: number;
  totalNetUsd: number;
  totalHours: number;
  avgHourly: number;
  successRate: number;
  subcategoryCount: number;
}

export interface AllocationRow {
  family: StrategyFamily;
  displayName: string;
  description: string;
  targetAllocation: number;
  defaultAllocation: number;
  minAllocation: number;
  maxAllocation: number;
  disabled: boolean;
  scanFrequency: "high" | "medium" | "low";
  lastRebalancedAt: string | null;
  rebalanceReason: string | null;
  updatedAt: string;
  stats: FamilyStatsRollup;
  trend: StrategyFamilyTrend;
}

export interface AllocationListResponse {
  allocations: AllocationRow[];
  count: number;
  totalTargetAllocation: number;
  isBalanced: boolean;
}

export interface AllocationChangeLogEntry {
  id: string;
  family: StrategyFamily;
  previousAllocation: number;
  newAllocation: number;
  reason: string;
  triggeredBy:
    | "adaptive_rebalancer"
    | "operator"
    | "auto_optimize"
    | "limit_override"
    | "toggle";
  createdAt: string;
}

export interface AllocationChangeLogResponse {
  changeLog: AllocationChangeLogEntry[];
  count: number;
}

export interface AllocationChangeResult {
  family: StrategyFamily;
  previous: number;
  next: number;
  delta: number;
  reason: string;
}

export interface AllocationActionResponse {
  ok: boolean;
  changes?: AllocationChangeResult[];
  newTarget?: number;
  rebalanced?: boolean;
  skippedReason?: string | null;
  family?: StrategyFamily;
  disabled?: boolean;
  error?: string;
}

export interface ModelListResponse {
  models: ModelRecord[];
  count: number;
}

// ---------------------------------------------------------------------------
// Phase-2 P2-20 §36: provider health, live quota, routing decisions, benchmark
// results — the 4 new dashboard panels for the Model Routing tab.
// ---------------------------------------------------------------------------

export interface ProviderHealthEntry {
  name: string;
  displayName: string;
  status: ProviderStatus;
  isConfigured: boolean;
  modelCount: number;
  lastHealthCheckLatencyMs: number | null;
}

export interface ProviderHealthResponse {
  providers: ProviderHealthEntry[];
  count: number;
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
  // Augmented by /api/models/quota — the provider-registry status so the
  // dashboard can colour-code the row (red when rate-limited, etc.).
  providerStatus: ProviderStatus | null;
}

export interface QuotaReportResponse {
  quota: QuotaReportEntry[];
  count: number;
  fetchedAt: string;
}

export interface RoutingDecisionEntry {
  id: string;
  createdAt: string;
  event: string;
  level: string;
  agent: string;
  taskId?: string;
  opportunityId?: string;
  runId?: string;
  taskType?: string;
  modelId?: string;
  fromModel?: string;
  toModel?: string;
  provider?: string;
  model?: string;
  routingLevel?: number;
  routeAttempt?: number;
  reason?: string;
  error?: string;
  wasFallback: boolean;
  excludedModelCount: number;
  tokens?: number;
  latencyMs?: number;
  status?: string;
}

export interface RoutingDecisionsResponse {
  routingDecisions: RoutingDecisionEntry[];
  count: number;
}

export interface BenchmarkCategoryScore {
  score: number;
  samples: number;
  passRate: number;
}

export interface BenchmarkSummaryRow {
  modelId: string;
  categories: Record<string, BenchmarkCategoryScore>;
  overallScore: number;
  totalSamples: number;
  benchmarkedAt: string;
}

export interface BenchmarkTableResponse {
  benchmarks: BenchmarkSummaryRow[];
  categories: string[];
  count: number;
}

// ---------------------------------------------------------------------------
// Persisted circuit-breaker state (Phase-2 P2-2)
// ---------------------------------------------------------------------------

export interface BreakerStateRow {
  modelId: string;
  status: "healthy" | "degraded" | "unhealthy" | "blacklisted";
  failureCount: number;
  blacklistUntil: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  updatedAt: string;
}

export interface BreakerLiveEntry {
  modelId: string;
  status: string;
  failures: number;
  blacklistUntil: number;
}

export interface BreakersResponse {
  persisted: BreakerStateRow[];
  live: BreakerLiveEntry[];
}

// ---------------------------------------------------------------------------
// Per-(model, taskType) cooldowns (Phase-2 P2-8)
// ---------------------------------------------------------------------------

export interface TaskCooldownEntry {
  id: string;
  modelId: string;
  taskType: string;
  consecutiveFailures: number;
  cooldownUntil: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Public read-only status (Phase-2 P3-4)
// ---------------------------------------------------------------------------

export interface PublicStatusResponse {
  agent: {
    running: boolean;
    paused: boolean;
    emergencyStop: boolean;
    autonomyMode: string;
    lastCycleAt: string | null;
    lastCycleResult: string | null;
    cycleCount: number;
  } | null;
  earnings: {
    verifiedNetUsd: number;
    verifiedGrossUsd: number;
    verifiedCount: number;
  };
  opportunities: {
    byStatus: Record<string, number>;
    total: number;
  };
  topStrategies: Array<{
    strategy: string;
    attempted: number;
    completed: number;
    totalNetUsd: number;
    avgHourly: number;
    successRate: number;
  }>;
  models: {
    enabledCount: number;
    byProvider: Record<string, number>;
  };
  recentEvents: Array<{
    id: string;
    agent: string;
    level: string;
    event: string;
    createdAt: string;
  }>;
  publicReadOnly: boolean;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// NDJSON event stream (Phase-2 P2-21 §38)
// ---------------------------------------------------------------------------

export interface EventStreamEntry {
  id: string;
  taskId: string | null;
  opportunityId: string | null;
  agent: AgentName;
  level: EventLevel;
  event: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface EventStreamQuery {
  limit?: number;
  level?: EventLevel;
  agent?: AgentName;
  opportunityId?: string;
  sinceId?: string;
  runId?: string;
}

export interface LedgerListResponse {
  ledger: LedgerEntry[];
  count: number;
}

export interface LedgerTotalsResponse {
  totals: {
    verifiedNetUsd: number;
    expectedNetUsd: number;
    totalGrossUsd: number;
    totalFeesUsd: number;
    totalExpensesUsd: number;
    totalNetUsd: number;
    totalHours: number;
    avgHourlyReturn: number;
    successRate: number;
    opportunitiesAttempted: number;
    opportunitiesCompleted: number;
    byCategory: Record<
      string,
      { grossUsd: number; netUsd: number; count: number }
    >;
    bySource: Record<
      string,
      { grossUsd: number; netUsd: number; count: number }
    >;
    byStrategy: Record<
      string,
      { grossUsd: number; netUsd: number; count: number }
    >;
  };
}

export interface AnalyticsResponse {
  totalVerifiedEarningsUsd: number;
  totalExpectedEarningsUsd: number;
  totalGrossUsd: number;
  opportunitiesDiscovered: number;
  opportunitiesAttempted: number;
  opportunitiesCompleted: number;
  successRate: number;
  avgHourlyReturn: number;
  totalHoursSpent: number;
  topStrategies: {
    strategy: string;
    avgHourly: number;
    effectiveAvgHourly: number;
    successRate: number;
    attempted: number;
    completed: number;
    totalNetUsd: number;
  }[];
  topModels: {
    model_id: string;
    provider: string;
    role: ModelRole;
    status: ModelStatus;
    enabled: boolean;
    earnings_contribution_usd: number;
    success_rate: number;
    average_quality: number;
  }[];
  recentEvents: AgentEventLog[];
  budgetReport: BudgetReport;
  walletSummary: {
    totalUsd: number;
    fetchedAt: string;
    walletCount: number;
  } | null;
  charts: {
    earningsOverTime: {
      date: string;
      verifiedUsd: number;
      expectedUsd: number;
    }[];
    opportunitiesByCategory: { category: string; count: number }[];
    opportunitiesByStatus: { status: string; count: number }[];
    earningsByCategory: {
      category: string;
      grossUsd: number;
      netUsd: number;
      count: number;
    }[];
    earningsBySource: {
      source: string;
      grossUsd: number;
      netUsd: number;
      count: number;
    }[];
  };
}

/**
 * Lifecycle analytics payload (Phase-3 STYLING-1).
 *
 * Returned by GET /api/analytics/lifecycle. Lists every opportunity status
 * along with the count of opportunities currently in that status and the
 * oldest `updatedAt` per status — used by the Lifecycle tab to detect
 * "stuck" opportunities (any non-terminal status older than 24h).
 */
export interface LifecycleAnalyticsResponse {
  statuses: {
    status: string;
    count: number;
    oldestUpdatedAt: string | null;
    /** Phase-3 dev-review #3: avg hours opportunities have spent in this
     *  status (midpoint approximation between oldest + newest). */
    avgHoursInStatus?: number;
    /** Phase-3 dev-review #3: the worst-case (oldest) opportunity's hours
     *  in this status. */
    maxHoursInStatus?: number;
  }[];
}

export interface OpportunityDetailResponse {
  opportunity: Opportunity & {
    tasks: TaskRow[];
    earnings: LedgerEntry[];
    transactions: TransactionRow[];
    approvals: ApprovalRow[];
    events: AgentEventLog[];
  };
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Invalid JSON from ${path} (status ${res.status})`);
  }
  if (!res.ok) {
    const msg =
      typeof json === "object" && json !== null && "error" in json
        ? String((json as { error: unknown }).error)
        : `Request to ${path} failed (status ${res.status})`;
    throw new Error(msg);
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// API surface — namespaced for ergonomic imports: `api.agent.status()`.
// ---------------------------------------------------------------------------

export const api = {
  agent: {
    status: () => apiFetch<AgentStatusResponse>("/api/agent/status"),
    runCycle: (cycles = 1, delayMs = 1000) =>
      apiFetch<{ cycles: unknown[]; count: number }>(
        "/api/agent/run-cycle",
        {
          method: "POST",
          body: JSON.stringify({ cycles, delayMs }),
        }
      ),
    pause: (reason?: string) =>
      apiFetch<{ state: AgentRuntimeState }>("/api/agent/pause", {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    resume: () =>
      apiFetch<{ state: AgentRuntimeState }>("/api/agent/resume", {
        method: "POST",
      }),
    emergencyStop: (reason?: string) =>
      apiFetch<{ state: AgentRuntimeState }>(
        "/api/agent/emergency-stop",
        {
          method: "POST",
          body: JSON.stringify({ reason }),
        }
      ),
    emergencyReset: () =>
      apiFetch<{ state: AgentRuntimeState }>(
        "/api/agent/emergency-reset",
        { method: "POST" }
      ),
    autonomy: (mode: AutonomyMode) =>
      apiFetch<{ state: AgentRuntimeState }>("/api/agent/autonomy", {
        method: "POST",
        body: JSON.stringify({ mode }),
      }),
  },

  opportunities: {
    list: (params: {
      status?: OpportunityStatus;
      category?: OpportunityCategory;
      source?: string;
      watched?: boolean;
      sort?: "score" | "reward" | "newest" | "deadline" | "watched";
      deadlineWithin?: number;
      limit?: number;
      offset?: number;
    } = {}) => {
      const q = new URLSearchParams();
      if (params.status) q.set("status", params.status);
      if (params.category) q.set("category", params.category);
      if (params.source) q.set("source", params.source);
      if (params.watched != null) q.set("watched", String(params.watched));
      if (params.sort) q.set("sort", params.sort);
      if (params.deadlineWithin != null)
        q.set("deadlineWithin", String(params.deadlineWithin));
      if (params.limit != null) q.set("limit", String(params.limit));
      if (params.offset != null) q.set("offset", String(params.offset));
      const qs = q.toString();
      return apiFetch<OpportunityListResponse>(
        `/api/opportunities${qs ? `?${qs}` : ""}`
      );
    },
    get: (id: string) =>
      apiFetch<OpportunityDetailResponse>(`/api/opportunities/${id}`),
    process: (id: string) =>
      apiFetch<{ result: unknown }>(
        `/api/opportunities/${id}/process`,
        { method: "POST" }
      ),
    verifyPayment: (id: string) =>
      apiFetch<{ result: unknown }>(
        `/api/opportunities/${id}/verify-payment`,
        { method: "POST" }
      ),
    seed: () =>
      apiFetch<{ summary: unknown }>(`/api/opportunities/seed`, {
        method: "POST",
      }),
    /** v0.4.1 watchlist: star/unstar an opportunity (pure UI state). */
    setWatched: (id: string, watched: boolean) =>
      apiFetch<{ opportunity: Opportunity }>(`/api/opportunities/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ watched }),
      }),
    /** Phase-3 DEV-REVIEW-10 (#2): fetch recently-updated terminal-state
     *  opportunities in a single query (replaces 3 separate status queries). */
    recent: (opts?: { terminal?: boolean; limit?: number }) => {
      const q = new URLSearchParams();
      if (opts?.terminal) q.set("terminal", "true");
      if (opts?.limit != null) q.set("limit", String(opts.limit));
      const qs = q.toString();
      return apiFetch<OpportunityListResponse>(
        `/api/opportunities/recent${qs ? `?${qs}` : ""}`
      );
    },
  },

  wallet: {
    balances: () => apiFetch<WalletBalancesResponse>("/api/wallet/balances"),
    transactions: (params: { limit?: number; chain?: Chain } = {}) => {
      const q = new URLSearchParams();
      if (params.limit != null) q.set("limit", String(params.limit));
      if (params.chain) q.set("chain", params.chain);
      const qs = q.toString();
      return apiFetch<TransactionListResponse>(
        `/api/wallet/transactions${qs ? `?${qs}` : ""}`
      );
    },
  },

  models: {
    list: (params: {
      enabled?: boolean;
      role?: ModelRole;
      status?: ModelStatus;
    } = {}) => {
      const q = new URLSearchParams();
      if (params.enabled != null)
        q.set("enabled", String(params.enabled));
      if (params.role) q.set("role", params.role);
      if (params.status) q.set("status", params.status);
      const qs = q.toString();
      return apiFetch<ModelListResponse>(
        `/api/models${qs ? `?${qs}` : ""}`
      );
    },
    update: (
      id: string,
      body: { role?: ModelRole; enabled?: boolean; status?: ModelStatus }
    ) =>
      apiFetch<{ model: ModelRecord }>(`/api/models/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    // Phase-2 P2-20 §36 — dashboard panels for the Model Routing tab.
    providers: () =>
      apiFetch<ProviderHealthResponse>("/api/models/providers"),
    quota: () => apiFetch<QuotaReportResponse>("/api/models/quota"),
    routingDecisions: (limit = 20) =>
      apiFetch<RoutingDecisionsResponse>(
        `/api/models/routing-decisions?limit=${limit}`
      ),
    benchmarks: () =>
      apiFetch<BenchmarkTableResponse>("/api/models/benchmarks"),
    // Phase-2 P2-2 — persisted circuit-breaker state.
    breakers: () => apiFetch<BreakersResponse>("/api/models/breakers"),
    resetBreakers: () =>
      apiFetch<{ cleared: number; modelsFlipped: number }>(
        "/api/models/breakers",
        {
          method: "POST",
          body: JSON.stringify({ action: "clear-all" }),
        }
      ),
    // Phase-2 P2-8 — per-(model, taskType) cooldowns.
    taskCooldowns: () =>
      apiFetch<{ cooldowns: TaskCooldownEntry[]; count: number }>(
        "/api/models/task-cooldowns"
      ),
    resetTaskCooldowns: () =>
      apiFetch<{ cleared: number }>("/api/models/task-cooldowns", {
        method: "POST",
      }),
  },

  sources: {
    // Phase-2 P2-3 — recompute SourceReputation.reliability from raw counters.
    recompute: (source?: string) =>
      apiFetch<{ recomputed: number; results: Array<{ source: string; reliability: number }> }>(
        "/api/sources/recompute",
        {
          method: "POST",
          body: JSON.stringify(source ? { source } : {}),
        }
      ),
  },

  public: {
    // Phase-2 P3-4 — public read-only status (safe to share).
    status: () => apiFetch<PublicStatusResponse>("/api/public/status"),
  },

  events: {
    list: (params: {
      limit?: number;
      level?: "debug" | "info" | "warn" | "error" | "critical";
      agent?: AgentName;
      opportunityId?: string;
    } = {}) => {
      const q = new URLSearchParams();
      if (params.limit != null) q.set("limit", String(params.limit));
      if (params.level) q.set("level", params.level);
      if (params.agent) q.set("agent", params.agent);
      if (params.opportunityId)
        q.set("opportunityId", params.opportunityId);
      const qs = q.toString();
      return apiFetch<{ events: AgentEventLog[]; count: number }>(
        `/api/events${qs ? `?${qs}` : ""}`
      );
    },
    // Phase-2 P2-21 §38 — NDJSON stream for live tailing. Returns an
    // array of events (the endpoint returns NDJSON text; we parse it
    // here so callers can use the same Promise-returning pattern as the
    // other endpoints). The dashboard polls this on its own cadence.
    stream: async (params: EventStreamQuery = {}): Promise<{
      events: EventStreamEntry[];
      count: number;
    }> => {
      const q = new URLSearchParams();
      if (params.limit != null) q.set("limit", String(params.limit));
      if (params.level) q.set("level", params.level);
      if (params.agent) q.set("agent", params.agent);
      if (params.opportunityId)
        q.set("opportunityId", params.opportunityId);
      if (params.sinceId) q.set("sinceId", params.sinceId);
      if (params.runId) q.set("runId", params.runId);
      const qs = q.toString();
      const res = await fetch(
        `/api/events/stream${qs ? `?${qs}` : ""}`,
        {
          headers: { Accept: "text/x-ndjson" },
        }
      );
      if (!res.ok) {
        throw new Error(
          `/api/events/stream failed (status ${res.status})`
        );
      }
      const text = await res.text();
      const events: EventStreamEntry[] = [];
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed) as EventStreamEntry);
        } catch {
          // Skip malformed lines — the stream is best-effort.
        }
      }
      return { events, count: events.length };
    },
  },

  strategies: {
    list: () => apiFetch<StrategyListResponse>("/api/strategies"),
    allocations: () => apiFetch<AllocationListResponse>("/api/strategies/allocations"),
    changeLog: (limit = 50) =>
      apiFetch<AllocationChangeLogResponse>(
        `/api/strategies/change-log?limit=${encodeURIComponent(limit)}`
      ),
    setAllocation: (family: StrategyFamily, targetAllocation: number) =>
      apiFetch<AllocationActionResponse>("/api/strategies/allocations", {
        method: "POST",
        body: JSON.stringify({
          action: "set_allocation",
          family,
          targetAllocation,
        }),
      }),
    autoOptimize: () =>
      apiFetch<AllocationActionResponse>("/api/strategies/allocations", {
        method: "POST",
        body: JSON.stringify({ action: "auto_optimize" }),
      }),
    setLimits: (family: StrategyFamily, min: number, max: number) =>
      apiFetch<AllocationActionResponse>("/api/strategies/allocations", {
        method: "POST",
        body: JSON.stringify({ action: "set_limits", family, min, max }),
      }),
    toggle: (family: StrategyFamily, disabled: boolean) =>
      apiFetch<AllocationActionResponse>("/api/strategies/allocations", {
        method: "POST",
        body: JSON.stringify({ action: "toggle", family, disabled }),
      }),
    rebalance: () =>
      apiFetch<AllocationActionResponse>("/api/strategies/allocations", {
        method: "POST",
        body: JSON.stringify({ action: "rebalance" }),
      }),
  },

  ledger: {
    list: (params: {
      verified?: boolean;
      source?: string;
      category?: string;
      limit?: number;
    } = {}) => {
      const q = new URLSearchParams();
      if (params.verified != null)
        q.set("verified", String(params.verified));
      if (params.source) q.set("source", params.source);
      if (params.category) q.set("category", params.category);
      if (params.limit != null) q.set("limit", String(params.limit));
      const qs = q.toString();
      return apiFetch<LedgerListResponse>(
        `/api/ledger${qs ? `?${qs}` : ""}`
      );
    },
    totals: () => apiFetch<LedgerTotalsResponse>("/api/ledger/totals"),
  },

  approvals: {
    list: (params: {
      status?:
        | "pending"
        | "approved"
        | "rejected"
        | "improve"
        | "rework"
        | "request_changes"
        | "ask_agent"
        | "skip"
        | "pause";
      limit?: number;
    } = {}) => {
      const q = new URLSearchParams();
      if (params.status) q.set("status", params.status);
      if (params.limit != null) q.set("limit", String(params.limit));
      const qs = q.toString();
      return apiFetch<ApprovalListResponse>(
        `/api/approvals${qs ? `?${qs}` : ""}`
      );
    },
    decide: (
      id: string,
      decision: ApprovalDecision,
      options: {
        decidedBy?: string;
        feedback?: string;
        feedbackType?: FeedbackType;
        feedbackPriority?: FeedbackPriority;
        feedbackTargetAreas?: string[];
        reasonCategory?: string;
      } = {}
    ) => {
      const body: Record<string, unknown> = { decision };
      if (options.decidedBy) body.decidedBy = options.decidedBy;
      if (options.feedback) body.feedback = options.feedback;
      if (options.feedbackType) body.feedbackType = options.feedbackType;
      if (options.feedbackPriority)
        body.feedbackPriority = options.feedbackPriority;
      if (options.feedbackTargetAreas && options.feedbackTargetAreas.length > 0) {
        body.feedbackTargetAreas = options.feedbackTargetAreas;
      }
      if (options.reasonCategory) body.reasonCategory = options.reasonCategory;
      return apiFetch<ApprovalDecisionResponse>(`/api/approvals/${id}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    /** Phase-3 DEV-REVIEW-4 (priority #5): apply the same decision to
     *  multiple Approval rows at once. Returns counts of applied / skipped
     *  / errored rows. */
    bulkDecide: (
      approvalIds: string[],
      decision: "approve" | "reject" | "skip" | "pause",
      options: { decidedBy?: string; feedback?: string } = {}
    ) => {
      const body: Record<string, unknown> = { approvalIds, decision };
      if (options.decidedBy) body.decidedBy = options.decidedBy;
      if (options.feedback) body.feedback = options.feedback;
      return apiFetch<{
        applied: number;
        skipped: number;
        errors: Array<{ id: string; error: string }>;
        appliedIds: string[];
        skippedRows: Array<{ id: string; reason: string }>;
        /** Phase-3 DEV-REVIEW-5 (#5): count of opportunities queued for
         *  immediate execution (only non-zero when decision="approve"). */
        triggered?: number;
      }>(`/api/approvals/bulk`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
  },

  iterations: {
    listForTask: (taskId: string) =>
      apiFetch<IterationsListResponse>(`/api/tasks/${taskId}/iterations`),
    get: (id: string) =>
      apiFetch<{ iteration: IterationRow }>(`/api/iterations/${id}`),
    qualityGate: (id: string) =>
      apiFetch<{ qualityGate: QualityGateResult }>(
        `/api/iterations/${id}/quality-gate`
      ),
    economics: (taskId: string) =>
      apiFetch<{ economics: IterationEconomics }>(
        `/api/tasks/${taskId}/iteration-economics`
      ),
    compare: (
      taskId: string,
      versionA: string,
      versionB: string,
      opts?: { includeLineDiffs?: boolean }
    ) => {
      const params = new URLSearchParams({
        versionA,
        versionB,
      });
      if (opts?.includeLineDiffs) params.set("includeLineDiffs", "true");
      return apiFetch<{ comparison: CompareIterationsResult }>(
        `/api/tasks/${taskId}/iterations/compare?${params.toString()}`
      );
    },
    restore: (id: string) =>
      apiFetch<{ iteration: IterationRow; restoredFrom: string; restoredFromVersion: string }>(
        `/api/iterations/${id}/restore`,
        { method: "POST" }
      ),
  },

  tasks: {
    list: (params: {
      status?: TaskStatus;
      limit?: number;
    } = {}) => {
      const q = new URLSearchParams();
      if (params.status) q.set("status", params.status);
      if (params.limit != null) q.set("limit", String(params.limit));
      const qs = q.toString();
      return apiFetch<TaskListResponse>(
        `/api/tasks${qs ? `?${qs}` : ""}`
      );
    },
    get: (id: string) => apiFetch<{ task: TaskRow }>(`/api/tasks/${id}`),
  },

  analytics: {
    get: () => apiFetch<AnalyticsResponse>("/api/analytics"),
    lifecycle: (opts?: { trueAverage?: boolean }) => {
      const params = new URLSearchParams();
      if (opts?.trueAverage) params.set("trueAverage", "true");
      const qs = params.toString();
      return apiFetch<LifecycleAnalyticsResponse & { trueAverage?: boolean }>(
        `/api/analytics/lifecycle${qs ? `?${qs}` : ""}`
      );
    },
  },
};

// ---------------------------------------------------------------------------
// Color + label helpers — used across every tab component so badges are
// visually consistent (spec §26 — colour matters for status).
// ---------------------------------------------------------------------------

export function statusColor(
  status: OpportunityStatus | TaskStatus | string
): {
  bg: string;
  text: string;
  border: string;
  borderLeft: string;
  label: string;
} {
  const s = status as OpportunityStatus | TaskStatus;
  switch (s) {
    case "discovered":
    case "pending":
      return {
        bg: "bg-slate-500/15 dark:bg-slate-500/20",
        text: "text-slate-700 dark:text-slate-300",
        border: "border-slate-500/30",
        borderLeft: "border-l-2 border-l-slate-500/80",
        label: s,
      };
    case "researching":
    case "running":
      return {
        bg: "bg-cyan-500/15 dark:bg-cyan-500/20",
        text: "text-cyan-700 dark:text-cyan-300",
        border: "border-cyan-500/30",
        borderLeft: "border-l-2 border-l-cyan-500/80",
        label: s,
      };
    case "verified":
    case "queued":
    case "approved":
    case "success":
    case "executed":
      return {
        bg: "bg-emerald-500/15 dark:bg-emerald-500/20",
        text: "text-emerald-700 dark:text-emerald-300",
        border: "border-emerald-500/30",
        borderLeft: "border-l-2 border-l-emerald-500/80",
        label: s,
      };
    case "planning":
    case "executing":
      return {
        bg: "bg-teal-500/15 dark:bg-teal-500/20",
        text: "text-teal-700 dark:text-teal-300",
        border: "border-teal-500/30",
        borderLeft: "border-l-2 border-l-teal-500/80",
        label: s,
      };
    case "awaiting_payment":
      return {
        bg: "bg-amber-500/15 dark:bg-amber-500/20",
        text: "text-amber-700 dark:text-amber-300",
        border: "border-amber-500/30",
        borderLeft: "border-l-2 border-l-amber-500/80",
        label: "awaiting payment",
      };
    case "submitted":
      // Phase-3 fix (Issue 10): PR opened, awaiting review/merge.
      return {
        bg: "bg-orange-500/15 dark:bg-orange-500/20",
        text: "text-orange-700 dark:text-orange-300",
        border: "border-orange-500/30",
        borderLeft: "border-l-2 border-l-orange-500/80",
        label: "submitted · awaiting PR merge",
      };
    case "needs_improvement":
      return {
        bg: "bg-rose-500/15 dark:bg-rose-500/20",
        text: "text-rose-700 dark:text-rose-300",
        border: "border-rose-500/30",
        borderLeft: "border-l-2 border-l-rose-500/80",
        label: "needs improvement",
      };
    case "paid":
      return {
        bg: "bg-emerald-600/20 dark:bg-emerald-600/25",
        text: "text-emerald-800 dark:text-emerald-200",
        border: "border-emerald-600/40",
        borderLeft: "border-l-2 border-l-emerald-600/90",
        label: "paid",
      };
    case "rejected":
    case "failed":
      return {
        bg: "bg-red-500/15 dark:bg-red-500/20",
        text: "text-red-700 dark:text-red-300",
        border: "border-red-500/30",
        borderLeft: "border-l-2 border-l-red-500/80",
        label: s,
      };
    case "skipped":
    case "cancelled":
      return {
        bg: "bg-zinc-500/15 dark:bg-zinc-500/20",
        text: "text-zinc-700 dark:text-zinc-300",
        border: "border-zinc-500/30",
        borderLeft: "border-l-2 border-l-zinc-500/80",
        label: s,
      };
    default:
      return {
        bg: "bg-slate-500/15 dark:bg-slate-500/20",
        text: "text-slate-700 dark:text-slate-300",
        border: "border-slate-500/30",
        borderLeft: "border-l-2 border-l-slate-500/80",
        label: s,
      };
  }
}

export function riskColor(score: number): string {
  if (score >= 70) return "bg-red-500";
  if (score >= 50) return "bg-amber-500";
  if (score >= 30) return "bg-yellow-500";
  return "bg-emerald-500";
}

export function riskLabel(score: number): string {
  if (score >= 70) return "Critical";
  if (score >= 50) return "High";
  if (score >= 30) return "Moderate";
  return "Low";
}

export function verificationColor(score: number): string {
  if (score >= 80) return "bg-emerald-500";
  if (score >= 60) return "bg-teal-500";
  if (score >= 30) return "bg-amber-500";
  return "bg-red-500";
}

export function eventLevelColor(
  level: "debug" | "info" | "warn" | "error" | "critical"
): { bg: string; text: string; border: string } {
  switch (level) {
    case "debug":
      return {
        bg: "bg-slate-500/15",
        text: "text-slate-600 dark:text-slate-400",
        border: "border-slate-500/30",
      };
    case "info":
      return {
        bg: "bg-emerald-500/15",
        text: "text-emerald-700 dark:text-emerald-300",
        border: "border-emerald-500/30",
      };
    case "warn":
      return {
        bg: "bg-amber-500/15",
        text: "text-amber-700 dark:text-amber-300",
        border: "border-amber-500/30",
      };
    case "error":
      return {
        bg: "bg-orange-500/15",
        text: "text-orange-700 dark:text-orange-300",
        border: "border-orange-500/30",
      };
    case "critical":
      return {
        bg: "bg-red-500/20",
        text: "text-red-700 dark:text-red-300",
        border: "border-red-500/40",
      };
  }
}

export function modelStatusColor(
  status: ModelStatus
): { bg: string; text: string; border: string } {
  switch (status) {
    case "healthy":
      return {
        bg: "bg-emerald-500/15",
        text: "text-emerald-700 dark:text-emerald-300",
        border: "border-emerald-500/30",
      };
    case "degraded":
      return {
        bg: "bg-amber-500/15",
        text: "text-amber-700 dark:text-amber-300",
        border: "border-amber-500/30",
      };
    case "unhealthy":
      return {
        bg: "bg-orange-500/15",
        text: "text-orange-700 dark:text-orange-300",
        border: "border-orange-500/30",
      };
    case "blacklisted":
      return {
        bg: "bg-red-500/20",
        text: "text-red-700 dark:text-red-300",
        border: "border-red-500/40",
      };
  }
}

export function providerColor(
  provider: string
): { bg: string; text: string; border: string } {
  switch (provider) {
    case "openrouter":
      return {
        bg: "bg-emerald-500/15",
        text: "text-emerald-700 dark:text-emerald-300",
        border: "border-emerald-500/30",
      };
    case "gemini":
      return {
        bg: "bg-teal-500/15",
        text: "text-teal-700 dark:text-teal-300",
        border: "border-teal-500/30",
      };
    case "groq":
      return {
        bg: "bg-orange-500/15",
        text: "text-orange-700 dark:text-orange-300",
        border: "border-orange-500/30",
      };
    case "cerebras":
      return {
        bg: "bg-amber-500/15",
        text: "text-amber-700 dark:text-amber-300",
        border: "border-amber-500/30",
      };
    case "zai":
      return {
        bg: "bg-rose-500/15",
        text: "text-rose-700 dark:text-rose-300",
        border: "border-rose-500/30",
      };
    default:
      return {
        bg: "bg-slate-500/15",
        text: "text-slate-700 dark:text-slate-300",
        border: "border-slate-500/30",
      };
  }
}

export function roleColor(
  role: ModelRole
): { bg: string; text: string; border: string } {
  switch (role) {
    case "primary":
      return {
        bg: "bg-emerald-500/15",
        text: "text-emerald-700 dark:text-emerald-300",
        border: "border-emerald-500/30",
      };
    case "secondary":
      return {
        bg: "bg-teal-500/15",
        text: "text-teal-700 dark:text-teal-300",
        border: "border-teal-500/30",
      };
    case "reviewer":
      return {
        bg: "bg-amber-500/15",
        text: "text-amber-700 dark:text-amber-300",
        border: "border-amber-500/30",
      };
    case "exploration":
      return {
        bg: "bg-cyan-500/15",
        text: "text-cyan-700 dark:text-cyan-300",
        border: "border-cyan-500/30",
      };
    case "disabled":
      return {
        bg: "bg-zinc-500/15",
        text: "text-zinc-700 dark:text-zinc-300",
        border: "border-zinc-500/30",
      };
  }
}

export function agentColor(
  agent: AgentName
): { bg: string; text: string; border: string } {
  // Pick a deterministic colour per agent so the dashboard reads at a glance.
  // Note: these are agent-level highlights, not primary brand colours.
  switch (agent) {
    case "orchestrator":
      return {
        bg: "bg-emerald-500/15",
        text: "text-emerald-700 dark:text-emerald-300",
        border: "border-emerald-500/30",
      };
    case "task_classifier":
      return {
        bg: "bg-cyan-500/15",
        text: "text-cyan-700 dark:text-cyan-300",
        border: "border-cyan-500/30",
      };
    case "model_router":
      return {
        bg: "bg-teal-500/15",
        text: "text-teal-700 dark:text-teal-300",
        border: "border-teal-500/30",
      };
    case "scout":
      return {
        bg: "bg-sky-500/15",
        text: "text-sky-700 dark:text-sky-300",
        border: "border-sky-500/30",
      };
    case "research":
      return {
        bg: "bg-violet-500/15",
        text: "text-violet-700 dark:text-violet-300",
        border: "border-violet-500/30",
      };
    case "verification":
      return {
        bg: "bg-amber-500/15",
        text: "text-amber-700 dark:text-amber-300",
        border: "border-amber-500/30",
      };
    case "economics":
      return {
        bg: "bg-yellow-500/15",
        text: "text-yellow-700 dark:text-yellow-300",
        border: "border-yellow-500/30",
      };
    case "coding":
      return {
        bg: "bg-rose-500/15",
        text: "text-rose-700 dark:text-rose-300",
        border: "border-rose-500/30",
      };
    case "web3":
      return {
        bg: "bg-purple-500/15",
        text: "text-purple-700 dark:text-purple-300",
        border: "border-purple-500/30",
      };
    case "writing":
      return {
        bg: "bg-pink-500/15",
        text: "text-pink-700 dark:text-pink-300",
        border: "border-pink-500/30",
      };
    case "security":
      return {
        bg: "bg-red-500/15",
        text: "text-red-700 dark:text-red-300",
        border: "border-red-500/30",
      };
    case "execution":
      return {
        bg: "bg-orange-500/15",
        text: "text-orange-700 dark:text-orange-300",
        border: "border-orange-500/30",
      };
    case "payment":
      return {
        bg: "bg-lime-500/15",
        text: "text-lime-700 dark:text-lime-300",
        border: "border-lime-500/30",
      };
    case "review":
      return {
        bg: "bg-fuchsia-500/15",
        text: "text-fuchsia-700 dark:text-fuchsia-300",
        border: "border-fuchsia-500/30",
      };
  }
}

export function chainColor(
  chain: Chain
): { bg: string; text: string; border: string; symbol: string } {
  const symbols: Record<string, string> = {
    ethereum: "ETH",
    bitcoin: "BTC",
    solana: "SOL",
    tron: "TRX",
    ronin: "RON",
    polygon: "MATIC",
    bsc: "BNB",
    arbitrum: "ARB",
    optimism: "OP",
  };
  switch (chain) {
    case "ethereum":
      return {
        bg: "bg-slate-500/15",
        text: "text-slate-700 dark:text-slate-300",
        border: "border-slate-500/30",
        symbol: symbols[chain],
      };
    case "bitcoin":
      return {
        bg: "bg-orange-500/15",
        text: "text-orange-700 dark:text-orange-300",
        border: "border-orange-500/30",
        symbol: "BTC",
      };
    case "solana":
      return {
        bg: "bg-purple-500/15",
        text: "text-purple-700 dark:text-purple-300",
        border: "border-purple-500/30",
        symbol: "SOL",
      };
    case "tron":
      return {
        bg: "bg-red-500/15",
        text: "text-red-700 dark:text-red-300",
        border: "border-red-500/30",
        symbol: "TRX",
      };
    case "ronin":
      return {
        bg: "bg-sky-500/15",
        text: "text-sky-700 dark:text-sky-300",
        border: "border-sky-500/30",
        symbol: "RON",
      };
    case "polygon":
      return {
        bg: "bg-purple-500/15",
        text: "text-purple-700 dark:text-purple-300",
        border: "border-purple-500/30",
        symbol: "MATIC",
      };
    case "bsc":
      return {
        bg: "bg-amber-500/15",
        text: "text-amber-700 dark:text-amber-300",
        border: "border-amber-500/30",
        symbol: "BNB",
      };
    case "arbitrum":
      return {
        bg: "bg-sky-500/15",
        text: "text-sky-700 dark:text-sky-300",
        border: "border-sky-500/30",
        symbol: "ARB",
      };
    case "optimism":
      return {
        bg: "bg-red-500/15",
        text: "text-red-700 dark:text-red-300",
        border: "border-red-500/30",
        symbol: "OP",
      };
  }
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

export function formatUsd(n: number, opts?: { compact?: boolean }): string {
  if (!Number.isFinite(n)) return "$0.00";
  if (opts?.compact && Math.abs(n) >= 1000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return new Intl.NumberFormat("en-US").format(n);
}

export function formatPct(n: number): string {
  if (!Number.isFinite(n)) return "0%";
  return `${(n * 100).toFixed(1)}%`;
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // Use UTC-based formatting to avoid locale-dependent hydration mismatches.
  // The server renders in UTC, the client also renders in UTC (no timezone
  // conversion), so both sides produce the same string.
  const now = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
    new Date().getUTCHours(),
    new Date().getUTCMinutes(),
    new Date().getUTCSeconds()
  );
  const diff = now - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (locale-independent)
}

export function truncateAddress(addr: string, head = 6, tail = 4): string {
  if (!addr) return "";
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function truncateText(text: string, max = 60): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
