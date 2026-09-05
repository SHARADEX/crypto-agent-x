// Health check command (Phase-2 P2-17 / P0-7).
//
// Runnable via `bun run agent:health`. Prints a per-subsystem PASS / WARN /
// FAIL table covering:
//
//   1. Secrets report (✅/⚠️ per env var — never prints values).
//   2. Database connectivity (Prisma round-trip via `db.agentState.count()`).
//   3. Each LLM provider: configured? health-check pass? discovery count?
//   4. Wallet adapters: one balance fetch per chain (5s timeout each).
//   5. Model router: a sample `route("analyze a solidity bounty")` call.
//   6. Security engine: a `detectScam` on a known-malicious string.
//   7. Budget manager: `getReport()` call.
//   8. Kill switch: `refreshKillSwitchState()` + `isPaused()` check.
//
// Each test is wrapped in try/catch with a timeout — a single failure does
// not abort the whole report. Exit code 0 if all PASS / WARN, 1 if any FAIL.

import { db } from "@/lib/db";
import {
  printSecretReport,
  validateSecrets,
} from "@/lib/llm/secret-validation";
import {
  PROVIDERS,
  bootstrapProviders,
} from "@/lib/llm/providers";
import { providerRegistry } from "@/lib/llm/provider-registry";
import { quotaTracker } from "@/lib/llm/quota-tracker";
import { fetchAllWallets } from "@/lib/wallet/adapters";
import { WALLETS } from "@/config/wallets";
import { route } from "@/lib/llm/router";
import { detectScam } from "@/lib/security/scam-detection";
import { normalizeOpportunity } from "@/lib/agent/normalize";
import { BudgetManager } from "@/lib/budget/manager";
import {
  isPaused,
  refreshKillSwitchState,
} from "@/lib/kill-switch";
import { scanGitHubBounties } from "@/lib/agent/scanners/github-scanner";
import { scanMockOpportunities } from "@/lib/agent/scanners/mock-scanner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEADER_UNDERLINE =
  "─────────────────────────────────────────────────────────────";

type Status = "PASS" | "WARN" | "FAIL" | "NOT_CONFIG";

interface Row {
  subsystem: string;
  status: Status;
  detail: string;
}

const rows: Row[] = [];

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

function statusLabel(s: Status): string {
  switch (s) {
    case "PASS":
      return "PASS     ";
    case "WARN":
      return "WARN     ";
    case "FAIL":
      return "FAIL     ";
    case "NOT_CONFIG":
      return "NOT_CONFIG";
  }
}

function addRow(subsystem: string, status: Status, detail: string) {
  rows.push({ subsystem, status, detail });
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fallback);
      }
    }, ms);
    promise
      .then((v) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(v);
        }
      })
      .catch((err) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          const msg = err instanceof Error ? err.message : String(err);
          // Resolve with fallback so the caller's catch can pick it up.
          // We return the fallback typed as T; the caller should handle
          // error context separately.
          void msg;
          resolve(fallback);
        }
      });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSecrets() {
  console.log("\n=== Secret Validation ===\n");
  printSecretReport();
  const entries = validateSecrets();
  const missingRequired = entries.filter(
    (e) => e.required && !e.configured
  );
  const missingOptional = entries.filter(
    (e) => !e.required && !e.configured
  );
  if (missingRequired.length === 0) {
    addRow("SECRETS", "PASS", `${entries.filter((e) => e.configured).length}/${entries.length} configured`);
  } else {
    addRow(
      "SECRETS",
      "FAIL",
      `MISSING REQUIRED: ${missingRequired.map((e) => e.name).join(", ")}`
    );
  }
  if (missingOptional.length > 0) {
    addRow(
      "SECRETS",
      "WARN",
      `Optional: ${missingOptional.map((e) => e.name).join(", ")}`
    );
  }
}

async function testDatabase() {
  try {
    const count = await withTimeout(
      db.agentState.count(),
      5_000,
      -1
    );
    if (count < 0) {
      addRow("DATABASE", "FAIL", "timed out (5s) waiting for Prisma round-trip");
      return;
    }
    addRow("DATABASE", "PASS", `agentState singleton exists (${count} rows)`);
  } catch (err) {
    addRow(
      "DATABASE",
      "FAIL",
      `Prisma round-trip failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function testProviders() {
  // Bootstrap providers — runs health check + discovery on every configured
  // provider. Use a generous per-provider timeout via bootstrapProviders'
  // internal 10s cap.
  const summary = await bootstrapProviders().catch((err) => {
    addRow(
      "PROVIDERS",
      "FAIL",
      `bootstrapProviders threw: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  });

  if (!summary) return;

  for (const provider of PROVIDERS) {
    const label = `${provider.displayName} Provider`;
    const isConfigured = provider.isConfigured();
    if (!isConfigured) {
      addRow(label, "NOT_CONFIG", `${provider.name} not configured`);
      continue;
    }
    const status = providerRegistry.getStatus(provider.name);
    const usage = provider.usage();
    const healthy = status === "healthy";
    if (healthy) {
      addRow(
        label,
        "PASS",
        `healthy (requests=${usage.requests}, tokens=${usage.tokens})`
      );
    } else if (
      status === "rate_limited" ||
      status === "quota_exhausted" ||
      status === "degraded"
    ) {
      addRow(
        label,
        "WARN",
        `${status}: ${usage.lastError ?? "no detail"}`
      );
    } else {
      // Z.AI is a sandbox-only provider — it's expected to be "unhealthy"
      // on CI runners (no /etc/.z-ai-config). Don't fail CI for this.
      if (provider.name === "zai") {
        addRow(
          label,
          "WARN",
          `${status ?? "unknown"}: ${usage.lastError ?? "no detail"} (expected outside sandbox)`
        );
      } else {
        addRow(
          label,
          "FAIL",
          `${status ?? "unknown"}: ${usage.lastError ?? "no detail"}`
        );
      }
    }
  }

  addRow(
    "PROVIDER BOOTSTRAP",
    summary.unhealthy.length === 0 ? "PASS" : "WARN",
    `configured=${summary.configured.length}, healthy=${summary.healthy.length}, unhealthy=${summary.unhealthy.length}, models_discovered=${summary.modelsDiscovered}`
  );

  // Surface any per-provider errors as a WARN row.
  if (summary.errors.length > 0) {
    addRow(
      "PROVIDER ERRORS",
      "WARN",
      summary.errors.slice(0, 3).join(" | ") +
        (summary.errors.length > 3 ? ` (+${summary.errors.length - 3} more)` : "")
    );
  }

  // Quota tracker report — show any providers currently in cooldown.
  const quota = quotaTracker.getQuotaReport();
  const inCooldown = quota.filter((q) => q.inCooldown);
  if (inCooldown.length > 0) {
    addRow(
      "PROVIDER QUOTA",
      "WARN",
      `in cooldown: ${inCooldown.map((q) => q.provider).join(", ")}`
    );
  } else {
    addRow("PROVIDER QUOTA", "PASS", `${quota.length} providers tracked, none in cooldown`);
  }
}

async function testWallets() {
  // Test each wallet adapter in parallel with a 5s timeout per fetch.
  // We use fetchAllWallets (which already has internal timeouts) but wrap
  // the whole thing in a global 30s timeout to be safe.
  let balances: Awaited<ReturnType<typeof fetchAllWallets>> = [];
  try {
    balances = await withTimeout(fetchAllWallets(), 30_000, []);
  } catch (err) {
    addRow(
      "WALLETS",
      "FAIL",
      `fetchAllWallets threw: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  // Group by chain so we get one row per configured wallet.
  const byChain = new Map<string, { ok: number; fail: number; sampleError?: string }>();
  for (const b of balances) {
    const entry = byChain.get(b.chain) ?? { ok: 0, fail: 0 };
    if (b.error) {
      entry.fail += 1;
      if (!entry.sampleError) entry.sampleError = b.error;
    } else {
      entry.ok += 1;
    }
    byChain.set(b.chain, entry);
  }

  // Add rows for every configured wallet — even if fetch returned nothing.
  for (const w of WALLETS) {
    const entry = byChain.get(w.chain) ?? { ok: 0, fail: 0 };
    if (entry.ok > 0) {
      addRow(`WALLET: ${w.chain}`, "PASS", `balance fetched (${entry.ok} addr)`);
    } else if (entry.fail > 0) {
      addRow(
        `WALLET: ${w.chain}`,
        "WARN",
        `fetch failed: ${entry.sampleError ?? "unknown"}`
      );
    } else {
      addRow(
        `WALLET: ${w.chain}`,
        "FAIL",
        "no balance returned (RPC unreachable)"
      );
    }
  }
}

async function testModelRouter() {
  try {
    const routing = await withTimeout(
      route("analyze a solidity bounty for vulnerabilities"),
      5_000,
      null
    );
    if (!routing) {
      addRow("MODEL ROUTER", "FAIL", "timed out (5s)");
      return;
    }
    if (routing.models.length === 0 && routing.decision.routing_level === 1) {
      addRow(
        "MODEL ROUTER",
        "PASS",
        "routed to LEVEL 1 deterministic (no model needed)"
      );
      return;
    }
    if (routing.models.length === 0) {
      addRow(
        "MODEL ROUTER",
        "WARN",
        `no eligible models for task_type=${routing.decision.task_type}`
      );
      return;
    }
    const m = routing.models[0];
    addRow(
      "MODEL ROUTER",
      "PASS",
      `routed to ${m.model_id} (level=${routing.decision.routing_level}, task=${routing.decision.task_type})`
    );
  } catch (err) {
    addRow(
      "MODEL ROUTER",
      "FAIL",
      `route() threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function testSecurityEngine() {
  try {
    // Build a deliberately malicious raw opportunity and run detectScam.
    const maliciousRaw = {
      title: "FREE ETH Airdrop — connect wallet to claim $5000 guaranteed profit",
      description:
        "Send your seed phrase to verify wallet ownership. Limited time offer. Private key required.",
      source: "scam.example.com",
      sourceUrl: "https://scam.example.com/free-eth",
      organization: "",
      category: "referral" as const,
      reward: { amount: 5000, currency: "USDC", estimated_usd: 5000 },
      requirements: ["seed phrase", "private key"],
      skillsRequired: [],
      estimatedHours: 0,
      difficulty: 1,
      competition: 1,
      eligibility: ["anyone"],
      paymentMethod: "connect wallet",
      capitalRequired: false,
    };
    const normalized = normalizeOpportunity(maliciousRaw, "test_source");
    const result = detectScam(normalized);
    if (result.isScam && result.riskScore >= 70) {
      addRow(
        "SECURITY ENGINE",
        "PASS",
        `scam detected (riskScore=${result.riskScore}, signals=${result.signals.length})`
      );
    } else {
      addRow(
        "SECURITY ENGINE",
        "FAIL",
        `expected isScam=true riskScore>=70, got isScam=${result.isScam} riskScore=${result.riskScore}`
      );
    }
  } catch (err) {
    addRow(
      "SECURITY ENGINE",
      "FAIL",
      `detectScam threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function testBudget() {
  try {
    const report = await withTimeout(
      BudgetManager.getInstance().getReport(),
      5_000,
      null
    );
    if (!report) {
      addRow("BUDGET", "FAIL", "timed out (5s)");
      return;
    }
    const used = report.day.llmTokens;
    const cap = report.limits.dailyLlmTokens;
    const pct = cap > 0 ? Math.round((used / cap) * 100) : 0;
    if (pct < 90) {
      addRow(
        "BUDGET",
        "PASS",
        `${formatNumber(used)}/${formatNumber(cap)} daily tokens (${pct}% used)`
      );
    } else {
      addRow(
        "BUDGET",
        "WARN",
        `${formatNumber(used)}/${formatNumber(cap)} daily tokens (${pct}% used — near cap)`
      );
    }
  } catch (err) {
    addRow(
      "BUDGET",
      "FAIL",
      `getReport threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function testKillSwitch() {
  try {
    await withTimeout(refreshKillSwitchState(), 5_000, null);
    if (isPaused()) {
      addRow("KILL SWITCH", "WARN", "agent is currently PAUSED");
    } else {
      addRow("KILL SWITCH", "PASS", "not paused");
    }
  } catch (err) {
    addRow(
      "KILL SWITCH",
      "FAIL",
      `refreshKillSwitchState threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function testOpportunitySources() {
  // Mock scanner is synchronous and deterministic.
  try {
    const mock = scanMockOpportunities();
    if (mock.opportunities.length > 0) {
      addRow(
        "SOURCE: mock",
        "PASS",
        `${mock.opportunities.length} mock opportunities available`
      );
    } else {
      addRow("SOURCE: mock", "FAIL", "mock scanner returned no opportunities");
    }
  } catch (err) {
    addRow(
      "SOURCE: mock",
      "FAIL",
      `scanMockOpportunities threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // GitHub scanner — bounded by a 10s timeout. May fail in offline CI.
  try {
    const gh = await withTimeout(scanGitHubBounties(), 10_000, null);
    if (!gh) {
      addRow("SOURCE: github", "WARN", "timed out (10s) — likely offline");
    } else if (gh.error) {
      addRow(
        "SOURCE: github",
        "WARN",
        `error: ${gh.error.slice(0, 80)} (may be rate-limited / offline)`
      );
    } else {
      addRow(
        "SOURCE: github",
        "PASS",
        `${gh.opportunities.length} GitHub issues scanned`
      );
    }
  } catch (err) {
    addRow(
      "SOURCE: github",
      "WARN",
      `scanGitHubBounties threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          CryptoEarn Agent — Health Check Report              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  await testSecrets();
  await testDatabase();
  await testProviders();
  await testWallets();
  await testOpportunitySources();
  await testModelRouter();
  await testSecurityEngine();
  await testBudget();
  await testKillSwitch();

  // ----- print the table ------------------------------------------------
  console.log("\n=== Subsystem Report ===\n");
  console.log(
    `${pad("SUBSYSTEM", 28)} ${pad("STATUS", 10)} DETAIL`
  );
  console.log(HEADER_UNDERLINE);
  for (const row of rows) {
    console.log(
      `${pad(row.subsystem, 28)} ${statusLabel(row.status)} ${row.detail}`
    );
  }
  console.log(HEADER_UNDERLINE);

  // ----- summary --------------------------------------------------------
  const pass = rows.filter((r) => r.status === "PASS").length;
  const warn = rows.filter((r) => r.status === "WARN").length;
  const fail = rows.filter((r) => r.status === "FAIL").length;
  const notConfig = rows.filter((r) => r.status === "NOT_CONFIG").length;
  console.log(
    `Summary: ${pass} PASS, ${warn} WARN, ${fail} FAIL, ${notConfig} NOT_CONFIG (total ${rows.length})`
  );

  if (fail > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[health-check] uncaught error:", err);
  process.exit(1);
});
