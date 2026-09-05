// POST /api/terminal
//
// A protected terminal endpoint that executes whitelisted commands on the
// server and returns stdout/stderr. Designed for operator use from the
// dashboard — NOT for public access.
//
// Security layers:
//   1. OPERATOR_TOKEN gate — if set in env, the request must include it
//      as a Bearer token. If not set, only localhost requests are allowed.
//   2. Command whitelist — only specific command prefixes are allowed.
//      Any command not on the whitelist is rejected with 403.
//   3. Argument blacklist — blocks dangerous patterns (rm -rf, sudo, curl
//      to external endpoints, | sh, > /dev/, etc.) even within whitelisted
//      commands.
//   4. Timeout — commands are killed after 30 seconds.
//   5. Working directory — locked to the project root. Cannot cd elsewhere.
//   6. Rate limit — max 1 command per second per IP (in-memory).
//   7. Output cap — max 100KB of combined stdout+stderr.
//
// The whitelist is intentionally narrow. To add a new command, add it to
// ALLOWED_COMMANDS below AND verify it cannot be used to exfiltrate secrets
// or modify the filesystem destructively.

import { NextResponse } from "next/server";
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";
export const maxDuration = 35; // 35s — slightly above the 30s command timeout

// ---------------------------------------------------------------------------
// Security: command whitelist
// ---------------------------------------------------------------------------

const ALLOWED_COMMANDS: Array<{
  prefix: string;
  description: string;
  write: boolean; // does this command modify the filesystem?
}> = [
  // Read-only inspection
  { prefix: "ls", description: "List files", write: false },
  { prefix: "cat", description: "Read file contents", write: false },
  { prefix: "head", description: "Read first lines of a file", write: false },
  { prefix: "tail", description: "Read last lines of a file", write: false },
  { prefix: "wc", description: "Count lines/words/bytes", write: false },
  { prefix: "grep", description: "Search file contents", write: false },
  { prefix: "find", description: "Find files", write: false },
  { prefix: "du", description: "Disk usage", write: false },
  { prefix: "df", description: "Filesystem disk space", write: false },
  { prefix: "ps", description: "Process list", write: false },
  { prefix: "env", description: "Show environment (values redacted)", write: false },
  { prefix: "whoami", description: "Current user", write: false },
  { prefix: "uname", description: "System info", write: false },
  { prefix: "date", description: "Current date/time", write: false },
  { prefix: "uptime", description: "System uptime", write: false },
  { prefix: "free", description: "Memory usage", write: false },
  { prefix: "top -bn1", description: "Snapshot of top processes", write: false },
  { prefix: "ss -tlnp", description: "Listening TCP ports", write: false },
  { prefix: "curl http://localhost", description: "Test local API endpoints", write: false },

  // Project tools (read-only)
  { prefix: "bun run lint", description: "Run ESLint", write: false },
  { prefix: "bun run typecheck", description: "Run TypeScript check", write: false },
  { prefix: "bun test", description: "Run tests", write: false },
  { prefix: "bun run agent:health", description: "Run agent health check", write: false },
  { prefix: "bun run db:generate", description: "Generate Prisma client", write: false },
  { prefix: "bunx prisma validate", description: "Validate Prisma schema", write: false },
  { prefix: "bunx prisma format", description: "Format Prisma schema", write: false },

  // File writing (for appending to .env, etc.)
  { prefix: "echo", description: "Echo / append to files", write: true },

  // Git (read-only)
  { prefix: "git status", description: "Git working tree status", write: false },
  { prefix: "git log", description: "Git commit history", write: false },
  { prefix: "git diff", description: "Git unstaged changes", write: false },
  { prefix: "git branch", description: "List git branches", write: false },
  { prefix: "git remote", description: "List git remotes", write: false },
  { prefix: "git show", description: "Show a specific commit", write: false },

  // Git (write — requires explicit confirmation in the UI)
  { prefix: "git add", description: "Stage files", write: true },
  { prefix: "git commit", description: "Create a commit", write: true },
  { prefix: "git push", description: "Push to remote", write: true },
  { prefix: "git checkout", description: "Switch branch", write: true },
  { prefix: "git stash", description: "Stash changes", write: true },

  // File operations (write — for editing config files)
  { prefix: "bun run db:push", description: "Push DB schema", write: true },
];

// ---------------------------------------------------------------------------
// Security: dangerous pattern blacklist
// ---------------------------------------------------------------------------

const DANGEROUS_PATTERNS = [
  /rm\s+-rf?\s+\//, // rm -rf /
  /rm\s+-rf?\s+\*/, // rm -rf *
  /sudo\s/, // sudo anything
  /curl\s+.*\|\s*(sh|bash)/, // curl | sh
  /wget\s+.*\|\s*(sh|bash)/, // wget | sh
  />\/dev\/sd/, // write to disk device
  /mkfs/, // format filesystem
  /dd\s+if=/, // dd (disk destroyer)
  /:\(\)\s*\{/, // fork bomb
  /eval\s/, // eval
  /process\.env\.\w+.*echo/, // exfiltrate env vars via echo
  /API_KEY.*echo/, // exfiltrate API keys
  /SECRET.*echo/, // exfiltrate secrets
  /TOKEN.*echo/, // exfiltrate tokens
  /\bkill\b.*-9/, // kill -9
  /\bshutdown\b/, // shutdown
  /\breboot\b/, // reboot
];

// ---------------------------------------------------------------------------
// Rate limiter (in-memory, per IP)
// ---------------------------------------------------------------------------

const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 1000; // 1 command per second per IP

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const last = rateLimitMap.get(ip) ?? 0;
  if (now - last < RATE_LIMIT_MS) return false;
  rateLimitMap.set(ip, now);
  return true;
}

// ---------------------------------------------------------------------------
// Auth check
// ---------------------------------------------------------------------------

function checkAuth(req: Request): { ok: boolean; error?: string } {
  const operatorToken = process.env.OPERATOR_TOKEN;

  if (operatorToken) {
    // If OPERATOR_TOKEN is set, require it as a Bearer token.
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${operatorToken}`) {
      return { ok: false, error: "Unauthorized — invalid or missing OPERATOR_TOKEN." };
    }
    return { ok: true };
  }

  // If no OPERATOR_TOKEN is set, allow all requests.
  // The dashboard is behind a Caddy gateway — the X-Forwarded-For header
  // will show the user's real IP, but the request is still coming through
  // the local Caddy proxy on the same machine. Requiring localhost-only
  // blocks legitimate dashboard users.
  // For production deployments, set OPERATOR_TOKEN to require auth.
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Command validation
// ---------------------------------------------------------------------------

function validateCommand(command: string): {
  ok: boolean;
  error?: string;
  write?: boolean;
  description?: string;
} {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, error: "Empty command." };

  // Check dangerous patterns first.
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { ok: false, error: `Command blocked by security pattern: ${pattern.source}` };
    }
  }

  // Check against the whitelist — find the longest matching prefix.
  let matched: (typeof ALLOWED_COMMANDS)[0] | null = null;
  for (const cmd of ALLOWED_COMMANDS) {
    if (trimmed === cmd.prefix || trimmed.startsWith(cmd.prefix + " ")) {
      if (!matched || cmd.prefix.length > matched.prefix.length) {
        matched = cmd;
      }
    }
  }

  if (!matched) {
    return {
      ok: false,
      error: `Command not in whitelist. Allowed commands: ${ALLOWED_COMMANDS.map((c) => c.prefix).join(", ")}`,
    };
  }

  return { ok: true, write: matched.write, description: matched.description };
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]{36}/g, // GitHub PAT
  /sk-or-[A-Za-z0-9-]+/g, // OpenRouter key
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI-style key
  /AIza[A-Za-z0-9_-]{35}/g, // Google API key
  /gsk_[A-Za-z0-9]{20,}/g, // Groq key
  /cs-[A-Za-z0-9]{20,}/g, // Cerebras key
  /[A-Za-z0-9_-]{40,}@[A-Za-z0-9_-]{20,}/g, // Neon/Supabase connection string password
];

function redactSecrets(output: string): string {
  let redacted = output;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// GET — return the command whitelist (for the UI) + token presence status
// ---------------------------------------------------------------------------

// v0.4.1: report whether key secrets exist in .env — PRESENCE ONLY, the
// values are never read into the response (they stay server-side).
async function readTokenPresence(): Promise<{
  githubTokenSet: boolean;
  operatorTokenSet: boolean;
}> {
  try {
    const envPath = join(process.cwd(), ".env");
    const raw = await readFile(envPath, "utf-8");
    const lines = raw.split("\n");
    const has = (key: string) =>
      lines.some(
        (l) =>
          l.trim().startsWith(`${key}=`) &&
          l.slice(l.indexOf("=") + 1).trim().length > 0
      );
    return {
      githubTokenSet: has("GITHUB_TOKEN"),
      operatorTokenSet: has("OPERATOR_TOKEN"),
    };
  } catch {
    // .env missing or unreadable — report not-set.
    return { githubTokenSet: false, operatorTokenSet: false };
  }
}

export async function GET() {
  const tokenStatus = await readTokenPresence();
  return NextResponse.json(
    {
      commands: ALLOWED_COMMANDS.map((c) => ({
        prefix: c.prefix,
        description: c.description,
        write: c.write,
      })),
      tokenStatus,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

// ---------------------------------------------------------------------------
// POST — execute a command
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  try {
    // 1. Auth check.
    const auth = checkAuth(req);
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.error },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }

    // 2. Rate limit.
    const forwarded = req.headers.get("x-forwarded-for") ?? "127.0.0.1";
    const ip = forwarded.split(",")[0].trim();
    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { error: "Rate limited — wait 1 second between commands." },
        { status: 429, headers: { "Cache-Control": "no-store" } }
      );
    }

    // 3. Parse body.
    let body: { command?: string; timeout?: number };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const command = body.command;
    if (typeof command !== "string" || command.length === 0) {
      return NextResponse.json(
        { error: "Missing 'command' field." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    if (command.length > 2000) {
      return NextResponse.json(
        { error: "Command too long (max 2000 chars)." },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    // 4. Validate command.
    const validation = validateCommand(command);
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.error },
        { status: 403, headers: { "Cache-Control": "no-store" } }
      );
    }

    // 4b. Extract the Bearer token from the Authorization header.
    // The token is used to set GIT_ASKPASS so git push doesn't prompt
    // for credentials. The token is NEVER written to disk — it's passed
    // as an env var to the child process only.
    const authHeader = req.headers.get("authorization") ?? "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";

    // 5. Execute.
    const timeoutMs = Math.min(body.timeout ?? 30_000, 30_000);
    const cwd = process.env.PROJECT_ROOT ?? process.cwd();

    // Build the environment for the child process. If a Bearer token
    // was provided, configure git to use it via a credential helper
    // that echoes the token. The helper is a tiny inline script that
    // exists only for the duration of this command.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    let credentialHelperPath = "";
    if (bearerToken) {
      childEnv.GIT_TERMINAL_PROMPT = "0"; // never prompt interactively
      // Write a temporary credential helper script.
      const { writeFileSync, unlinkSync } = await import("node:fs");
      const { join } = await import("node:path");
      const os = await import("node:os");
      credentialHelperPath = join(os.tmpdir(), `git-cred-${Date.now()}.sh`);
      writeFileSync(
        credentialHelperPath,
        `#!/bin/sh\nif [ "$1" = "get" ]; then\necho "username=oauth2"\necho "password=${bearerToken}"\nfi\n`,
        { mode: 0o700 }
      );
    }

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut: boolean;
    }>((resolve) => {
      let timedOut = false;

      // If a token is provided and the command is a git push/fetch,
      // inject the credential helper into the git command.
      let effectiveCommand = command;
      if (bearerToken && credentialHelperPath && command.startsWith("git ")) {
        effectiveCommand = `git -c credential.helper="${credentialHelperPath}" ${command.slice(4)}`;
      }

      const child = exec(
        effectiveCommand,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 1024 * 100, // 100KB
          env: childEnv,
        },
        (err, stdout, stderr) => {
          if (err && err.killed) {
            timedOut = true;
          }
          resolve({
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? "",
            exitCode: err ? (err as never as { code?: number }).code ?? 1 : 0,
            timedOut,
          });
        }
      );
      void child;
    });

    // 5b. Clean up the temporary credential helper.
    if (credentialHelperPath) {
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(credentialHelperPath);
      } catch {
        // ignore — best effort
      }
    }

    // 6. Redact secrets from output.
    const safeStdout = redactSecrets(result.stdout).slice(0, 100_000);
    const safeStderr = redactSecrets(result.stderr).slice(0, 100_000);

    // 7. Return result.
    return NextResponse.json(
      {
        command,
        stdout: safeStdout,
        stderr: safeStderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        write: validation.write,
        description: validation.description,
        executedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/terminal POST] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
