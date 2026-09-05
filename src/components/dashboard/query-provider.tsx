"use client";

// QueryProvider — wraps the dashboard in a TanStack Query client so every
// tab can call useQuery + useMutation with sensible defaults. The client
// is created once per browser session and persisted across reloads.

import * as React from "react";
import {
  QueryClient,
  QueryClientProvider,
  type QueryClientConfig,
} from "@tanstack/react-query";

const config: QueryClientConfig = {
  defaultOptions: {
    queries: {
      // The dashboard polls every tab on its own interval, so don't refetch
      // on window focus — it would just add noise.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 4_000,
    },
    mutations: {
      retry: 0,
    },
  },
};

export function QueryProvider({ children }: { children: React.ReactNode }) {
  // useState ensures the client is stable across re-renders but recreated
  // if the React tree is fully remounted (per TanStack best practices).
  const [client] = React.useState(() => new QueryClient(config));
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
