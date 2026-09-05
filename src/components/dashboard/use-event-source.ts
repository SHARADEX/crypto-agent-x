"use client";

// useEventSource — a React hook for subscribing to Server-Sent Events (SSE).
//
// Phase-2 P3-3: replaces polling on the Events tab with a persistent SSE
// connection. The hook:
//   - Opens an EventSource connection to the given URL.
//   - Collects events into a buffer (capped at maxEvents).
//   - Tracks connection status (connecting | open | closed).
//   - Auto-reconnects on disconnect (EventSource does this natively, but
//     we expose the status so the UI can show a "reconnecting…" indicator).
//   - Cleans up on unmount or when the URL changes.

import * as React from "react";

export interface SSEEvent {
  id: string;
  data: Record<string, unknown>;
}

export type SSEStatus = "idle" | "connecting" | "open" | "closed";

export interface UseEventSourceOpts {
  maxEvents?: number;
  // When false, the hook doesn't open a connection (used for pausing).
  enabled?: boolean;
}

export interface UseEventSourceResult {
  events: SSEEvent[];
  status: SSEStatus;
  lastEventId: string | null;
  clear: () => void;
}

export function useEventSource(
  url: string | null,
  opts: UseEventSourceOpts = {}
): UseEventSourceResult {
  const { maxEvents = 200, enabled = true } = opts;
  const [events, setEvents] = React.useState<SSEEvent[]>([]);
  const [status, setStatus] = React.useState<SSEStatus>("idle");
  const [lastEventId, setLastEventId] = React.useState<string | null>(null);
  const eventSourceRef = React.useRef<EventSource | null>(null);

  React.useEffect(() => {
    if (!enabled || !url) {
      setStatus("idle");
      return;
    }

    setStatus("connecting");
    let cancelled = false;

    try {
      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.onopen = () => {
        if (!cancelled) setStatus("open");
      };

      es.onmessage = (ev) => {
        if (cancelled) return;
        try {
          const data = JSON.parse(ev.data) as Record<string, unknown>;
          const id = (data.id as string) ?? ev.lastEventId ?? crypto.randomUUID?.() ?? String(Date.now());
          setLastEventId(id);
          setEvents((prev) => {
            const next = [...prev, { id, data }];
            // Cap the buffer.
            if (next.length > maxEvents) {
              return next.slice(next.length - maxEvents);
            }
            return next;
          });
        } catch {
          // ignore parse errors (heartbeats, comments)
        }
      };

      es.onerror = () => {
        if (!cancelled) setStatus("closed");
        // EventSource auto-reconnects; we just update the status.
      };

      return () => {
        cancelled = true;
        es.close();
        eventSourceRef.current = null;
        setStatus("idle");
      };
    } catch {
      if (!cancelled) setStatus("closed");
      return;
    }
  }, [url, enabled, maxEvents]);

  const clear = React.useCallback(() => {
    setEvents([]);
    setLastEventId(null);
  }, []);

  return { events, status, lastEventId, clear };
}
