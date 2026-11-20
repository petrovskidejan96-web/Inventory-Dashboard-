import { NextResponse, type NextRequest } from "next/server";
import { hasBasicAuth, hasCronSecret, hasIngestToken } from "./lib/auth";

/**
 * Password-protects the dashboard. Machine endpoints (/api/ingest, /api/mcp, /api/sync)
 * may instead use their bearer tokens, which the route handlers check themselves.
 */
export function middleware(req: NextRequest) {
  if (hasBasicAuth(req.headers)) return NextResponse.next();

  const path = req.nextUrl.pathname;
  const machinePath =
    path.startsWith("/api/ingest") || path.startsWith("/api/mcp") || path.startsWith("/api/sync");
  if (machinePath && (hasIngestToken(req.headers) || hasCronSecret(req.headers))) {
    return NextResponse.next();
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Inventory Dashboard", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
