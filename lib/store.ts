import { Redis } from "@upstash/redis";
import seed from "@/data/inventory.seed.json";
import type { CellSource, CellUpdate, InventoryDoc } from "./types";
import { NUMERIC_FIELDS } from "./types";

const KEY = "inventory:v1";

function redis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export function storageConfigured(): boolean {
  return redis() !== null;
}

function seedDoc(): InventoryDoc {
  return structuredClone(seed) as unknown as InventoryDoc;
}

export async function loadDoc(): Promise<InventoryDoc> {
  const r = redis();
  if (!r) return seedDoc();
  const stored = await r.get<InventoryDoc>(KEY);
  if (stored) return stored;
  const fresh = seedDoc();
  await r.set(KEY, fresh);
  return fresh;
}

export async function saveDoc(doc: InventoryDoc): Promise<void> {
  const r = redis();
  if (!r) throw new Error("Storage is not configured (set KV_REST_API_URL and KV_REST_API_TOKEN).");
  doc.updatedAt = new Date().toISOString();
  await r.set(KEY, doc);
}

/** Replace stored data with the spreadsheet import (used by "Reset to sheet"). */
export async function resetToSeed(): Promise<InventoryDoc> {
  const fresh = seedDoc();
  await saveDoc(fresh);
  return fresh;
}

export function validateUpdate(u: unknown): u is CellUpdate {
  if (!u || typeof u !== "object") return false;
  const x = u as Record<string, unknown>;
  return (
    typeof x.country === "string" &&
    (typeof x.id === "string" || typeof x.asin === "string") &&
    typeof x.field === "string" &&
    (NUMERIC_FIELDS as readonly string[]).includes(x.field) &&
    (x.value === null || (typeof x.value === "number" && Number.isFinite(x.value)))
  );
}

/** Apply cell edits in place. An ASIN update hits every row with that ASIN in the country. */
export function applyUpdates(doc: InventoryDoc, updates: CellUpdate[], source: CellSource) {
  const at = new Date().toISOString();
  let applied = 0;
  const notFound: CellUpdate[] = [];
  for (const u of updates) {
    const country = doc.countries.find((c) => c.id === u.country);
    let hit = false;
    for (const g of country?.groups ?? []) {
      for (const child of g.children) {
        const match = u.id ? child.id === u.id : child.asin === u.asin;
        if (!match) continue;
        child[u.field] = u.value;
        child.meta = { ...(child.meta ?? {}), [u.field]: { source, at } };
        hit = true;
        applied++;
      }
    }
    if (!hit) notFound.push(u);
  }
  return { applied, notFound };
}
