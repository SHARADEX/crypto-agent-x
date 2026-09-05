// Next.js proxy — enforces public read-only mode (Phase-2 P3-4).
//
// When PUBLIC_READ_ONLY=true, all mutating requests to /api/* are blocked
// unless the request carries the X-Operator-Token header.
//
// NOTE: Next.js 16 replaced the `middleware` convention with `proxy`.
// See https://nextjs.org/docs/messages/middleware-to-proxy

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const READ_ONLY_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const ALWAYS_ALLOWED = [/^\/api\/public\//];

export default function proxy(req: NextRequest) {
  const method = req.method.toUpperCase();

  // Only check mutating methods.
  if (!READ_ONLY_METHODS.has(method)) {
    return NextResponse.next();
  }

  const path = req.nextUrl.pathname;

  // Always-allowed paths.
  if (ALWAYS_ALLOWED.some((re) => re.test(path))) {
    return NextResponse.next();
  }

  // Only enforce when the env flag is set.
  if (process.env.PUBLIC_READ_ONLY !== "true") {
    return NextResponse.next();
  }

  // Operator token bypass.
  const operatorToken = process.env.OPERATOR_TOKEN;
  if (operatorToken) {
    const sent = req.headers.get("x-operator-token");
    if (sent && sent === operatorToken) {
      return NextResponse.next();
    }
  }

  return NextResponse.json(
    {
      error:
        "Public read-only mode is active. Mutating actions require the X-Operator-Token header. Set PUBLIC_READ_ONLY=false or remove the env var to disable.",
      status: 403,
      path,
      method,
    },
    { status: 403 }
  );
}

export const config = {
  matcher: ["/api/:path*"],
};
