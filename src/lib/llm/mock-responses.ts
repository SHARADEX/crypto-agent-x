// Canned LLM responses for mock-mode integration tests + the mock simulation
// script. When `process.env.MOCK_MODE === "true"`, the specialist agents call
// `getMockResponse(agent, taskType)` instead of `callLLM` so the test suite +
// CI never burn real LLM tokens.
//
// Every response here is DETERMINISTIC — the same `agent` + `taskType` always
// returns the same canned string. The agents consume these strings exactly
// as they would a real LLM response (running them through `validateJSON` etc.).
//
// Adding a new canned response:
//   1. Add an entry to MOCK_RESPONSES keyed by `${agent}:${taskType}`.
//   2. Make sure the JSON shape matches what the agent's parser expects.
//   3. Re-run `bun run agent:simulate` — it must produce the same final
//      state every time (determinism check).

/**
 * The canonical mapping of `${agent}:${taskType}` → canned LLM response.
 *
 * `taskType` is the value the agent passes to `callLLM({ taskType })` —
 * e.g. `"research"`, `"coding"`, `"review"`, `"writing"`. The `agent`
 * discriminator lets us return a different canned response for the SAME
 * taskType when called by different specialist agents (e.g. coding-agent
 * vs review-agent both ask for JSON, but the shapes differ).
 */
const MOCK_RESPONSES: Record<string, string> = {
  // --- Research Agent ---------------------------------------------------
  "research:research": JSON.stringify({
    requirements_summary:
      "Implement a new GraphQL resolver for profile metadata; must cover EIP-712 typed-data fields.",
    eligibility_assessment: "Open to all contributors; KYC required for payouts over $500.",
    competition_level: 4,
    estimated_hours_realistic: 14,
    dependencies: ["@lens-protocol/sdk", "graphql"],
    evidence_quality: 8,
    notes: [
      "Repo is public on GitHub (verified host).",
      "Issue body explicitly lists deliverables + tests + CHANGELOG entry.",
      "Payment in USDC on Polygon (reliable, fast-finality).",
    ],
    web_research_summary:
      "Fetched the GitHub issue page and the Lens Protocol SDK README — both corroborate the bounty's scope and reward.",
    citations: [
      "https://github.com/lens-protocol/lens-sdk/issues/412",
      "https://docs.lens.xyz",
    ],
  }),

  // --- Coding Agent -----------------------------------------------------
  "coding:coding": JSON.stringify({
    approach:
      "Extend the profile-metadata resolver to read the new EIP-712 typed-data fields from the profile struct. Add a new `ProfileMetadataV2` type with backwards-compat optional fields. Update the GraphQL schema and add unit tests + an integration test.",
    files: [
      {
        path: "src/resolvers/profile-metadata.ts",
        language: "typescript",
        content:
          "import { Profile, ProfileMetadataV2 } from '../types';\n" +
          "export function resolveProfileMetadata(profile: Profile): ProfileMetadataV2 {\n" +
          "  return {\n" +
          "    ...profile.metadata,\n" +
          "    eip712TypedData: profile.eip712TypedData ?? null,\n" +
          "  };\n" +
          "}\n",
      },
    ],
    tests: [
      {
        path: "tests/profile-metadata.test.ts",
        framework: "bun:test",
        content:
          "import { describe, it, expect } from 'bun:test';\n" +
          "import { resolveProfileMetadata } from '../src/resolvers/profile-metadata';\n" +
          "describe('resolveProfileMetadata', () => {\n" +
          "  it('returns V2 with typed data when present', () => {\n" +
          "    const r = resolveProfileMetadata({ metadata: {}, eip712TypedData: { x: 1 } });\n" +
          "    expect(r.eip712TypedData).toEqual({ x: 1 });\n" +
          "  });\n" +
          "});\n",
      },
    ],
    dependencies: [],
    estimated_hours: 12,
  }),

  // --- Review Agent -----------------------------------------------------
  "review:review": JSON.stringify({
    verdict: "accept",
    qualityScore: 8,
    issues: [
      {
        severity: "info",
        detail: "Implementation matches the issue spec; tests cover the happy path.",
      },
    ],
    summary:
      "Solution satisfies the requirements: resolver reads the new EIP-712 fields, tests pass, backwards compatibility preserved via optional fields.",
    reviewer_different_from_executor: true,
  }),

  // --- Writing Agent ----------------------------------------------------
  "writing:writing": JSON.stringify({
    title: "OnlyDust Contributor Onboarding Guide",
    format: "markdown",
    content:
      "# OnlyDust Contributor Onboarding Guide\n\n## 1. Setup\n...\n## 2. Common Patterns\n...\n## 3. Glossary\n...\n",
    word_count: 3450,
    meets_requirements: true,
    notes: [
      "Word count 3450 — within the 3000-5000 word target.",
      "Includes 3 Mermaid diagrams.",
      "CC-BY licence noted in the footer.",
    ],
  }),

  // --- Task Classifier (LEVEL 2 LLM classifier) -------------------------
  "task_classifier:task_classifier": JSON.stringify({
    task_type: "coding_bounty",
    domain: "typescript",
    complexity: "medium",
    required_capabilities: ["coding", "tool_use"],
    web_access_required: false,
    coding_required: true,
    security_required: false,
    tool_use_required: false,
    output_format: "code",
    risk_level: "low",
  }),

  // --- Web3 Agent (solidity audit shape — used by mock simulation) ------
  "web3:web3": JSON.stringify({
    audit_findings: [],
    risk_score: 5,
    summary: "Contract uses standard OpenZeppelin SafeERC20 wrappers — no drainer primitives.",
    recommendation: "proceed",
  }),

  // --- Default fallback -------------------------------------------------
  "default:default": JSON.stringify({
    summary: "Mock LLM response — no real inference performed.",
    ok: true,
  }),
};

/**
 * Return the canned LLM response for the given agent + taskType. When the
 * exact key isn't found, falls back to `"default:default"`. When even that
 * isn't found, returns the empty string (the agent's parser will then
 * fall back to its deterministic heuristic, per the spec §29 failure path).
 *
 * @param agent   one of "research" | "coding" | "review" | "writing" |
 *                "task_classifier" | "web3" | "default"
 * @param taskType the taskType string the agent would pass to callLLM
 */
export function getMockResponse(
  agent: string,
  taskType: string
): string {
  const key = `${agent}:${taskType}`;
  return (
    MOCK_RESPONSES[key] ??
    MOCK_RESPONSES[`${agent}:default`] ??
    MOCK_RESPONSES["default:default"] ??
    ""
  );
}

/**
 * True iff the operator has enabled mock mode by setting
 * `process.env.MOCK_MODE === "true"`. The specialist agents call this at the
 * top of their `execute()` functions to decide whether to call `callLLM`
 * (real provider dispatch) or `getMockResponse` (canned string).
 */
export function isMockMode(): boolean {
  return (process.env.MOCK_MODE ?? "").toLowerCase() === "true";
}

/**
 * Re-export the canned-response table for tests that want to assert on the
 * exact shape of a particular response (e.g. the mock simulation asserts the
 * coding-agent response parses to a JSON outline with `files.length >= 1`).
 */
export const MOCK_RESPONSE_TABLE = MOCK_RESPONSES;
