"use client";

// TerminalPanel — a web-based terminal for the CryptoEarn Agent dashboard.
//
// Allows the operator to run whitelisted commands directly from the
// dashboard. Commands are validated server-side against a whitelist +
// dangerous patterns are blocked. Secrets in output are automatically
// redacted.
//
// Features:
//   - Command input with history (up/down arrows)
//   - Colored output (stdout=green, stderr=red, info=cyan)
//   - Write-command confirmation (git push, git commit, etc.)
//   - Command whitelist sidebar
//   - Rate-limit indicator
//   - Copy output button
//   - Clear terminal button

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Terminal as TerminalIcon,
  Send,
  Trash2,
  Copy,
  Check,
  AlertTriangle,
  Loader2,
  ChevronUp,
  ChevronDown,
  KeyRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { TokenInput } from "./token-input";

interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  write?: boolean;
  description?: string;
  executedAt: string;
}

interface WhitelistEntry {
  prefix: string;
  description: string;
  write: boolean;
}

interface HistoryEntry {
  type: "input" | "output" | "error" | "info";
  text: string;
  timestamp: string;
}

const MAX_HISTORY = 200;
const MAX_INPUT_HISTORY = 50;

export function TerminalPanel({
  autoFocusToken,
}: {
  /** v0.4.6: when true, the panel pre-fills the GITHUB_TOKEN echo command
   *  + focuses the input once token presence resolves as "not set" — the
   *  guided "Connect GitHub" flow from the Action Center / palette.
   *  No-op when the token is already present. */
  autoFocusToken?: boolean;
}) {
  const [input, setInput] = React.useState("");
  const [history, setHistory] = React.useState<HistoryEntry[]>([]);
  const [inputHistory, setInputHistory] = React.useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = React.useState(-1);
  const [running, setRunning] = React.useState(false);
  const [whitelist, setWhitelist] = React.useState<WhitelistEntry[]>([]);
  const [showWhitelist, setShowWhitelist] = React.useState(false);
  // v0.4.1: GITHUB_TOKEN presence in .env (from the terminal GET — values
  // never leave the server; only this boolean).
  const [githubTokenSet, setGithubTokenSet] = React.useState<boolean | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [pendingWrite, setPendingWrite] = React.useState<{
    command: string;
    description?: string;
  } | null>(null);

  // Secure token — held in React state (in-memory only). NEVER written to
  // localStorage, sessionStorage, or cookies. Lost on page refresh.
  // Used as a Bearer token for terminal API requests so authenticated
  // commands (git push, etc.) can use it without storing it on disk.
  const [authToken, setAuthToken] = React.useState("");

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Fetch the command whitelist + token presence on mount.
  React.useEffect(() => {
    fetch("/api/terminal")
      .then((r) => r.json())
      .then((data) => {
        if (data.commands) setWhitelist(data.commands);
        if (data.tokenStatus?.githubTokenSet !== undefined) {
          setGithubTokenSet(Boolean(data.tokenStatus.githubTokenSet));
        }
      })
      .catch(() => {});
  }, []);

  // Re-check token presence after any echo-to-.env command executes (the
  // operator's documented GITHUB_TOKEN workflow).
  const refreshTokenStatus = React.useCallback(() => {
    fetch("/api/terminal")
      .then((r) => r.json())
      .then((data) => {
        if (data.tokenStatus?.githubTokenSet !== undefined) {
          setGithubTokenSet(Boolean(data.tokenStatus.githubTokenSet));
        }
      })
      .catch(() => {});
  }, []);

  // Auto-scroll to bottom when history changes.
  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history]);

  const addHistory = React.useCallback((type: HistoryEntry["type"], text: string) => {
    setHistory((prev) => {
      const next = [...prev, { type, text, timestamp: new Date().toISOString() }];
      if (next.length > MAX_HISTORY) return next.slice(-MAX_HISTORY);
      return next;
    });
  }, []);

  const executeCommand = React.useCallback(
    async (cmd: string) => {
      setRunning(true);
      addHistory("input", cmd);

      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        // Include the auth token as a Bearer header if set.
        if (authToken) {
          headers["authorization"] = `Bearer ${authToken}`;
        }
        const res = await fetch("/api/terminal", {
          method: "POST",
          headers,
          body: JSON.stringify({ command: cmd }),
        });
        const data: CommandResult | { error: string } = await res.json();

        if ("error" in data) {
          addHistory("error", data.error);
        } else {
          if (data.stdout) addHistory("output", data.stdout);
          if (data.stderr) addHistory("error", data.stderr);
          if (data.timedOut) addHistory("error", "⏱ Command timed out after 30 seconds.");
          if (!data.stdout && !data.stderr && !data.timedOut) {
            addHistory("info", `✓ Exit code ${data.exitCode} (no output)`);
          } else if (data.exitCode !== 0 && !data.timedOut) {
            addHistory("info", `Exit code: ${data.exitCode}`);
          }
          // v0.4.1: writing to .env may change token presence — re-check.
          if (cmd.startsWith("echo") && cmd.includes(".env")) {
            refreshTokenStatus();
          }
        }
      } catch (err) {
        addHistory("error", `Network error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setRunning(false);
      }
    },
    [addHistory, refreshTokenStatus, authToken]
  );

  const handleSubmit = React.useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const cmd = input.trim();
      if (!cmd || running) return;

      // Add to input history.
      setInputHistory((prev) => {
        const next = [...prev, cmd];
        if (next.length > MAX_INPUT_HISTORY) return next.slice(-MAX_INPUT_HISTORY);
        return next;
      });
      setHistoryIndex(-1);
      setInput("");

      // Check if this is a write command — if so, show confirmation.
      const writeCmd = whitelist.find(
        (w) => cmd === w.prefix || cmd.startsWith(w.prefix + " ")
      );
      if (writeCmd?.write) {
        setPendingWrite({ command: cmd, description: writeCmd.description });
        return;
      }

      executeCommand(cmd);
    },
    [input, running, whitelist, executeCommand]
  );

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Up arrow — previous command.
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (inputHistory.length === 0) return;
        const newIdx = historyIndex === -1 ? inputHistory.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(newIdx);
        setInput(inputHistory[newIdx]);
      }
      // Down arrow — next command.
      else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (historyIndex === -1) return;
        const newIdx = historyIndex + 1;
        if (newIdx >= inputHistory.length) {
          setHistoryIndex(-1);
          setInput("");
        } else {
          setHistoryIndex(newIdx);
          setInput(inputHistory[newIdx]);
        }
      }
      // Ctrl+L — clear terminal.
      else if (e.ctrlKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setHistory([]);
      }
    },
    [inputHistory, historyIndex]
  );

  const handleCopy = React.useCallback(() => {
    const text = history
      .map((h) => {
        const prefix = h.type === "input" ? "$ " : h.type === "error" ? "⚠ " : "";
        return `${prefix}${h.text}`;
      })
      .join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [history]);

  const quickCommands = [
    "bun run agent:health",
    "bun run lint",
    "bun run typecheck",
    "bun test",
    "git status",
    "git log --oneline -5",
    "git diff --stat",
  ];

  // v0.4.1: the operator's GITHUB_TOKEN workflow — pre-fill the echo command
  // template so the operator only pastes the token + hits Enter.
  const prefillTokenCommand = () => {
    setInput("echo 'GITHUB_TOKEN=YOUR_TOKEN_HERE' >> .env");
    inputRef.current?.focus();
  };

  // v0.4.6: guided connect flow — when the drawer is opened with intent and
  // the token is confirmed missing, pre-fill the command once. Waits for the
  // presence fetch to resolve (null = still loading) so an already-connected
  // operator never sees a stale template.
  const tokenPrefillArmed = React.useRef(false);
  React.useEffect(() => {
    if (!autoFocusToken || tokenPrefillArmed.current) return;
    if (githubTokenSet === null) return; // still loading — wait
    tokenPrefillArmed.current = true;
    if (githubTokenSet === false) prefillTokenCommand();
  }, [autoFocusToken, githubTokenSet]);

  return (
    <div className="flex flex-col rounded-lg border border-border/60 bg-black/95 overflow-hidden h-[500px]">
      {/* Terminal header */}
      <div className="flex items-center justify-between border-b border-border/40 bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-4 text-emerald-500" />
          <span className="text-xs font-medium text-muted-foreground">
            Terminal
          </span>
          {running && (
            <Loader2 className="size-3 animate-spin text-emerald-500" />
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* v0.4.1: GITHUB_TOKEN presence chip (values never leave the server) */}
          <button
            type="button"
            onClick={githubTokenSet ? undefined : prefillTokenCommand}
            title={
              githubTokenSet
                ? "GITHUB_TOKEN is present in .env — PR submission is unlocked.\nPresence only; the value never leaves the server."
                : "GITHUB_TOKEN is not in .env. Click to pre-fill the echo command, paste your token, and press Enter (write-confirmation will appear)."
            }
            className={
              "flex h-6 items-center gap-1 rounded-md border px-2 text-[10px] font-medium transition-colors " +
              (githubTokenSet
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20")
            }
          >
            <KeyRound className="size-3" aria-hidden />
            {githubTokenSet === null ? "GITHUB_TOKEN …" : githubTokenSet ? "GITHUB_TOKEN set" : "GITHUB_TOKEN not set"}
          </button>
          {/* Token input — in-memory only, never persisted */}
          <TokenInput token={authToken} onTokenChange={setAuthToken} />
          {/* Quick commands dropdown */}
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[10px] text-muted-foreground"
              onClick={() => setShowWhitelist((v) => !v)}
            >
              Commands
              {showWhitelist ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            </Button>
            <AnimatePresence>
              {showWhitelist && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="absolute right-0 top-full z-50 mt-1 max-h-64 w-80 overflow-auto scrollbar-thin rounded-lg border border-border/60 bg-background p-2 shadow-xl"
                >
                  <div className="mb-2 text-[10px] font-medium uppercase text-muted-foreground">
                    Quick Commands
                  </div>
                  <div className="space-y-0.5">
                    {quickCommands.map((cmd) => (
                      <button
                        key={cmd}
                        type="button"
                        className="block w-full truncate rounded px-2 py-1 text-left text-[11px] font-mono text-foreground transition-colors hover:bg-muted"
                        onClick={() => {
                          setInput(cmd);
                          setShowWhitelist(false);
                          inputRef.current?.focus();
                        }}
                      >
                        {cmd}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 mb-1 text-[10px] font-medium uppercase text-muted-foreground">
                    All Whitelisted ({whitelist.length})
                  </div>
                  <div className="space-y-0.5">
                    {whitelist.map((cmd) => (
                      <div
                        key={cmd.prefix}
                        className="flex items-center justify-between gap-2 rounded px-2 py-1 text-[11px] hover:bg-muted"
                      >
                        <span className="truncate font-mono text-foreground">{cmd.prefix}</span>
                        <div className="flex shrink-0 items-center gap-1">
                          {cmd.write && (
                            <Badge variant="outline" className="text-[8px] border-amber-500/40 bg-amber-500/10 text-amber-600">
                              write
                            </Badge>
                          )}
                          <span className="text-[9px] text-muted-foreground">{cmd.description}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-[10px] text-muted-foreground"
            onClick={handleCopy}
            title="Copy terminal output"
          >
            {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-[10px] text-muted-foreground"
            onClick={() => setHistory([])}
            title="Clear terminal (Ctrl+L)"
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>

      {/* Terminal output */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto scrollbar-thin p-3 font-mono text-[12px] leading-relaxed"
        onClick={() => inputRef.current?.focus()}
      >
        {history.length === 0 ? (
          <div className="text-muted-foreground">
            <span className="text-emerald-500">cryptoearn@dashboard</span>:~$ <span className="animate-pulse">█</span>
            <div className="mt-2 text-[10px] text-muted-foreground/60">
              Type a command and press Enter. Use ↑/↓ for history. Ctrl+L to clear.
            </div>
            {/* v0.4.1: first-run token guidance for the operator workflow */}
            {githubTokenSet === false && (
              <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
                <p className="text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">
                  <KeyRound className="mr-1 inline size-3" aria-hidden />
                  GITHUB_TOKEN is not set — PR submission is locked. Click the
                  amber chip in the header (or{" "}
                  <button
                    type="button"
                    onClick={prefillTokenCommand}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    pre-fill the command
                  </button>
                  ), paste your token, and press Enter.
                </p>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {quickCommands.slice(0, 4).map((cmd) => (
                <button
                  key={cmd}
                  type="button"
                  className="rounded border border-border/40 bg-muted/30 px-2 py-0.5 text-[10px] font-mono text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={() => {
                    setInput(cmd);
                    inputRef.current?.focus();
                  }}
                >
                  {cmd}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {history.map((entry, i) => (
              <div
                key={i}
                className={cn(
                  "whitespace-pre-wrap break-all",
                  entry.type === "input" && "text-emerald-400",
                  entry.type === "output" && "text-foreground/90",
                  entry.type === "error" && "text-red-400",
                  entry.type === "info" && "text-cyan-400"
                )}
              >
                {entry.type === "input" && (
                  <span className="text-emerald-500">{"cryptoearn@dashboard:~$ "}</span>
                )}
                {entry.type === "error" && "⚠ "}
                {entry.type === "info" && "ℹ "}
                {entry.text}
              </div>
            ))}
            {running && (
              <div className="text-amber-400">
                <Loader2 className="mr-1 inline size-3 animate-spin" />
                executing...
              </div>
            )}
            <span className="animate-pulse text-emerald-500">█</span>
          </>
        )}
      </div>

      {/* Input bar */}
      <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-border/40 bg-muted/20 p-2">
        <span className="font-mono text-[12px] text-emerald-500">$</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={running}
          placeholder="Enter command..."
          className="flex-1 bg-transparent font-mono text-[12px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none disabled:opacity-50"
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="submit"
          size="sm"
          className="h-7 gap-1 bg-emerald-600 text-white hover:bg-emerald-600/90"
          disabled={running || !input.trim()}
        >
          <Send className="size-3" />
          Run
        </Button>
      </form>

      {/* Write-command confirmation dialog */}
      <AnimatePresence>
        {pendingWrite && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={() => setPendingWrite(null)}
          >
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              className="max-w-md rounded-lg border border-amber-500/40 bg-background p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" />
                <div className="flex-1">
                  <div className="text-sm font-medium">Confirm write command</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    This command ({pendingWrite.description ?? "write operation"}) modifies the
                    filesystem or git state. Are you sure?
                  </p>
                  <div className="mt-2 rounded-md bg-muted/40 p-2">
                    <code className="text-[11px] font-mono text-foreground">
                      $ {pendingWrite.command}
                    </code>
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7"
                      onClick={() => setPendingWrite(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 gap-1 bg-amber-600 text-white hover:bg-amber-600/90"
                      onClick={() => {
                        executeCommand(pendingWrite.command);
                        setPendingWrite(null);
                      }}
                    >
                      <AlertTriangle className="size-3" />
                      Execute
                    </Button>
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
