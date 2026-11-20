import { NextResponse } from "next/server";
import { hasBasicAuth, hasIngestToken } from "@/lib/auth";
import { applyUpdates, loadDoc, saveDoc, storageConfigured, validateUpdate } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Push numbers from any other system (3PL warehouse export, freight forwarder, Zapier, a script…).
 *
 *   curl -X POST https://<your-app>/api/ingest \
 *     -H "Authorization: Bearer $INGEST_TOKEN" -H "content-type: application/json" \
 *     -d '{"updates":[{"country":"US","asin":"B08958WBQN","field":"externalWarehouse","value":2700}]}'
 */
export async function POST(req: Request) {
  if (!hasIngestToken(req.headers) && !(process.env.DASHBOARD_PASSWORD && hasBasicAuth(req.headers))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!storageConfigured()) return NextResponse.json({ error: "Storage not configured" }, { status: 501 });
  const body = (await req.json().catch(() => null)) as { updates?: unknown[] } | null;
  const updates = body?.updates;
  if (!Array.isArray(updates) || !updates.every(validateUpdate)) {
    return NextResponse.json({ error: "Expected { updates: [{ country, id|asin, field, value }] }" }, { status: 400 });
  }
  const doc = await loadDoc();
  const result = applyUpdates(doc, updates, "api");
  await saveDoc(doc);
  return NextResponse.json(result);
}
