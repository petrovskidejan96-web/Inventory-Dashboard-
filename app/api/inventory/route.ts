import { NextResponse } from "next/server";
import { applyUpdates, loadDoc, resetToSeed, saveDoc, storageConfigured, validateUpdate } from "@/lib/store";
import { spapiConfigured } from "@/lib/spapi";

export const dynamic = "force-dynamic";

export async function GET() {
  const doc = await loadDoc();
  return NextResponse.json({
    doc,
    persistent: storageConfigured(),
    amazon: Object.fromEntries(doc.countries.map((c) => [c.id, c.marketplaceIds.every(spapiConfigured)])),
  });
}

/** Body: { updates: CellUpdate[] } — edits typed into the dashboard. */
export async function PATCH(req: Request) {
  if (!storageConfigured()) {
    return NextResponse.json({ error: "Storage not configured; edits are kept in this browser only." }, { status: 501 });
  }
  const body = (await req.json().catch(() => null)) as { updates?: unknown[] } | null;
  const updates = body?.updates;
  if (!Array.isArray(updates) || !updates.every(validateUpdate)) {
    return NextResponse.json({ error: "Expected { updates: [{ country, id|asin, field, value }] }" }, { status: 400 });
  }
  const doc = await loadDoc();
  const result = applyUpdates(doc, updates, "manual");
  await saveDoc(doc);
  return NextResponse.json({ ...result, doc });
}

/** Body: { action: "reset" } — replace everything with the spreadsheet import. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { action?: string } | null;
  if (body?.action !== "reset") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  if (!storageConfigured()) return NextResponse.json({ error: "Storage not configured" }, { status: 501 });
  return NextResponse.json({ doc: await resetToSeed() });
}
