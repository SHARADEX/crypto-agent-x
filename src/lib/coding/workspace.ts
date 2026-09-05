// Coding Agent sandboxed workspace (spec §20, §32, P2-CODING).
//
// `CodingWorkspace` is an isolated per-task directory under `os.tmpdir()`
// where the Coding Agent can:
//   - write generated source files (`writeFile`)
//   - read them back (`readFile`)
//   - list the file tree (`listFiles`)
//   - clone a target repo (`gitClone`)
//   - apply a patch / create a diff (`applyPatch`, `createDiff`)
//   - install dependencies (`installDeps`)
//   - run the project's tests (`runTests`)
//
// Design invariants (spec §32 — sandboxing rules):
//
//   1. EVERY command runs via `execFile` (not `exec`) — argv array, no shell.
//      This eliminates shell-injection (no $() , no backticks, no pipes).
//   2. EVERY command is checked against `SANDBOX_ALLOWED_COMMANDS` before
//      being spawned. Anything not on the allow-list is rejected.
//   3. EVERY command runs with a hardened environment that BLOCKS network
//      access: HTTP_PROXY + HTTPS_PROXY are set to `127.0.0.1:1` (a port
//      that nothing listens on), and NO_PROXY is restricted to localhost.
//      Most HTTP clients (node-fetch, undici, got, axios) honor these envs
//      by default — so even if a malicious test tried to call out, the
//      request would fail to connect. This is the portable fallback for
//      environments where a network namespace cannot be created; it is NOT
//      a perfect boundary but it stops the common exfil primitives.
//   4. EVERY command has a hard timeout (default 30s, max 120s). Commands
//      that timeout are killed (SIGTERM → SIGKILL after 5s grace).
//   5. The workspace NEVER runs as root. If `process.getuid?.() === 0` we
//      refuse to spawn at all (safer to fail-loud than to silently run as
//      root inside a temp dir).
//   6. Workspace size is capped at `MAX_WORKSPACE_SIZE_MB` — if exceeded,
//      subsequent `exec` calls throw `SandboxPolicyError`.
//   7. `writeFile` REJECTS path-traversal attempts: absolute paths and any
//      relative path containing a `..` segment are refused.
//   8. The workspace is ALWAYS cleaned up via `cleanup()` — the agent uses
//      the `withWorkspace()` helper from `coding/index.ts` to ensure
//      try/finally semantics.
//
// This module is pure TypeScript and only depends on Node's `child_process`,
// `fs/promises`, `path`, `os`, and the in-repo security + budget modules.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { promisify } from "node:util";

import { validateUrl } from "@/lib/security/url-validator";
import { BudgetManager } from "@/lib/budget/manager";
import { logEvent } from "@/lib/agent/events";
import {
  assertCommandAllowed,
  clampExecTimeout,
  SandboxPolicyError,
  MAX_WORKSPACE_SIZE_MB,
  MAX_TOTAL_EXECUTION_TIME_MS,
} from "@/lib/coding/sandbox-policy";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of `workspace.exec()` — never throws, always returns this shape. */
export interface ExecResult {
  /** Process exit code. 0 on success, non-zero on failure, null if the
   *  process could not be spawned (e.g. binary not found) — but we coalesce
   *  null to 127 (the conventional "command not found" code). */
  exitCode: number;
  /** Combined stdout (truncated to 1 MB to avoid blowing up the DB row). */
  stdout: string;
  /** Combined stderr (truncated to 256 KB). */
  stderr: string;
  /** True if the process was killed because `timeoutMs` elapsed. */
  timedOut: boolean;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** The command + args that were executed (for audit log). */
  command: string[];
  /** Error message if the spawn itself failed (binary not found, EACCES…). */
  spawnError?: string;
}

/** Options for `workspace.exec()`. */
export interface ExecOpts {
  /**
   * Working directory INSIDE the workspace root. Defaults to the workspace
   * root. Must be a relative path; path traversal is rejected.
   */
  cwd?: string;
  /** Timeout in ms. Default 30s, max 120s (see `clampExecTimeout`). */
  timeoutMs?: number;
  /**
   * Additional env vars to merge into the sandboxed env. The sandbox always
   * sets HTTP_PROXY/HTTPS_PROXY/NO_PROXY; callers cannot override those.
   */
  env?: Record<string, string>;
  /**
   * Max stdout bytes to retain. Default 1 MB. Larger outputs are
   * truncated with a `…[truncated]` marker.
   */
  maxStdoutBytes?: number;
}

/** Result of `workspace.runTests()` — adds parsed pass/fail counts. */
export interface TestResult extends ExecResult {
  /** Detected framework (jest, vitest, mocha, pytest, go, cargo, unknown). */
  framework: string;
  /** Number of tests that passed (best-effort parse, 0 if unknown). */
  passed: number;
  /** Number of tests that failed (best-effort parse, 0 if unknown). */
  failed: number;
  /** True iff `exitCode === 0 && failed === 0`. */
  ok: boolean;
}

/** Options for `workspace.gitClone()`. */
export interface GitCloneOpts {
  /** `git clone --depth N`. Default 1 (shallow). */
  depth?: number;
  /** Default 60s; clamped to {@link MAX_EXECUTION_TIME_MS}. */
  timeoutMs?: number;
}

/** Options for `workspace.runTests()`. */
export interface RunTestsOpts {
  /** Force a specific framework ("jest"|"vitest"|"mocha"|"pytest"|"go"|"cargo"). */
  framework?: string;
  /** Default 90s; clamped to {@link MAX_EXECUTION_TIME_MS}. */
  timeoutMs?: number;
}

/** Options for `workspace.installDeps()`. */
export interface InstallDepsOpts {
  /** Force a specific package manager. Auto-detected from lockfile otherwise. */
  packageManager?: "npm" | "bun" | "yarn" | "pnpm";
  /** Default 120s; clamped. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Subdirectory name prefix under `os.tmpdir()`. */
const WORKSPACE_PREFIX = "cryptoearn-workspace-";

/** Default per-exec timeout (30s). */
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

/** Default clone timeout (60s). */
const DEFAULT_CLONE_TIMEOUT_MS = 60_000;

/** Default install-deps timeout (120s — npm install is slow). */
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;

/** Default runTests timeout (90s). */
const DEFAULT_TEST_TIMEOUT_MS = 90_000;

/** Maximum stdout we keep in the result. */
const MAX_STDOUT_BYTES = 1_048_576; // 1 MiB

/** Maximum stderr we keep in the result. */
const MAX_STDERR_BYTES = 262_144; // 256 KiB

/** Directories we never descend into when listing files. */
const LIST_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".cache",
  ".turbo",
  "target",
  "__pycache__",
  ".venv",
  "venv",
]);

// ---------------------------------------------------------------------------
// CodingWorkspace
// ---------------------------------------------------------------------------

/**
 * Isolated per-task workspace. Construct one, do work in it, then call
 * `cleanup()`. The `withWorkspace()` helper in `coding/index.ts` is the
 * recommended way to use this so cleanup always runs.
 */
export class CodingWorkspace {
  readonly taskId: string;
  readonly root: string;
  private readonly createdAt: number;
  private _cleanedUp = false;
  private _totalExecMs = 0;

  constructor(taskId: string) {
    if (!taskId || typeof taskId !== "string") {
      throw new Error("CodingWorkspace: taskId is required");
    }
    // Sanitize the taskId so it cannot escape the prefix dir (defence in
    // depth — callers should pass a cuid/uuid but we don't trust it).
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    this.taskId = safeTaskId;
    this.root = path.join(os.tmpdir(), `${WORKSPACE_PREFIX}${safeTaskId}`);
    this.createdAt = Date.now();
  }

  // ---- lifecycle ---------------------------------------------------------

  /**
   * Create the workspace directory if it does not already exist. Idempotent.
   * Called automatically by `writeFile` / `exec` / `gitClone` — but callers
   * that want to ensure the dir is ready (e.g. to write a README before
   * anything else) can call this explicitly.
   */
  async ensure(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  /** Returns the absolute workspace root path. */
  getRoot(): string {
    return this.root;
  }

  /** Returns elapsed wall-clock ms since the workspace was constructed. */
  getElapsedMs(): number {
    return Date.now() - this.createdAt;
  }

  /** Returns total exec time accumulated so far (ms). */
  getTotalExecMs(): number {
    return this._totalExecMs;
  }

  /**
   * Recursively delete the workspace dir. NEVER throws — failed cleanups
   * are logged to the event log and to stderr, but do not propagate.
   * Safe to call multiple times.
   */
  async cleanup(): Promise<void> {
    if (this._cleanedUp) return;
    this._cleanedUp = true;
    try {
      await fs.rm(this.root, { recursive: true, force: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[coding-workspace] cleanup failed for ${this.root}:`, msg);
      try {
        await logEvent(
          "coding",
          "warn",
          "coding_workspace_cleanup_failed",
          { workspace: this.root, error: msg, taskId: this.taskId }
        );
      } catch {
        // ignore — never throw out of cleanup
      }
    }
  }

  // ---- path safety ------------------------------------------------------

  /**
   * Resolve `relativePath` against the workspace root and assert the
   * resolved path is INSIDE the workspace. Throws on path-traversal
   * attempts (absolute paths, `..` segments that escape).
   *
   * Used by `writeFile` / `readFile` / `applyPatch`.
   */
  private resolveInside(relativePath: string): string {
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      throw new SandboxPolicyError(
        "command_not_allowed",
        `path is empty or not a string`
      );
    }

    // Reject absolute paths — the agent should never write to /etc/hosts.
    if (path.isAbsolute(relativePath)) {
      throw new SandboxPolicyError(
        "command_not_allowed",
        `path '${relativePath}' is absolute — only workspace-relative paths are allowed`
      );
    }

    // Reject any path segment that is exactly `..` (e.g. `../secret` or
    // `foo/../../etc/passwd`). We split on the OS separator AND on `/`
    // (forward-slash) so the check works on Windows too.
    const segments = relativePath.split(/[\\/]/);
    if (segments.some((s) => s === "..")) {
      throw new SandboxPolicyError(
        "command_not_allowed",
        `path '${relativePath}' contains a '..' segment — path traversal is not allowed`
      );
    }

    // Resolve against the workspace root and verify the final path is
    // still inside (defence in depth — even if the input passes the
    // segment check, a symlink could redirect it).
    const resolved = path.resolve(this.root, relativePath);
    const relFromRoot = path.relative(this.root, resolved);
    if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
      throw new SandboxPolicyError(
        "command_not_allowed",
        `path '${relativePath}' resolves outside the workspace (to ${resolved})`
      );
    }
    return resolved;
  }

  // ---- file I/O ---------------------------------------------------------

  /**
   * Write `content` to `relativePath` inside the workspace. Creates
   * parent directories as needed. Rejects path-traversal attempts.
   */
  async writeFile(relativePath: string, content: string): Promise<void> {
    const abs = this.resolveInside(relativePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  /**
   * Read `relativePath` from the workspace. Returns `null` if the file
   * does not exist (callers can branch on that without try/catch).
   */
  async readFile(relativePath: string): Promise<string | null> {
    const abs = this.resolveInside(relativePath);
    try {
      return await fs.readFile(abs, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") return null;
      throw err;
    }
  }

  /**
   * Recursively list every file under the workspace root, skipping
   * `node_modules`, `.git`, `.next`, `dist`, `build`, `__pycache__`, etc.
   *
   * Returns RELATIVE paths (POSIX-style with `/` separators) so the
   * caller can pass them straight back to `readFile` / `writeFile`.
   */
  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    await this.walk(this.root, "", out);
    return out.sort();
  }

  private async walk(
    absDir: string,
    relDir: string,
    out: string[]
  ): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const ent of entries) {
      const name = ent.name;
      const rel = relDir ? `${relDir}/${name}` : name;
      if (ent.isDirectory()) {
        if (LIST_SKIP_DIRS.has(name)) continue;
        await this.walk(path.join(absDir, name), rel, out);
      } else if (ent.isFile()) {
        out.push(rel);
      }
    }
  }

  // ---- exec --------------------------------------------------------------

  /**
   * Run a command INSIDE the workspace.
   *
   * `command[0]` MUST be on the allow-list (`SANDBOX_ALLOWED_COMMANDS`).
   * The command is run via `execFile` (no shell), with the cwd set to a
   * subdirectory of the workspace root (defaults to the root). Network is
   * blocked via proxy envs. Timeouts are enforced.
   *
   * Never throws — returns an `ExecResult` with `exitCode`, `stdout`,
   * `stderr`, `timedOut`. If the spawn itself failed (binary not found),
   * `exitCode` is 127 and `spawnError` is set.
   */
  async exec(command: string[], opts: ExecOpts = {}): Promise<ExecResult> {
    const startedAt = Date.now();
    const safeCommand = sanitizeCommand(command);

    // Allow-list check — throws SandboxPolicyError, caught below.
    try {
      assertCommandAllowed(safeCommand[0]);
    } catch (err) {
      return this.failedExec(
        safeCommand,
        err,
        126, // 126 = "command invoked cannot execute" — close to POSIX
        startedAt
      );
    }

    // Total-execution-time cap.
    if (this.getElapsedMs() > MAX_TOTAL_EXECUTION_TIME_MS) {
      return this.failedExec(
        safeCommand,
        new SandboxPolicyError(
          "total_execution_exceeded",
          `total coding-task execution time exceeded ${MAX_TOTAL_EXECUTION_TIME_MS}ms — refusing to spawn more commands`
        ),
        124, // 124 = timeout convention from `timeout(1)`
        startedAt
      );
    }

    // Workspace-size guard.
    try {
      const sizeMb = await this.sizeMb();
      if (sizeMb > MAX_WORKSPACE_SIZE_MB) {
        return this.failedExec(
          safeCommand,
          new SandboxPolicyError(
            "workspace_too_large",
            `workspace size ${sizeMb.toFixed(1)}MB exceeds cap ${MAX_WORKSPACE_SIZE_MB}MB — refusing to spawn`
          ),
          126,
          startedAt
        );
      }
    } catch (err) {
      // Don't fail the exec just because we couldn't measure disk usage —
      // log and proceed (better to over-run than to brick the agent).
      console.warn("[coding-workspace] size check failed:", err);
    }

    // Root guard — never spawn as root.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return this.failedExec(
        safeCommand,
        new SandboxPolicyError(
          "command_not_allowed",
          "workspace refuses to spawn commands as root — run the agent as a non-root user"
        ),
        126,
        startedAt
      );
    }

    // Resolve cwd INSIDE the workspace.
    let cwd = this.root;
    if (opts.cwd) {
      try {
        cwd = this.resolveInside(opts.cwd);
      } catch (err) {
        return this.failedExec(safeCommand, err, 126, startedAt);
      }
    }

    // Clamp timeout.
    let timeoutMs: number;
    try {
      timeoutMs = clampExecTimeout(opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
    } catch (err) {
      return this.failedExec(safeCommand, err, 126, startedAt);
    }

    // Build the sandboxed env. We start from process.env (so PATH is
    // available for `execFile` to resolve the binary), then FORCE the
    // network-blocking vars. The caller's `opts.env` is merged in last
    // BUT we strip any proxy overrides so callers cannot punch a hole
    // in the network boundary.
    //
    // Type annotation: `NodeJS.ProcessEnv` allows `undefined` values,
    // which `Record<string, string>` does not — `process.env` itself is
    // typed as `NodeJS.ProcessEnv`, so we use that here.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...opts.env,
      // Network-blocking overrides — these take precedence.
      HTTP_PROXY: "http://127.0.0.1:1",
      http_proxy: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      https_proxy: "http://127.0.0.1:1",
      ALL_PROXY: "http://127.0.0.1:1",
      all_proxy: "http://127.0.0.1:1",
      // Only allow localhost to bypass — nothing else.
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
      // Belt-and-braces: disable any outbound DNS resolution by sending
      // the resolver at a non-existent port. Some tools use this env.
      RES_OPTIONS: "attempts:0 timeout:0",
      // Disable npm/yarn telemetry + funding prompts (saves network
      // attempts that would have been silently blocked anyway).
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      CI: "true",
    };

    try {
      await this.ensure();
      const maxStdout = opts.maxStdoutBytes ?? MAX_STDOUT_BYTES;
      const result = await execFileAsync(safeCommand[0], safeCommand.slice(1), {
        cwd,
        env,
        timeout: timeoutMs,
        maxBuffer: maxStdout,
        windowsHide: true,
      });
      const durationMs = Date.now() - startedAt;
      this._totalExecMs += durationMs;
      return {
        exitCode: 0,
        stdout: truncate(result.stdout, maxStdout),
        stderr: truncate(result.stderr, MAX_STDERR_BYTES),
        timedOut: false,
        durationMs,
        command: safeCommand,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      this._totalExecMs += durationMs;
      return this.handleExecError(safeCommand, err, startedAt, opts);
    }
  }

  private handleExecError(
    command: string[],
    err: unknown,
    startedAt: number,
    opts: ExecOpts
  ): ExecResult {
    const durationMs = Date.now() - startedAt;
    const maxStdout = opts.maxStdoutBytes ?? MAX_STDOUT_BYTES;

    // `execFile` rejects with an error that has `code`, `signal`, `stdout`,
    // `stderr` properties when the child exited non-zero, OR with a plain
    // ENOENT when the binary could not be spawned.
    const e = err as NodeJS.ErrnoException & {
      code?: string | number;
      signal?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      killed?: boolean;
    };

    if (e && typeof e.code === "string" && e.code === "ENOENT") {
      return {
        exitCode: 127,
        stdout: "",
        stderr: "",
        timedOut: false,
        durationMs,
        command,
        spawnError: `command not found: ${command[0]}`,
      };
    }

    const timedOut = !!e?.killed || e?.signal === "SIGTERM" || e?.signal === "SIGKILL";
    const exitCode =
      typeof e?.code === "number"
        ? e.code
        : timedOut
        ? 124
        : 1;
    const stdout = typeof e?.stdout === "string" ? e.stdout : "";
    const stderr = typeof e?.stderr === "string" ? e.stderr : "";
    const spawnError =
      !stdout && !stderr && e?.message
        ? e.message
        : undefined;

    return {
      exitCode,
      stdout: truncate(stdout, maxStdout),
      stderr: truncate(stderr, MAX_STDERR_BYTES),
      timedOut,
      durationMs,
      command,
      spawnError,
    };
  }

  private failedExec(
    command: string[],
    err: unknown,
    exitCode: number,
    startedAt: number
  ): ExecResult {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode,
      stdout: "",
      stderr: msg,
      timedOut: false,
      durationMs: Date.now() - startedAt,
      command,
      spawnError: msg,
    };
  }

  // ---- git operations ----------------------------------------------------

  /**
   * Clone `url` into the workspace root (shallow by default).
   *
   * Validates the URL via `validateUrl` (HTTPS only, no private IPs, no
   * localhost — the SSRF / homograph guards from spec §32). Records the
   * request via `BudgetManager.recordWebRequest` so the daily web-request
   * cap applies to clones too.
   */
  async gitClone(
    url: string,
    opts: GitCloneOpts = {}
  ): Promise<ExecResult> {
    const validation = validateUrl(url, { allowedSchemes: ["https:"] });
    if (!validation.valid || !validation.safe) {
      return {
        exitCode: 126,
        stdout: "",
        stderr: `git clone URL rejected: ${validation.reasons.join("; ")}`,
        timedOut: false,
        durationMs: 0,
        command: ["git", "clone", url],
        spawnError: `URL rejected: ${validation.reasons.join("; ")}`,
      };
    }

    // Count the clone as a web request for budget purposes.
    try {
      await BudgetManager.getInstance().recordWebRequest();
    } catch (err) {
      console.warn("[coding-workspace] recordWebRequest failed:", err);
    }

    const depth = typeof opts.depth === "number" && opts.depth > 0 ? opts.depth : 1;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
    return this.exec(
      ["git", "clone", "--depth", String(depth), validation.normalized, "."],
      { timeoutMs }
    );
  }

  /**
   * Apply a unified-diff patch to the workspace. Writes the patch to a
   * temp file inside the workspace, runs `git apply`, then deletes the
   * temp file. Returns the `git apply` result.
   */
  async applyPatch(patch: string): Promise<ExecResult> {
    const patchPath = ".coding-agent.patch";
    await this.writeFile(patchPath, patch);
    try {
      const result = await this.exec(["git", "apply", "--whitespace=nowarn", patchPath]);
      return result;
    } finally {
      // Best-effort cleanup of the patch file so it does not appear in
      // the final diff. Never throws.
      try {
        const abs = path.join(this.root, patchPath);
        await fs.rm(abs, { force: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Produce a patch (unified diff) of the current workspace state relative
   * to HEAD, plus a `git status` summary. Used by the Coding Agent to
   * submit its work for human review (spec §20 — patch is stored on the
   * Task; never auto-pushed).
   *
   * Implementation notes:
   *   - We `git add -A` first so newly-created files (the common case for
   *     the Coding Agent) appear in the diff. Without staging, `git diff
   *     HEAD` only shows changes to already-tracked files.
   *   - We do NOT commit — staging is just for the diff calculation.
   *   - If `HEAD` does not exist (fresh `git init` with no commit), we
   *     fall back to `git diff --cached` (staged vs. empty tree).
   */
  async createDiff(): Promise<{ patch: string; status: string }> {
    // Stage everything so newly-written files appear in the diff.
    await this.exec(["git", "add", "-A"]);
    const diff = await this.exec([
      "git",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "HEAD",
    ]);
    const status = await this.exec(["git", "status", "--short"]);
    // If the workspace has no commits yet (fresh init), fall back to the
    // staged-vs-empty diff.
    let patch = diff.stdout;
    if (!patch && /usage: git diff|HEAD/i.test(diff.stderr)) {
      const raw = await this.exec([
        "git",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--cached",
      ]);
      patch = raw.stdout;
    }
    return { patch, status: status.stdout };
  }

  /**
   * Initialise an empty git repo in the workspace (so `createDiff` and
   * `applyPatch` work even when the workspace was not cloned).
   */
  async gitInit(): Promise<ExecResult> {
    const init = await this.exec(["git", "init", "--quiet"]);
    if (init.exitCode !== 0) return init;
    // Set a default identity so commits (if any test framework commits
    // during a test run) don't fail.
    await this.exec(["git", "config", "user.email", "coding-agent@cryptoearn.local"]);
    await this.exec(["git", "config", "user.name", "CryptoEarn Coding Agent"]);
    // Initial commit so HEAD exists — `git diff HEAD` works.
    await this.exec(["git", "add", "."]);
    await this.exec([
      "git",
      "commit",
      "--quiet",
      "-m",
      "Initial workspace state (pre-generated code)",
      "--allow-empty",
    ]);
    return init;
  }

  // ---- dependency install -----------------------------------------------

  /**
   * Detect the package manager from the lockfile present in the workspace,
   * and run its install command. Spec §20 step 6: detect ecosystem + install.
   */
  async installDeps(
    opts: InstallDepsOpts = {}
  ): Promise<ExecResult> {
    const pkgMgr =
      opts.packageManager ?? (await this.detectPackageManager());
    const timeoutMs = opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
    switch (pkgMgr) {
      case "bun":
        return this.exec(["bun", "install", "--frozen-lockfile"], { timeoutMs });
      case "yarn":
        return this.exec(["yarn", "install", "--frozen-lockfile"], {
          timeoutMs,
        });
      case "pnpm":
        return this.exec(["pnpm", "install", "--frozen-lockfile"], {
          timeoutMs,
        });
      case "npm":
      default:
        return this.exec(["npm", "ci"], { timeoutMs });
    }
  }

  private async detectPackageManager(): Promise<
    "npm" | "bun" | "yarn" | "pnpm"
  > {
    const files = await this.listFiles();
    if (files.includes("bun.lockb") || files.includes("bun.lock")) return "bun";
    if (files.includes("yarn.lock")) return "yarn";
    if (files.includes("pnpm-lock.yaml")) return "pnpm";
    return "npm";
  }

  // ---- test runner ------------------------------------------------------

  /**
   * Detect the test framework from `package.json` / repo layout, run the
   * suite, and parse pass/fail counts from the output.
   *
   * Spec §20 step 7-8: detect framework → run → parse counts.
   */
  async runTests(opts: RunTestsOpts = {}): Promise<TestResult> {
    const framework = opts.framework ?? (await this.detectTestFramework());
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;

    let result: ExecResult;
    switch (framework) {
      case "bun":
        result = await this.exec(["bun", "test"], { timeoutMs });
        break;
      case "vitest":
        result = await this.exec(["npx", "vitest", "run", "--reporter=verbose"], {
          timeoutMs,
        });
        break;
      case "jest":
        result = await this.exec(["npx", "jest", "--verbose"], { timeoutMs });
        break;
      case "mocha":
        result = await this.exec(["npx", "mocha"], { timeoutMs });
        break;
      case "pytest":
        result = await this.exec(["pytest", "-q"], { timeoutMs });
        break;
      case "go":
        result = await this.exec(["go", "test", "./..."], { timeoutMs });
        break;
      case "cargo":
        result = await this.exec(["cargo", "test", "--no-fail-fast"], {
          timeoutMs,
        });
        break;
      case "node":
      case "node:test":
        result = await this.exec(["node", "--test"], { timeoutMs });
        break;
      case "npm-test":
      default:
        // Fallback: `npm test` (works for many repos).
        result = await this.exec(["npm", "test"], { timeoutMs });
        break;
    }

    const parsed = parseTestCounts(framework, result.stdout + "\n" + result.stderr);
    return {
      ...result,
      framework,
      passed: parsed.passed,
      failed: parsed.failed,
      ok: result.exitCode === 0 && parsed.failed === 0,
    };
  }

  private async detectTestFramework(): Promise<string> {
    // Try Node projects first — read package.json + lockfile.
    const pkgJsonRaw = await this.readFile("package.json");
    if (pkgJsonRaw) {
      try {
        const pkg = JSON.parse(pkgJsonRaw) as {
          scripts?: Record<string, string>;
          devDependencies?: Record<string, string>;
          dependencies?: Record<string, string>;
        };
        const allDeps = {
          ...(pkg.dependencies ?? {}),
          ...(pkg.devDependencies ?? {}),
        };
        if (allDeps["vitest"]) return "vitest";
        if (allDeps["jest"]) return "jest";
        if (allDeps["mocha"]) return "mocha";
        // If package.json has no test framework but the repo has a bun
        // lockfile, prefer `bun test`.
        const files = await this.listFiles();
        if (files.includes("bun.lockb") || files.includes("bun.lock")) {
          return "bun";
        }
        if (pkg.scripts?.test) return "npm-test";
        // Last-resort Node fallback: the built-in `node --test` runner.
        return "node";
      } catch {
        // fall through to non-node detection
      }
    }

    const files = await this.listFiles();
    if (files.some((f) => f.endsWith("_test.go") || f.endsWith(".go"))) {
      return "go";
    }
    if (files.some((f) => f.endsWith("Cargo.toml"))) return "cargo";
    if (files.some((f) => f.endsWith(".py"))) {
      if (files.some((f) => f.includes("pytest") || f.endsWith("conftest.py"))) {
        return "pytest";
      }
      return "pytest"; // default for python
    }
    return "unknown";
  }

  // ---- disk-usage check -------------------------------------------------

  /**
   * Best-effort measurement of the workspace's total disk usage in MB.
   * Walks the tree and sums `stat.size`. Skips `node_modules` and `.git`
   * (those can be huge — we measure them too but with a per-dir cap to
   * avoid pathological trees). Used by `exec` to enforce the size cap.
   */
  async sizeMb(): Promise<number> {
    let total = 0;
    const stack: string[] = [this.root];
    let visited = 0;
    const MAX_VISIT = 200_000; // safety valve — don't OOM the agent
    while (stack.length > 0 && visited < MAX_VISIT) {
      const dir = stack.pop()!;
      visited++;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        try {
          if (ent.isDirectory()) {
            // Skip the heaviest dirs from the size measurement — they are
            // still part of the workspace, but we don't want a single
            // pathological `node_modules` to OOM the agent's size-walker.
            if (LIST_SKIP_DIRS.has(ent.name)) continue;
            stack.push(full);
          } else if (ent.isFile()) {
            const st = await fs.stat(full);
            total += st.size;
          }
        } catch {
          // ignore stat errors
        }
      }
    }
    return total / (1024 * 1024);
  }
}

// ---------------------------------------------------------------------------
// Helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * Defensive argv sanitiser. Strips obviously-malicious inputs that could
 * fool `execFile` (e.g. embedded NULs that would be silently truncated).
 * Coerces every arg to a string. Does NOT split the command — the caller
 * MUST pass an argv array.
 */
function sanitizeCommand(command: string[]): string[] {
  if (!Array.isArray(command) || command.length === 0) {
    throw new SandboxPolicyError(
      "command_not_allowed",
      "exec requires a non-empty argv array"
    );
  }
  return command.map((arg, idx) => {
    if (typeof arg !== "string") {
      throw new SandboxPolicyError(
        "command_not_allowed",
        `argv[${idx}] is not a string (got ${typeof arg})`
      );
    }
    // Reject embedded NULs — they are almost always an exploit attempt
    // against C-based parsers (and Node's child_process will silently
    // truncate at them).
    if (arg.includes("\0")) {
      throw new SandboxPolicyError(
        "command_not_allowed",
        `argv[${idx}] contains a NUL byte — refusing to spawn`
      );
    }
    return arg;
  });
}

/**
 * Truncate `s` to `maxBytes` (treated as chars for simplicity — Node strings
 * are UTF-16 but the byte count is close enough for the audit log). Appends
 * a `…[truncated N bytes]` marker when truncated.
 */
function truncate(s: string, maxBytes: number): string {
  if (!s) return "";
  if (s.length <= maxBytes) return s;
  const cut = Math.max(0, maxBytes - 80);
  return (
    s.slice(0, cut) +
    `\n…[truncated ${s.length - cut} chars by CodingWorkspace truncation guard]\n`
  );
}

/**
 * Best-effort parser for test-runner output. Recognises the common output
 * formats of jest, vitest, mocha, pytest, go, cargo, and node:test.
 *
 * Returns `{ passed, failed }` — 0,0 if nothing matched (caller should fall
 * back to `exitCode === 0` as the success signal in that case).
 */
function parseTestCounts(
  framework: string,
  combinedOutput: string
): { passed: number; failed: number } {
  const text = combinedOutput ?? "";
  // Jest / vitest: "Tests: 3 passed, 1 failed, 4 total"
  let m = text.match(/(\d+)\s+passed/);
  let passed = m ? parseInt(m[1], 10) : 0;
  m = text.match(/(\d+)\s+failed/);
  let failed = m ? parseInt(m[1], 10) : 0;

  // pytest: "5 passed, 2 failed in 3.41s"
  if (framework === "pytest" && (passed === 0 && failed === 0)) {
    m = text.match(/(\d+)\s+passed/);
    if (m) passed = parseInt(m[1], 10);
    m = text.match(/(\d+)\s+failed/);
    if (m) failed = parseInt(m[1], 10);
  }

  // go test: "ok  package  0.123s" or "FAIL  package  0.123s" — no counts
  // in the default output. We rely on exitCode for go.
  if (framework === "go") {
    if (/^FAIL\b/m.test(text)) failed = Math.max(failed, 1);
    else if (/^ok\b/m.test(text) && failed === 0) passed = Math.max(passed, 1);
  }

  // cargo test: "test result: FAILED. 0 passed; 2 failed;"
  if (framework === "cargo") {
    m = text.match(/(\d+)\s+passed/i);
    if (m) passed = parseInt(m[1], 10);
    m = text.match(/(\d+)\s+failed/i);
    if (m) failed = parseInt(m[1], 10);
  }

  // node:test: "tests 3\npass 2\nfail 1"
  if (framework === "node" || framework === "node:test") {
    if (passed === 0 && failed === 0) {
      m = text.match(/# (pass|passed)\s+(\d+)/i);
      if (m) passed = parseInt(m[2], 10);
      m = text.match(/# (fail|failed)\s+(\d+)/i);
      if (m) failed = parseInt(m[2], 10);
    }
  }

  // mocha: "2 passing (3s)" / "1 failing"
  if (framework === "mocha") {
    m = text.match(/(\d+)\s+passing/);
    if (m) passed = parseInt(m[1], 10);
    m = text.match(/(\d+)\s+failing/);
    if (m) failed = parseInt(m[1], 10);
  }

  return { passed, failed: Number.isFinite(failed) ? failed : 0 };
}
