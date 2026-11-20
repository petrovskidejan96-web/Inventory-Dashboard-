/**
 * Proboxx → OTW-1 / OTW-2.
 *
 * Proboxx doesn't publish public API docs, so this adapter is written against a generic
 * "list shipments" endpoint and reads the most common field names. Once you have the real
 * response format, only `normalize()` below needs adjusting.
 *
 * Rule used: for each ASIN and destination country, open shipments are sorted by ETA.
 *   OTW-1 = units in the shipment arriving first
 *   OTW-2 = units in all later shipments
 *
 * Env: PROBOXX_API_URL (full URL of the shipments endpoint), PROBOXX_API_KEY,
 *      PROBOXX_AUTH_HEADER (optional, default "Authorization: Bearer <key>").
 *
 * Alternative without code changes: have Proboxx (or Zapier/Make) POST to /api/ingest.
 */
import type { CellUpdate, Country } from "./types";

export function proboxxConfigured(): boolean {
  return Boolean(process.env.PROBOXX_API_URL && process.env.PROBOXX_API_KEY);
}

interface Shipment {
  country: string; // US | UK | EU | CA
  eta: number; // epoch ms (Infinity when unknown)
  delivered: boolean;
  lines: { asin?: string; sku?: string; units: number }[];
}

type Json = Record<string, unknown>;
const pick = (o: Json, ...keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null);

const COUNTRY_ALIASES: Record<string, Country["id"]> = {
  US: "US", USA: "US", "UNITED STATES": "US",
  CA: "CA", CANADA: "CA",
  UK: "UK", GB: "UK", "UNITED KINGDOM": "UK",
  EU: "EU", DE: "EU", FR: "EU", IT: "EU", ES: "EU", GERMANY: "EU",
};

function normalize(raw: unknown): Shipment[] {
  const list = (Array.isArray(raw) ? raw : (pick(raw as Json, "shipments", "data", "items", "results") as unknown[])) ?? [];
  return list.map((s) => {
    const o = s as Json;
    const status = String(pick(o, "status", "state", "shipmentStatus") ?? "").toLowerCase();
    const eta = Date.parse(String(pick(o, "eta", "estimatedArrival", "estimated_arrival", "arrivalDate", "eta_date") ?? ""));
    const dest = String(pick(o, "destinationCountry", "destination_country", "country", "destination") ?? "").toUpperCase();
    const lines = ((pick(o, "items", "lines", "products", "cargo") as Json[]) ?? []).map((l) => ({
      asin: pick(l, "asin", "ASIN") as string | undefined,
      sku: pick(l, "sku", "SKU", "sellerSku", "seller_sku") as string | undefined,
      units: Number(pick(l, "units", "quantity", "qty", "totalUnits", "total_units") ?? 0),
    }));
    return {
      country: COUNTRY_ALIASES[dest] ?? dest,
      eta: Number.isNaN(eta) ? Infinity : eta,
      delivered: /deliver|received|closed|complete/.test(status),
      lines,
    };
  });
}

export async function proboxxOtwUpdates(asinBySku: Map<string, string>): Promise<CellUpdate[]> {
  const header = process.env.PROBOXX_AUTH_HEADER || "Authorization";
  const value = header === "Authorization" ? `Bearer ${process.env.PROBOXX_API_KEY}` : process.env.PROBOXX_API_KEY!;
  const res = await fetch(process.env.PROBOXX_API_URL!, { headers: { [header]: value, accept: "application/json" } });
  if (!res.ok) throw new Error(`Proboxx API failed: ${res.status} ${await res.text()}`);
  const shipments = normalize(await res.json())
    .filter((s) => !s.delivered)
    .sort((a, b) => a.eta - b.eta);

  // country → asin → units per shipment in ETA order
  const perAsin = new Map<string, number[]>();
  for (const s of shipments) {
    for (const l of s.lines) {
      const asin = l.asin ?? (l.sku ? asinBySku.get(l.sku) : undefined);
      if (!asin || !l.units) continue;
      const key = `${s.country}|${asin}`;
      perAsin.set(key, [...(perAsin.get(key) ?? []), l.units]);
    }
  }
  const updates: CellUpdate[] = [];
  for (const [key, units] of perAsin) {
    const [country, asin] = key.split("|") as [Country["id"], string];
    updates.push({ country, asin, field: "otw1", value: units[0] });
    updates.push({ country, asin, field: "otw2", value: units.slice(1).reduce((a, b) => a + b, 0) });
  }
  return updates;
}
