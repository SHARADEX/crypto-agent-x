// Coding-agent sandbox policy (spec §20, §32, P2-CODING).
//
// The Coding Agent runs untrusted commands (git, npm, bun, python3, …) inside
// an isolated workspace. To prevent the LLM from injecting arbitrary shell
// commands, every command first goes through the allow-list in this module.
//
// Design rules:
//   1. The allow-list is the ONLY source of truth. Anything not on it is
//      rejected with `SandboxPolicyError`.
//   2. Only commands that are part of a normal build/test/clone workflow are
//      allowed. Notably absent: `curl`, `wget`, `ssh`, `scp`, `bash`, `sh`,
//      `zsh`, `fish`, `python` (use `python3` — `python` historically
//      shadows system binaries on some distros), `chmod`, `chown`, `kill`.
//   3. The list is intentionally short. Each entry must have a justification
//      comment. Adding an entry requires the change to be reviewed.
//   4. Time + size caps below are the hard ceiling for a single coding task.
//      The workspace runtime (`workspace.ts`) enforces them; this module
//      just exports the constants so they can be reused by callers (e.g.
//      the orchestrator may pre-check the budget before creating a
//      workspace).

// ---------------------------------------------------------------------------
// Allow-list
// ---------------------------------------------------------------------------

/**
 * Commands the Coding Agent is allowed to spawn inside a workspace.
 *
 * IMPORTANT: this list is consulted by `assertCommandAllowed` BEFORE the
 * command is handed to `execFile`. A command not in this set will be
 * rejected — even if the underlying OS would have allowed it.
 *
 * Justifications:
 *   - `git`         — clone, diff, apply, status.
 *   - `npm`         — install deps, run tests in node projects.
 *   - `bun`         — install deps, run tests in bun projects.
 *   - `yarn`        — install deps, run tests in yarn projects.
 *   - `pnpm`        — install deps, run tests in pnpm projects.
 *   - `node`        — run generated JS/TS scripts + `node --test`.
 *   - `npx`         — execute locally-installed binaries (jest, vitest, …).
 *   - `python3`     — run generated python scripts.
 *   - `pytest`      — run python tests.
 *   - `go`          — run go tests.
 *   - `cargo`       — run rust tests.
 *   - `make`        — run a Makefile target (allowed because many OSS
 *                      repos have `make test`). Reviewers must check the
 *                      generated Makefile before approving.
 *   - `tsc`         — typecheck generated TS.
 *   - `eslint`      — lint generated JS/TS.
 *   - `mkdir`       — create sub-directories inside the workspace.
 *   - `cp`          — copy files inside the workspace.
 *   - `mv`          — move files inside the workspace.
 *   - `rm`          — remove files inside the workspace (the workspace
 *                      `cleanup()` uses `fs.rm`, not this command — this
 *                      is for repo-internal cleanup like `rm -rf dist/`).
 *   - `ls`          — list files (debugging).
 *   - `cat`         — print files (debugging).
 *
 * NOTABLY ABSENT (and why):
 *   - `curl`/`wget`   — network exfiltration primitives. The LLM does not
 *                        need these; if a test requires a fixture, it
 *                        should be committed or generated.
 *   - `bash`/`sh`     — running a shell would let the LLM escape the
 *                        allow-list (a shell can call any binary).
 *   - `chmod`/`chown` — privilege escalation. The workspace is owned by
 *                        the agent's uid already.
 *   - `kill`/`killall` — process-killing outside the workspace.
 *   - `sudo`/`su`     — privilege escalation.
 *   - `docker`/`podman`— container escape primitives; we are not running
 *                        containers inside the sandbox.
 *   - `ssh`/`scp`/`rsync` — remote-shell primitives.
 *   - `python` (no `3`) — historically shadowed system binaries on macOS
 *                        and some Linux distros. Force `python3`.
 */
export const SANDBOX_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  // version control
  "git",
  // JS package managers + runners
  "npm",
  "npx",
  "bun",
  "yarn",
  "pnpm",
  "node",
  "tsc",
  "eslint",
  // python
  "python3",
  "pytest",
  // other ecosystems
  "go",
  "cargo",
  "make",
  // filesystem primitives (workspace-internal only — paths are validated
  // by the workspace before execFile is invoked)
  "mkdir",
  "cp",
  "mv",
  "rm",
  "ls",
  "cat",
]);

// ---------------------------------------------------------------------------
// Hard caps
// ---------------------------------------------------------------------------

/**
 * Maximum total disk usage of a single workspace (in MB) before it is
 * force-cleaned. This protects the agent's host from runaway `node_modules`
 * growth + git-history bloat. Spec §20 implies "constrained resources".
 */
export const MAX_WORKSPACE_SIZE_MB = 500;

/**
 * Hard cap on any single `workspace.exec()` call (2 minutes). The workspace
 * runtime applies this as the default timeout; callers may pass a lower
 * `timeoutMs` but not a higher one.
 */
export const MAX_EXECUTION_TIME_MS = 120_000;

/**
 * Hard cap on the *entire* coding-task execution (10 minutes). The Coding
 * Agent enforces this by recording the start time and refusing to spawn
 * additional commands once the cap is exceeded.
 */
export const MAX_TOTAL_EXECUTION_TIME_MS = 600_000;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when a command is not on the {@link SANDBOX_ALLOWED_COMMANDS}
 * allow-list, or when a hard cap is exceeded. The workspace runtime catches
 * this and converts it to a structured failure result so the Coding Agent
 * never throws out of `execute`.
 */
export class SandboxPolicyError extends Error {
  readonly code:
    | "command_not_allowed"
    | "execution_timeout"
    | "total_execution_exceeded"
    | "workspace_too_large";
  readonly command?: string;

  constructor(
    code:
      | "command_not_allowed"
      | "execution_timeout"
      | "total_execution_exceeded"
      | "workspace_too_large",
    message: string,
    command?: string
  ) {
    super(message);
    this.name = "SandboxPolicyError";
    this.code = code;
    if (command) this.command = command;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assert that `command` (the first element of the argv array passed to
 * `workspace.exec`) is on the allow-list. Throws {@link SandboxPolicyError}
 * with code `command_not_allowed` otherwise.
 *
 * The check is a STRICT string equality on the resolved basename — we do
 * not allow path-prefixed binaries (`/usr/bin/git` is fine, `/tmp/evil/git`
 * is NOT). Callers should always pass a bare command name (`"git"`) and let
 * `execFile` resolve it via `PATH`.
 */
export function assertCommandAllowed(command: string): void {
  if (typeof command !== "string" || command.length === 0) {
    throw new SandboxPolicyError(
      "command_not_allowed",
      "command is empty or not a string"
    );
  }

  // Reject anything containing a path separator — the agent should NEVER
  // pass `/usr/bin/git` or `./my-evil-binary`. Force bare names so the
  // `execFile` PATH lookup is the only way to resolve the binary.
  if (command.includes("/") || command.includes("\\")) {
    throw new SandboxPolicyError(
      "command_not_allowed",
      `command '${command}' contains a path separator — only bare command names are allowed (let execFile resolve via PATH)`,
      command
    );
  }

  // Reject any whitespace — `git rm` as the "command" is a shell-injection
  // attempt (the caller should have split it into argv).
  if (/\s/.test(command)) {
    throw new SandboxPolicyError(
      "command_not_allowed",
      `command '${command}' contains whitespace — pass argv as an array, not a string`,
      command
    );
  }

  if (!SANDBOX_ALLOWED_COMMANDS.has(command)) {
    throw new SandboxPolicyError(
      "command_not_allowed",
      `command '${command}' is not on the sandbox allow-list (allowed: ${Array.from(
        SANDBOX_ALLOWED_COMMANDS
      ).join(", ")})`,
      command
    );
  }
}

/**
 * Validate that a per-call `timeoutMs` does not exceed {@link MAX_EXECUTION_TIME_MS}.
 * Returns the (possibly clamped) timeout. Throws if the caller explicitly
 * asks for more than the cap (programming error — fail loud).
 */
export function clampExecTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return MAX_EXECUTION_TIME_MS;
  }
  if (timeoutMs <= 0) {
    return MAX_EXECUTION_TIME_MS;
  }
  if (timeoutMs > MAX_EXECUTION_TIME_MS) {
    throw new SandboxPolicyError(
      "execution_timeout",
      `requested timeout ${timeoutMs}ms exceeds the hard cap ${MAX_EXECUTION_TIME_MS}ms`
    );
  }
  return Math.floor(timeoutMs);
}
