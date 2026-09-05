"use client";

// NotificationPermissionBanner — a dismissible banner that prompts the
// operator to enable browser notifications for terminal-state alerts.
//
// Phase-2 CRON-REVIEW-7: shows once (localStorage flag) at the top of the
// dashboard when the user hasn't granted notification permission. Has
// "Enable" + "Dismiss" buttons. When enabled, fires the permission request
// + the useBrowserNotifications hook starts watching for terminal states.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, BellOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBrowserNotifications } from "./use-browser-notifications";

const DISMISS_KEY = "cryptoearn-notification-banner-dismissed";

export function NotificationPermissionBanner() {
  const { permission, requestPermission } = useBrowserNotifications();
  const [dismissed, setDismissed] = React.useState(false);

  // Check localStorage on mount.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const d = localStorage.getItem(DISMISS_KEY);
      if (d) setDismissed(true);
    } catch {
      // ignore
    }
  }, []);

  const dismiss = React.useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "true");
    } catch {
      // ignore
    }
  }, []);

  // Don't show if: dismissed, permission already granted, permission denied,
  // or notifications unsupported.
  const visible =
    !dismissed &&
    permission !== "granted" &&
    permission !== "denied" &&
    permission !== "unsupported";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.25 }}
          className="border-b border-emerald-500/20 bg-gradient-to-r from-emerald-500/10 to-teal-500/5"
        >
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-2 px-4 py-2">
            <div className="flex items-center gap-2">
              <Bell className="size-4 text-emerald-600 dark:text-emerald-400" />
              <span className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Stay informed.</span>{" "}
                Get notified when opportunities are paid, fail, or get rejected —
                even when this tab is in the background.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={dismiss}
                className="focus-ring h-7 px-2 text-[11px]"
                aria-label="Dismiss notification banner"
              >
                <BellOff className="size-3" />
                <span className="hidden sm:inline">Not now</span>
              </Button>
              <Button
                size="sm"
                onClick={() => requestPermission()}
                className="focus-ring h-7 bg-emerald-600 px-3 text-[11px] text-white hover:bg-emerald-600/90"
                aria-label="Enable browser notifications"
              >
                <Bell className="size-3" />
                Enable
              </Button>
              <button
                onClick={dismiss}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Close banner"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
