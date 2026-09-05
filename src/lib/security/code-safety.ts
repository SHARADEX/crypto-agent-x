// Generated-code safety inspector (spec §32).
//
// The Coding Agent (spec §4B) emits source code: TypeScript utilities, Solidity
// contracts, shell scripts, Python helpers, etc. Before that code is allowed
// to run inside the agent's runtime (or be submitted to a bounty program), it
// is run through this inspector.
//
// The inspector scans the generated text against a fixed catalog of dangerous
// patterns. Each match produces a {@link CodeFinding} with severity
// `critical` / `warn` / `info`. The cumulative `riskScore` is the sum of
// per-finding weights:
//
//   critical → +30
//   warn     → +10
//   info     → +2
//
// `safe = riskScore < 50`.
//
// The inspector is intentionally conservative — it errs on the side of false
// positives. The Coding Agent can include `// safe: legitimate use of …`
// annotations in its output, but those do NOT silence findings: every
// finding is still surfaced so a human reviewer can see them. (We do NOT
// implement comment-based suppressions because they are themselves a
// prompt-injection vector — an attacker could inject `// safe: …` in
// external content the Coding Agent reads.)
//
// Pure, deterministic, never throws.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CodeFinding {
  /** Stable identifier (e.g. `eval_call`). */
  id: string;
  /** Human-readable explanation of what was matched and why it matters. */
  detail: string;
  /** Critical findings dominate the riskScore; info findings are advisory. */
  severity: "critical" | "warn" | "info";
  /** Zero-based offset in the source where the pattern matched. -1 when
   *  the finding is contextual (e.g. "this is Solidity") rather than a
   *  specific match. */
  offset: number;
}

export interface CodeInspectionResult {
  /** True iff `riskScore < SAFE_THRESHOLD`. */
  safe: boolean;
  /** 0..100, clamped. */
  riskScore: number;
  /** Every finding, in the order they were detected. */
  findings: CodeFinding[];
}

// ---------------------------------------------------------------------------
// Thresholds + weights
// ---------------------------------------------------------------------------

export const SAFE_THRESHOLD = 50;

const CRITICAL_WEIGHT = 30;
const WARN_WEIGHT = 10;
const INFO_WEIGHT = 2;

// ---------------------------------------------------------------------------
// Pattern catalog
// ---------------------------------------------------------------------------

interface CodePattern {
  id: string;
  detail: string;
  severity: "critical" | "warn" | "info";
  regex: RegExp;
}

/**
 * Patterns that apply to ALL languages. These are the "shell-injection"
 * primitives and language-agnostic obfuscation markers. They are evaluated
 * against the raw source text.
 */
const UNIVERSAL_PATTERNS: CodePattern[] = [
  {
    id: "eval_call",
    detail:
      "`eval(` — JavaScript code-execution primitive. Almost always a security bug; never emit on external request.",
    severity: "critical",
    regex: /\beval\s*\(/g,
  },
  {
    id: "function_constructor",
    detail:
      "`new Function(` / `Function(` — equivalent to `eval`; compiles a string into an executable function.",
    severity: "critical",
    regex: /\bnew\s+Function\s*\(|\bFunction\s*\(/g,
  },
  {
    id: "rm_rf",
    detail:
      "`rm -rf` — destructive shell command. Never emit in generated code without explicit human approval.",
    severity: "critical",
    regex: /\brm\s+-rf\b/g,
  },
  {
    id: "del_force",
    detail:
      "`del /f` — Windows destructive shell command. Equivalent of `rm -rf`.",
    severity: "critical",
    regex: /\bdel\s+\/[fqs]/gi,
  },
  {
    id: "sudo",
    detail:
      "`sudo` — privilege escalation. Generated code should never require root.",
    severity: "warn",
    regex: /\bsudo\b/g,
  },
  {
    id: "long_base64_blob",
    detail:
      "Long base64 string (>200 chars) — possible obfuscated payload or hardcoded secret. Review before allowing.",
    severity: "warn",
    regex: /[A-Za-z0-9+/]{200,}={0,2}/g,
  },
  {
    id: "long_hex_blob",
    detail:
      "Long hex string (>200 chars) — possible obfuscated payload or hardcoded key material.",
    severity: "warn",
    regex: /\b[0-9a-fA-F]{200,}\b/g,
  },
];

/**
 * Patterns that apply to JavaScript / TypeScript / Node sources.
 */
const JS_PATTERNS: CodePattern[] = [
  {
    id: "child_process",
    detail:
      "`child_process` import — process spawning. High risk: a hostile bounty description could trick the Coding Agent into spawning shell commands.",
    severity: "critical",
    regex: /require\s*\(\s*["']child_process["']\)|import\s+["']child_process["']/g,
  },
  {
    id: "exec_sync",
    detail:
      "`execSync` — synchronous shell-out. Almost always avoidable in generated code.",
    severity: "critical",
    regex: /\bexecSync\s*\(/g,
  },
  {
    id: "spawn",
    detail:
      "`spawn(` / `exec(` — process spawning primitives from `child_process`.",
    severity: "critical",
    regex: /\b(spawn|exec|fork)\s*\(/g,
  },
  {
    id: "fs_write_system_path",
    detail:
      "`fs.writeFile` / `fs.writeFileSync` to a system path (/etc/, /usr/, ~/.ssh) — tampering with system files.",
    severity: "critical",
    regex:
      /fs\.(writeFile|writeFileSync|appendFile|appendFileSync)\s*\([^)]*(\/etc\/|\/usr\/|\/boot\/|~\/\.ssh)/g,
  },
  {
    id: "process_env_read",
    detail:
      "`process.env` read — extracting environment variables. Often used by exfiltration payloads to dump API keys / tokens.",
    severity: "warn",
    regex: /\bprocess\.env\b/g,
  },
  {
    id: "crypto_private_key_op",
    detail:
      "`require('crypto')` followed by createPrivateKey / sign — manipulation of private key material. Review carefully.",
    severity: "warn",
    regex:
      /require\s*\(\s*["']crypto["']\s*\)|import\s+["']crypto["']|createPrivateKey|createSign\s*\(/g,
  },
  {
    id: "fetch_to_external",
    detail:
      "`fetch(` to an external URL — possible exfiltration endpoint. Review the destination before allowing.",
    severity: "warn",
    regex: /\bfetch\s*\(\s*["']https?:\/\//g,
  },
  {
    id: "dynamic_import_child_process",
    detail:
      "Dynamic `import(\"child_process\")` — circumvents static analyzers and linters.",
    severity: "critical",
    regex: /import\s*\(\s*["']child_process["']\s*\)/g,
  },
  {
    id: "hardcoded_private_key",
    detail:
      "Hardcoded private key literal (looks like a hex/base64 key with the variable named `*_key`, `private_key`, `mnemonic`, etc.). NEVER hardcode keys.",
    severity: "critical",
    regex:
      /\b(private_?key|priv_?key|secret_?key|mnemonic|seed_?phrase)\s*[:=]\s*["'][0-9a-fA-Fx]{40,}["']/gi,
  },
  {
    id: "hardcoded_api_key",
    detail:
      "Hardcoded API key literal (variable named `api_key`, `access_token`, `bearer`). Should come from env / secret manager, not source.",
    severity: "warn",
    regex:
      /\b(api_?key|access_?token|bearer|auth_?token)\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}["']/gi,
  },
];

/**
 * Patterns specific to Solidity smart-contract code. Wallet-draining
 * primitives (transfer, sendTransaction, approve, setApprovalForAll) are
 * suspicious in CONTRACT code because they are the canonical rug-pull /
 * wallet-drainer calls. They are NOT flagged when emitted by the Web3 Agent
 * in scripts that legitimately interact with the agent's own wallets.
 */
const SOLIDITY_PATTERNS: CodePattern[] = [
  {
    id: "sol_transfer_external",
    detail:
      "Solidity `transfer(` to an attacker-controlled address — drains contract balance. Generated contract code should never emit a transfer to a hardcoded external address.",
    severity: "critical",
    regex:
      /\.transfer\s*\(\s*(0x[0-9a-fA-F]{40}|msg\.sender)/g,
  },
  {
    id: "sol_send_transaction",
    detail:
      "Solidity `send(` / `call{value:}` — token movement. Review recipient carefully.",
    severity: "warn",
    regex: /\.send\s*\(\s*\)|\.call\s*\(\s*\{[^}]*value\s*:/g,
  },
  {
    id: "sol_approve_max",
    detail:
      "Solidity `approve(type(uint256).max)` — unlimited allowance. Wallet-drainer signature.",
    severity: "critical",
    regex:
      /\.approve\s*\(\s*[^,]+,\s*(type\(uint256\)\.max|2\^?\s*256\s*-\s*1|0xf{64})/gi,
  },
  {
    id: "sol_set_approval_for_all",
    detail:
      "Solidity `setApprovalForAll(…, true)` — grants unlimited NFT spending permission. Classic wallet-drainer.",
    severity: "critical",
    regex: /\.setApprovalForAll\s*\(\s*[^,]+,\s*true\s*\)/gi,
  },
  {
    id: "sol_delegate_call",
    detail:
      "Solidity `delegatecall` to an external address — runs attacker code in the contract's storage context. Almost always malicious.",
    severity: "critical",
    regex: /\.delegatecall\s*\(/g,
  },
  {
    id: "sol_selfdestruct",
    detail:
      "Solidity `selfdestruct` — destroys the contract and sends balance to a recipient. Removed in newer Solidity but still flagged when seen.",
    severity: "critical",
    regex: /\bselfdestruct\s*\(/g,
  },
];

/**
 * Patterns specific to Python sources.
 */
const PYTHON_PATTERNS: CodePattern[] = [
  {
    id: "py_os_system",
    detail:
      "Python `os.system(` / `subprocess.call(…, shell=True)` — shell-out with attacker-controllable input.",
    severity: "critical",
    regex:
      /\bos\.system\s*\(|subprocess\.(call|run|Popen)\s*\([^)]*shell\s*=\s*True/g,
  },
  {
    id: "py_eval",
    detail:
      "Python `eval(` / `exec(` — code execution from string. Never safe in generated code.",
    severity: "critical",
    regex: /\beval\s*\(|\bexec\s*\(/g,
  },
  {
    id: "py_pickle_load",
    detail:
      "Python `pickle.load(` — deserialisation RCE primitive. Reject unless explicitly expected.",
    severity: "warn",
    regex: /\bpickle\.loads?\s*\(/g,
  },
];

/**
 * Shell-script patterns.
 */
const SHELL_PATTERNS: CodePattern[] = [
  {
    id: "shell_curl_pipe_bash",
    detail:
      "Shell `curl … | bash` / `wget … | sh` — remote code execution pattern. Never safe to emit in generated code.",
    severity: "critical",
    regex: /\b(curl|wget)\b[^|]*\|\s*(bash|sh|zsh|fish)\b/g,
  },
  {
    id: "shell_chmod_exec",
    detail:
      "Shell `chmod 777` — world-writable + executable. Should be more restrictive.",
    severity: "warn",
    regex: /\bchmod\s+777\b/g,
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect a piece of generated code against the dangerous-pattern catalog.
 *
 * @param code     the raw source code text
 * @param language one of `typescript`, `javascript`, `tsx`, `jsx`, `node`,
 *                 `solidity`, `python`, `shell`, `bash`, `sh`, or `*` to
 *                 run only the universal checks
 * @returns        a {@link CodeInspectionResult}; never throws
 */
export function inspectGeneratedCode(
  code: string,
  language: string
): CodeInspectionResult {
  const text = typeof code === "string" ? code : String(code ?? "");
  const lang = (language ?? "").toLowerCase();

  const patterns: CodePattern[] = [...UNIVERSAL_PATTERNS];
  if (
    lang === "typescript" ||
    lang === "tsx" ||
    lang === "javascript" ||
    lang === "jsx" ||
    lang === "node" ||
    lang === "js" ||
    lang === "ts"
  ) {
    patterns.push(...JS_PATTERNS);
  }
  if (lang === "solidity" || lang === "sol") {
    patterns.push(...SOLIDITY_PATTERNS);
  }
  if (lang === "python" || lang === "py") {
    patterns.push(...PYTHON_PATTERNS);
  }
  if (lang === "shell" || lang === "bash" || lang === "sh") {
    patterns.push(...SHELL_PATTERNS);
  }
  // Always include shell + python patterns at lower weight? No — running
  // shell patterns against TypeScript produces false positives like `exec(`
  // matching `execute(`. So we only run the patterns for the declared
  // language + the universal catalog.

  const findings: CodeFinding[] = [];
  for (const pattern of patterns) {
    // Reset lastIndex because the regex is /g-flagged and reused.
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      findings.push({
        id: pattern.id,
        detail: pattern.detail,
        severity: pattern.severity,
        offset: match.index,
      });
      // Guard against zero-length matches (would otherwise loop forever).
      if (match.index === pattern.regex.lastIndex) {
        pattern.regex.lastIndex++;
      }
      // One finding per pattern is enough — additional matches of the same
      // pattern just add noise to the report.
      break;
    }
  }

  let riskScore = 0;
  for (const f of findings) {
    riskScore +=
      f.severity === "critical"
        ? CRITICAL_WEIGHT
        : f.severity === "warn"
        ? WARN_WEIGHT
        : INFO_WEIGHT;
  }
  riskScore = clamp(riskScore, 0, 100);

  return {
    safe: riskScore < SAFE_THRESHOLD,
    riskScore,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}
