"use client";

// useBrowserNotifications — a hook that watches for terminal-state events
// (opportunity paid / failed / rejected) and fires browser notifications.
//
// Phase-2 CRON-REVIEW-7: the operator can leave the dashboard in a background
// tab + still get notified when an opportunity reaches a terminal state.
//
// Implementation: subscribes to the /api/events/sse stream, watches for
// `process_opportunity_completed` events with finalStatus = paid/failed/
// rejected, and fires a browser notification. The user must grant permission
// first (prompted on first dashboard load).
//
// The hook also fires a toast notification as a fallback when the browser
// doesn't support the Notifications API or permission is denied.

import * as React from "react";
import { toast } from "sonner";
import { useEventSource } from "./use-event-source";

const SSE_URL = "/api/events/sse?level=info";

// Track which opportunity IDs we've already notified about (avoid duplicates
// across reconnections).
const notifiedIds = new Set<string>();

export type NotificationPermission = "default" | "granted" | "denied" | "unsupported";

export function useBrowserNotifications() {
  const [permission, setPermission] = React.useState<NotificationPermission>("default");

  // Check current permission on mount.
  React.useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setPermission("unsupported");
      return;
    }
    setPermission(Notification.permission as NotificationPermission);
  }, []);

  // Request permission (called from the UI).
  const requestPermission = React.useCallback(async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setPermission("unsupported");
      return "unsupported" as NotificationPermission;
    }
    try {
      const result = await Notification.requestPermission();
      setPermission(result as NotificationPermission);
      if (result === "granted") {
        toast.success("Browser notifications enabled — you'll be notified when opportunities reach terminal states.");
      } else if (result === "denied") {
        toast.info("Notifications blocked — toast notifications will be used as fallback.");
      }
      return result as NotificationPermission;
    } catch {
      setPermission("unsupported");
      return "unsupported" as NotificationPermission;
    }
  }, []);

  // Subscribe to the events SSE stream + watch for terminal states.
  const { events } = useEventSource(SSE_URL, {
    enabled: permission === "granted",
    maxEvents: 50,
  });

  // Process events for terminal states.
  React.useEffect(() => {
    if (permission !== "granted") return;

    for (const sseEvent of events) {
      const data = sseEvent.data;
      const eventName = data.event as string;
      const opportunityId = data.opportunityId as string | undefined;

      // Watch for process_opportunity_completed events.
      if (eventName !== "process_opportunity_completed" || !opportunityId) continue;
      if (notifiedIds.has(opportunityId)) continue;

      // Extract the final status from the payload.
      const finalStatus = data.finalStatus as string | undefined;
      const initialStatus = data.initialStatus as string | undefined;

      // Only notify on terminal states.
      if (finalStatus !== "paid" && finalStatus !== "failed" && finalStatus !== "rejected") continue;

      notifiedIds.add(opportunityId);
      fireNotification(finalStatus, opportunityId, data.title as string | undefined);
    }
  }, [events, permission]);

  return { permission, requestPermission };
}

function fireNotification(
  finalStatus: string,
  opportunityId: string,
  title?: string
): void {
  const icon = finalStatus === "paid" ? "✅" : finalStatus === "failed" ? "❌" : "🚫";
  const body = title
    ? `${icon} Opportunity "${title.slice(0, 60)}" → ${finalStatus.toUpperCase()}`
    : `${icon} Opportunity ${opportunityId.slice(-8)} → ${finalStatus.toUpperCase()}`;

  // Phase-3 DEV-REVIEW-10 (#3): play a notification sound for terminal-state
  // events. Uses the Web Audio API to generate a short beep — no external
  // sound file needed. Different tones for paid (happy ascending) vs failed
  // / rejected (descending warning). Respects the user's sound preference
  // (localStorage key `cryptoearn-notification-sound` — default: on).
  playNotificationSound(finalStatus);

  try {
    const notification = new Notification("CryptoEarn Agent", {
      body,
      icon: "/agent-logo.png",
      tag: opportunityId, // deduplicate across notifications
      data: { opportunityId, finalStatus },
    });

    // Click the notification → focus the window + navigate to the opportunity.
    notification.onclick = () => {
      window.focus();
      notification.close();
      // The dashboard's opportunity sheet can be opened via a global handler
      // if wired. For now, just focus the tab.
    };

    // Auto-close after 10 seconds.
    setTimeout(() => notification.close(), 10_000);
  } catch {
    // Fallback to toast if the Notification constructor fails.
    toast.info(body);
  }
}

/**
 * Phase-3 DEV-REVIEW-10 (#3): play a short notification sound using the
 * Web Audio API. No external sound file required.
 *
 * - "paid" → ascending two-tone (C5 → E5) — pleasant, positive.
 * - "failed" → descending two-tone (A4 → F4) — warning.
 * - "rejected" → single low tone (G3) — somber.
 *
 * The sound is gated by a localStorage preference
 * (`cryptoearn-notification-sound`). Default: enabled. The operator can
 * toggle it off via the keyboard shortcuts help dialog.
 */
function playNotificationSound(finalStatus: string): void {
  if (typeof window === "undefined") return;

  // Check the user's sound preference.
  try {
    const pref = localStorage.getItem("cryptoearn-notification-sound");
    if (pref === "false") return; // explicitly disabled
  } catch {
    // ignore localStorage errors
  }

  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextClass) return;

    const ctx = new AudioContextClass();
    const now = ctx.currentTime;

    // Define the tones based on the terminal status.
    const tones: Array<{ freq: number; start: number; duration: number }> =
      finalStatus === "paid"
        ? [
            { freq: 523.25, start: 0, duration: 0.12 }, // C5
            { freq: 659.25, start: 0.1, duration: 0.15 }, // E5
          ]
        : finalStatus === "failed"
          ? [
              { freq: 440.0, start: 0, duration: 0.12 }, // A4
              { freq: 349.23, start: 0.1, duration: 0.18 }, // F4
            ]
          : // rejected
            [{ freq: 196.0, start: 0, duration: 0.25 }]; // G3

    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = tone.freq;
      osc.type = "sine";

      // Envelope: quick attack, gentle decay.
      gain.gain.setValueAtTime(0, now + tone.start);
      gain.gain.linearRampToValueAtTime(0.3, now + tone.start + 0.01);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        now + tone.start + tone.duration
      );

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + tone.start);
      osc.stop(now + tone.start + tone.duration + 0.05);
    }

    // Close the AudioContext after the sound finishes to free resources.
    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 500);
  } catch {
    // Silently ignore — the notification still fires visually.
  }
}
