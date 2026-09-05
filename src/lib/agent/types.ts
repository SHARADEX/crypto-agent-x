// Canonical types for the Autonomous Zero-Cost Crypto Earning Agent.
// These mirror the JSON shapes defined in the master spec (§5, §6, §7, §8,
// §11, §12, §14, §4C, §4M) and are used across the orchestrator, agents,
// API routes, and dashboard.

// ---------------------------------------------------------------------------
// Opportunity lifecycle (spec §5, §6, §7, §8, §9, §24)
// ---------------------------------------------------------------------------

export type OpportunityCategory =
  | "bounty"
  | "github_bounty"
  | "bug_bounty"
  | "hackathon"
  | "docs"
  | "developer_task"
  | "coding_task"
  | "data_task"
  | "freelance"
  | "grant"
  | "ecosystem"
  | "referral"
  | "content"
  | "oss_contribution";

export type OpportunityStatus =
  | "discovered"
  | "researching"
  | "verified"
  | "rejected"
  | "queued"
  | "planning"
  | "approved"
  | "executing"
  | "executed"
  | "submitted" // Phase-3 fix (Issue 10): PR opened, awaiting review/merge.
                 // Distinct from awaiting_payment so the PR monitor can
                 // transition submitted → awaiting_payment ONLY when the
                 // PR is actually merged (not on review acceptance).
  | "awaiting_payment"
  | "needs_improvement"
  | "paid"
  | "failed";

export type DeadlineBucket = "critical" | "urgent" | "normal" | "long" | "none";

export interface Reward {
  amount: number;
  currency: string;
  estimated_usd: number;
}

export interface Opportunity {
  id: string;
  canonicalId: string;
  title: string;
  description: string;
  source: string;
  sourceUrl: string;
  organization: string;
  category: OpportunityCategory;
  reward: Reward;
  deadline: string | null;
  requirements: string[];
  skillsRequired: string[];
  estimatedHours: number;
  difficulty: number; // 1..10
  competition: number; // 1..10
  eligibility: string[];
  paymentMethod: string;
  paymentVerified: boolean;
  sourceVerified: boolean;
  riskScore: number; // 0..100
  verificationScore: number; // 0..100
  confidence: number; // 0..1
  status: OpportunityStatus;
  expectedValue: number;
  expectedHourly: number;
  riskAdjustedHourly: number;
  capitalRequired: boolean;
  watched: boolean; // operator watchlist (v0.4.1) — UI state only
  watchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Specialist agents (spec §4B)
// ---------------------------------------------------------------------------

export type AgentName =
  | "orchestrator"
  | "task_classifier"
  | "model_router"
  | "scout"
  | "research"
  | "verification"
  | "economics"
  | "coding"
  | "web3"
  | "writing"
  | "security"
  | "execution"
  | "payment"
  | "review";

export type TaskStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped"
  | "cancelled";

export type RiskLevel = "read" | "low" | "moderate" | "high";

export type ExecutionLevel = 0 | 1 | 2 | 3;

export interface TaskHandoff {
  task_id: string;
  parent_task_id?: string;
  from_agent: AgentName;
  to_agent: AgentName;
  objective: string;
  input: Record<string, unknown>;
  constraints: string[];
  risk_level: RiskLevel;
  expected_output: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Economic engine (spec §8)
// ---------------------------------------------------------------------------

export interface EconomicsEstimate {
  expected_reward: number;
  probability_of_success: number; // 0..1
  estimated_hours: number;
  competition: number; // 0..1
  execution_cost_usd: number;
  risk: number; // 0..1
  deadline_pressure: number; // 0..1
  capital_required: number;
  payment_probability: number; // 0..1
  expected_value: number;
  expected_hourly_return: number;
  risk_adjusted_hourly_return: number;
  unified_score: number; // 0..100
}

// ---------------------------------------------------------------------------
// Verification + scam detection (spec §6, §7)
// ---------------------------------------------------------------------------

export type VerificationTier = "VERIFIED" | "UNVERIFIED" | "SUSPICIOUS";

export interface VerificationResult {
  tier: VerificationTier;
  verificationScore: number; // 0..100
  riskScore: number; // 0..100
  confidence: number; // 0..1
  checks: VerificationCheck[];
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  severity: "info" | "warn" | "critical";
  detail: string;
}

export type ScamSignal =
  | "upfront_payment"
  | "seed_phrase_request"
  | "private_key_request"
  | "suspicious_signing"
  | "malicious_contract"
  | "suspicious_download"
  | "fake_reward"
  | "impersonation"
  | "domain_mismatch"
  | "new_account"
  | "unrealistic_reward"
  | "referral_pyramid"
  | "guaranteed_profit"
  | "fake_airdrop"
  | "phishing"
  | "wallet_drainer"
  | "credential_harvesting";

export interface ScamDetectionResult {
  isScam: boolean;
  riskScore: number; // 0..100
  signals: ScamSignal[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Wallet + payment (spec §12, §13, §14)
// ---------------------------------------------------------------------------

export type Chain =
  | "ethereum"
  | "bitcoin"
  | "solana"
  | "tron"
  | "ronin"
  | "polygon"
  | "bsc"
  | "arbitrum"
  | "optimism";

export interface WalletConfig {
  label: string;
  chain: Chain;
  address: string;
  explorer: string;
}

export interface WalletBalance {
  label: string;
  chain: Chain;
  address: string;
  nativeBalance: number;
  nativeSymbol: string;
  usdValue: number;
  tokens: TokenBalance[];
  fetchedAt: string;
  error?: string;
}

export interface TokenBalance {
  contract: string;
  symbol: string;
  balance: number;
  usdValue: number;
}

export interface PaymentVerificationResult {
  matched: boolean;
  transactionHash?: string;
  chain?: Chain;
  amount?: number;
  currency?: string;
  usdValue?: number;
  status: "matched" | "amount_mismatch" | "wrong_recipient" | "unverified" | "suspicious";
  notes: string[];
}

// ---------------------------------------------------------------------------
// LLM model registry + router (spec §4C–§4R)
// ---------------------------------------------------------------------------

export type Provider =
  | "openrouter"
  | "gemini"
  | "groq"
  | "cerebras"
  | "zai"
  | "huggingface"
  | "mistral"
  | "cloudflare"
  | "nvidia";

export type ModelRole = "primary" | "secondary" | "reviewer" | "exploration" | "disabled";

export type ModelStatus = "healthy" | "degraded" | "unhealthy" | "blacklisted";

export interface ModelCapabilities {
  reasoning: number;
  coding: number;
  research: number;
  web_research: number;
  web3: number;
  security: number;
  writing: number;
  tool_use: number;
  structured_output: number;
}

export interface ModelPerformance {
  success_rate: number;
  average_quality: number;
  average_latency: number;
  average_tokens: number;
  failure_rate: number;
}

export interface ModelLimits {
  requests_per_minute: number;
  tokens_per_minute: number;
  daily_requests: number;
  daily_tokens: number;
}

export interface ModelRecord {
  model_id: string;
  provider: Provider;
  api_type: string;
  enabled: boolean;
  capabilities: ModelCapabilities;
  performance: ModelPerformance;
  limits: ModelLimits;
  role: ModelRole;
  status: ModelStatus;
  earnings_contribution_usd: number;
}

export interface RoutingDecision {
  task_type: string;
  complexity: "low" | "medium" | "high";
  required_capabilities: Partial<ModelCapabilities>;
  context_size: number;
  latency_requirement: "low" | "medium" | "high";
  reliability_requirement: "low" | "medium" | "high";
  risk_level: RiskLevel;
  routing_level: 1 | 2 | 3 | 4; // deterministic | classifier | specialist | panel
  selected_models: string[];
  reason: string;
}

// ---------------------------------------------------------------------------
// Human approvals + autonomy (spec §11, §25, §37)
// ---------------------------------------------------------------------------

export type AutonomyMode = "observe" | "assist" | "semi" | "full";

export interface ApprovalRequest {
  id: string;
  opportunityId?: string;
  taskId?: string;
  riskLevel: "moderate" | "high" | "financial";
  executionLevel: 2 | 3;
  reason: string;
  status: "pending" | "approved" | "rejected" | "skipped";
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Agent runtime state (spec §26, §28)
// ---------------------------------------------------------------------------

export interface AgentRuntimeState {
  running: boolean;
  paused: boolean;
  emergencyStop: boolean;
  autonomyMode: AutonomyMode;
  lastCycleAt: string | null;
  lastCycleResult: string | null;
  cycleCount: number;
}

export interface BudgetReport {
  day: { llmRequests: number; llmTokens: number; webRequests: number; rpcRequests: number; executionTimeMs: number };
  hour: { llmRequests: number; llmTokens: number; webRequests: number; rpcRequests: number; executionTimeMs: number };
  limits: { dailyLlmTokens: number; hourlyLlmTokens: number; perTaskLlmTokens: number };
}

// ---------------------------------------------------------------------------
// Earnings ledger (spec §14)
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  id: string;
  opportunityId?: string;
  source: string;
  category: string;
  grossUsd: number;
  feesUsd: number;
  expensesUsd: number;
  netUsd: number;
  hoursSpent: number;
  hourlyReturn: number;
  currency: string;
  verified: boolean;
  expected: boolean;
  transactionHash?: string;
  chain?: string;
  strategy?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Agent events (spec §17)
// ---------------------------------------------------------------------------

export type EventLevel = "debug" | "info" | "warn" | "error" | "critical";

export interface AgentEventLog {
  id: string;
  taskId?: string;
  opportunityId?: string;
  agent: AgentName;
  level: EventLevel;
  event: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
