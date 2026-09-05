"use client";

// FocusMode — a distraction-free monitoring mode.
//
// Phase-2 CRON-REVIEW-7: when activated, the header + footer are hidden and
// the content area expands to fill the viewport. The operator gets a clean,
// full-screen view of the current tab — useful for monitoring on a second
// display or during a presentation.
//
// Toggled via the `F` keyboard shortcut or a button in the header.
// A small floating "Exit Focus" button appears in the corner so the
// operator can always get back to the full UI.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Minimize2, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "cryptoearn-focus-mode";

interface FocusModeContextValue {
  isFocusMode: boolean;
  toggle: () => void;
}

const FocusModeContext = React.createContext<FocusModeContextValue>({
  isFocusMode: false,
  toggle: () => {},
});

export function useFocusMode() {
  return React.useContext(FocusModeContext);
}

export function FocusModeProvider({ children }: { children: React.ReactNode }) {
  const [isFocusMode, setIsFocusMode] = React.useState(false);

  // Restore from localStorage on mount.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "true") setIsFocusMode(true);
    } catch {
      // ignore
    }
  }, []);

  const toggle = React.useCallback(() => {
    setIsFocusMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const value = React.useMemo(
    () => ({ isFocusMode, toggle }),
    [isFocusMode, toggle]
  );

  return (
    <FocusModeContext.Provider value={value}>
      {children}
    </FocusModeContext.Provider>
  );
}

/**
 * The floating "Exit Focus" button — shown only when focus mode is active.
 */
export function FocusModeExitButton() {
  const { isFocusMode, toggle } = useFocusMode();

  return (
    <AnimatePresence>
      {isFocusMode && (
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.2 }}
          className="fixed bottom-4 left-4 z-50"
        >
          <Button
            size="sm"
            variant="outline"
            onClick={toggle}
            className="focus-ring bg-background/95 shadow-lg backdrop-blur"
            aria-label="Exit focus mode"
          >
            <Minimize2 className="size-3" />
            <span className="hidden sm:inline">Exit Focus</span>
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * A header button to toggle focus mode. Rendered in the header.
 */
export function FocusModeToggleButton() {
  const { isFocusMode, toggle } = useFocusMode();

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={toggle}
      className="focus-ring"
      aria-label={isFocusMode ? "Exit focus mode" : "Enter focus mode"}
      title={isFocusMode ? "Exit focus mode (F)" : "Enter focus mode (F)"}
    >
      {isFocusMode ? (
        <Minimize2 className="size-3" />
      ) : (
        <Maximize2 className="size-3" />
      )}
      <span className="hidden md:inline">Focus</span>
    </Button>
  );
}
