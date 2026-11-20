import { NextResponse } from "next/server";
import { loadDoc, saveDoc, storageConfigured } from "@/lib/store";
import { syncCountry } from "@/lib/sync";
import type { Country } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const COUNTRIES: Country["id"][] = ["US", "CA", "UK", "EU"];

async function run(req: Request) {
  if (!storageConfigured()) {
    return NextResponse.json({ error: "Connect storage (Upstash Redis) before syncing from Amazon." }, { status: 501 });
  }
  const param = new URL(req.url).searchParams.get("country") as Country["id"] | null;
  const targets = param ? [param] : COUNTRIES;
  if (!targets.every((t) => COUNTRIES.includes(t))) {
    return NextResponse.json({ error: `country must be one of ${COUNTRIES.join(", ")}` }, { status: 400 });
  }

  const deadline = Date.now() + (maxDuration - 25) * 1000;
  const doc = await loadDoc();
  const results: Record<string, unknown> = {};
  for (const id of targets) {
    try {
      results[id] = await syncCountry(doc, id, deadline);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const c = doc.countries.find((x) => x.id === id);
      if (c) c.sync = { ...c.sync, status: "error", message };
      results[id] = { error: message };
    }
    await saveDoc(doc); // keep progress even if a later country fails
  }
  return NextResponse.json({ results, doc });
}

export const GET = run; // Vercel Cron
export const POST = run; // "Sync from Amazon" button
