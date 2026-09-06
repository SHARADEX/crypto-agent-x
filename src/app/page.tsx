"use client";

import dynamic from "next/dynamic";

// Home — the ONLY user-visible route.
//
// This is a CLIENT component wrapper that loads the dashboard with
// SSR disabled. This prevents the hydration mismatch from Radix UI
// (which generates different IDs on server vs client).

const PageClient = dynamic(
  () => import("@/components/dashboard/page-client"),
  { ssr: false }
);

export default function Home() {
  return <PageClient />;
}
