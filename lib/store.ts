import { Redis } from "@upstash/redis";
import seed from "@/data/inventory.seed.json";
import type { CellSource, CellUpdate, InventoryDoc } from "./types";
import { NUMERIC_FIELDS, SUPPLIER_NUMBER_FIELDS, SUPPLIER_TEXT_FIELDS } from "./types";

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
  if (stored) return migrate(stored);
  const fresh = seedDoc();
  await r.set(KEY, fresh);
  return fresh;
}

/** Bring data saved by an older version up to date without losing edits. */
function migrate(doc: InventoryDoc): InventoryDoc {
  const fresh = seedDoc();
  const seedChildren = new Map(
    fresh.countries.flatMap((c) => c.groups.flatMap((g) => g.children.map((ch) => [ch.id, ch] as const))),
  );
  for (const c of doc.countries)
    for (const g of c.groups)
      for (const ch of g.children) {
        const s = seedChildren.get(ch.id);
        if (ch.sending === undefined) ch.sending = s?.sending ?? null;
        if (ch.futureOrder === undefined) ch.futureOrder = s?.futureOrder ?? null;
      }
  if (!doc.supplier) doc.supplier = fresh.supplier;
  return doc;
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
  if (typeof x.country !== "string" || !(typeof x.id === "string" || typeof x.asin === "string")) return false;
  if (typeof x.field !== "string") return false;
  const isNumber = x.value === null || (typeof x.value === "number" && Number.isFinite(x.value));
  if (x.country === "SUPPLIER") {
    if ((SUPPLIER_NUMBER_FIELDS as readonly string[]).includes(x.field)) return isNumber;
    if ((SUPPLIER_TEXT_FIELDS as readonly string[]).includes(x.field))
      return x.value === null || (typeof x.value === "string" && x.value.length <= 2000);
    return false;
  }
  return (NUMERIC_FIELDS as readonly string[]).includes(x.field) && isNumber;
}

/** Apply cell edits in place. An ASIN update hits every row with that ASIN on that tab. */
export function applyUpdates(doc: InventoryDoc, updates: CellUpdate[], source: CellSource) {
  const at = new Date().toISOString();
  let applied = 0;
  const notFound: CellUpdate[] = [];
  for (const u of updates) {
    let hit = false;
    const groups =
      u.country === "SUPPLIER"
        ? doc.supplier?.groups ?? []
        : doc.countries.find((c) => c.id === u.country)?.groups ?? [];
    for (const g of groups) {
      for (const row of g.children) {
        const match = u.id ? row.id === u.id : row.asin === u.asin;
        if (!match) continue;
        const value = typeof u.value === "string" ? u.value.trim() || null : u.value;
        (row as unknown as Record<string, unknown>)[u.field] = value;
        row.meta = { ...(row.meta ?? {}), [u.field]: { source, at } };
        hit = true;
        applied++;
      }
    }
    if (!hit) notFound.push(u);
  }
  return { applied, notFound };
}
