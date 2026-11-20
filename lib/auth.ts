/** Shared auth checks. Works in both the Edge middleware and Node route handlers. */

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function passwordConfigured(): boolean {
  return Boolean(process.env.DASHBOARD_PASSWORD);
}

/** Browser access: HTTP Basic auth with DASHBOARD_USER / DASHBOARD_PASSWORD. Open if no password is set. */
export function hasBasicAuth(headers: Headers): boolean {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return true;
  const user = process.env.DASHBOARD_USER || "strongest";
  const header = headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const idx = decoded.indexOf(":");
    return safeEqual(decoded.slice(0, idx), user) && safeEqual(decoded.slice(idx + 1), password);
  } catch {
    return false;
  }
}

function bearer(headers: Headers): string | null {
  const header = headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

/** Machine access (Claude via MCP, scripts, Zapier, …): Authorization: Bearer INGEST_TOKEN. */
export function hasIngestToken(headers: Headers): boolean {
  const token = process.env.INGEST_TOKEN;
  const given = bearer(headers);
  return Boolean(token && given && safeEqual(given, token));
}

/** Vercel Cron sends Authorization: Bearer CRON_SECRET. */
export function hasCronSecret(headers: Headers): boolean {
  const secret = process.env.CRON_SECRET;
  const given = bearer(headers);
  return Boolean(secret && given && safeEqual(given, secret));
}
