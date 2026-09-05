"use client";

// TokenInput — a secure one-time token input dialog.
//
// The operator pastes a GitHub PAT (or any secret token) here. The token
// is held ONLY in React state (in-memory) — it is NEVER written to
// localStorage, sessionStorage, cookies, or any persistent storage.
//
// When the terminal sends a command, it includes this token as a Bearer
// header. The terminal API uses it for the current request only.
//
// The token is cleared when:
//   - The operator clicks "Clear Token"
//   - The page is refreshed (React state is lost)
//   - The operator closes the dashboard tab
//
// This means the token is never on disk, never in git, never in logs.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Key, Eye, EyeOff, Trash2, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface TokenInputProps {
  /** The current token value (held in parent's React state). */
  token: string;
  /** Callback to set the token in the parent's state. */
  onTokenChange: (token: string) => void;
}

export function TokenInput({ token, onTokenChange }: TokenInputProps) {
  const [showInput, setShowInput] = React.useState(false);
  const [showToken, setShowToken] = React.useState(false);
  const [tempToken, setTempToken] = React.useState("");

  const handleSave = () => {
    onTokenChange(tempToken.trim());
    setTempToken("");
    setShowInput(false);
  };

  const handleClear = () => {
    onTokenChange("");
    setTempToken("");
    setShowInput(false);
  };

  if (token) {
    // Token is set — show a compact "token active" indicator.
    return (
      <div className="flex items-center gap-1.5">
        <div className="flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5">
          <Key className="size-3 text-emerald-500" />
          <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
            Token active
          </span>
          <span className="text-[9px] text-emerald-600/60 dark:text-emerald-400/60">
            (in-memory)
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[10px] text-muted-foreground"
          onClick={handleClear}
          title="Clear the token from memory"
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    );
  }

  if (!showInput) {
    // No token — show a "Set Token" button.
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-2 text-[10px] text-muted-foreground"
        onClick={() => setShowInput(true)}
        title="Set a temporary token for git push / authenticated commands (held in memory only — never saved to disk)"
      >
        <Key className="size-3" />
        Set Token
      </Button>
    );
  }

  // Show the input dialog.
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
        onClick={() => setShowInput(false)}
      >
        <motion.div
          initial={{ scale: 0.95 }}
          animate={{ scale: 1 }}
          exit={{ scale: 0.95 }}
          className="max-w-md rounded-lg border border-border/60 bg-background p-4 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-3 flex items-center gap-2">
            <Key className="size-4 text-emerald-500" />
            <span className="text-sm font-medium">Set Temporary Token</span>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Paste your GitHub token (or any secret). It will be held in memory
            only — never saved to disk, localStorage, or cookies. It will be
            lost when you refresh or close this page.
          </p>
          <div className="relative">
            <Input
              type={showToken ? "text" : "password"}
              value={tempToken}
              onChange={(e) => setTempToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && tempToken.trim()) handleSave();
                if (e.key === "Escape") setShowInput(false);
              }}
              placeholder="ghp_..."
              className="pr-10 font-mono text-xs"
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowToken((v) => !v)}
              tabIndex={-1}
            >
              {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => setShowInput(false)}
            >
              <X className="size-3" />
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 gap-1 bg-emerald-600 text-white hover:bg-emerald-600/90"
              onClick={handleSave}
              disabled={!tempToken.trim()}
            >
              <Check className="size-3" />
              Use Token
            </Button>
          </div>
          <div className="mt-2 rounded-md bg-amber-500/10 p-2 text-[10px] text-amber-700 dark:text-amber-300">
            ⚠ This token gives access to your GitHub account. Only paste it
            here if you trust this dashboard. Clear it after use.
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
