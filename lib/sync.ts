import { applyUpdates } from "./store";
import {
  awdAvailableByAsin,
  fbaInventory,
  readBusinessReport,
  requestBusinessReport,
  spapiConfigured,
} from "./spapi";
import { proboxxConfigured, proboxxOtwUpdates } from "./proboxx";
import type { CellUpdate, Country, InventoryDoc, NumericField } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function asinsOf(country: Country): string[] {
  const set = new Set<string>();
  for (const g of country.groups) for (const c of g.children) if (c.asin) set.add(c.asin);
  return [...set];
}

/** One update per ASIN in the country; ASINs missing from `values` are set to 0. */
function fill(country: Country, field: NumericField, values: Map<string, number>): CellUpdate[] {
  return asinsOf(country).map((asin) => ({ country: country.id, asin, field, value: values.get(asin) ?? 0 }));
}

/**
 * Refresh one country:
 *   Amazon             ← FBA available + FC processing
 *   External Warehouse ← AWD available (US only)
 *   Last 30 days sales ← Business Report, Units Ordered (summed over the country's marketplaces)
 *   OTW-1 / OTW-2      ← Proboxx (when PROBOXX_* is configured)
 *
 * Amazon can take a few minutes to build a Business Report. If it isn't ready before `deadline`,
 * the report ids are saved and the next sync picks them up.
 */
export async function syncCountry(doc: InventoryDoc, countryId: Country["id"], deadline: number) {
  const country = doc.countries.find((c) => c.id === countryId);
  if (!country) throw new Error(`Unknown country ${countryId}`);
  const notes: string[] = [];
  const updates: CellUpdate[] = [];
  const proboxxUpdates: CellUpdate[] = [];

  const missing = country.marketplaceIds.filter((m) => !spapiConfigured(m));
  if (missing.length) {
    country.sync = { ...country.sync, status: "error", message: `Amazon credentials for ${country.label} are not set up yet.` };
    return { error: country.sync.message };
  }

  // 1) FBA stock (for Pan-EU the first marketplace, DE, holds the shared pool)
  const fba = await fbaInventory(country.marketplaceIds[0]);
  updates.push(...fill(country, "amazon", fba.stockByAsin));
  notes.push(`stock for ${fba.stockByAsin.size} ASINs`);

  // 2) AWD → External Warehouse (US only)
  if (countryId === "US") {
    const awd = await awdAvailableByAsin(fba.asinBySku);
    updates.push(...fill(country, "externalWarehouse", awd.byAsin));
    notes.push(`AWD for ${awd.byAsin.size} ASINs`);
    if (awd.unmappedSkus.length) notes.push(`AWD SKUs without an FBA match: ${awd.unmappedSkus.join(", ")}`);
  }

  // 3) Business Reports → Last 30 days sales
  const reports: Record<string, string> = { ...(country.sync?.pendingReports ?? {}) };
  for (const mkt of country.marketplaceIds) if (!reports[mkt]) reports[mkt] = await requestBusinessReport(mkt);

  const units = new Map<string, number>();
  const done = new Set<string>();
  let failed: string | null = null;
  while (done.size < country.marketplaceIds.length && !failed && Date.now() < deadline) {
    for (const mkt of country.marketplaceIds) {
      if (done.has(mkt)) continue;
      const r = await readBusinessReport(mkt, reports[mkt]);
      if (r.state === "failed") failed = r.message;
      if (r.state === "done") {
        for (const [asin, u] of r.unitsByAsin) units.set(asin, (units.get(asin) ?? 0) + u);
        done.add(mkt);
      }
    }
    if (done.size < country.marketplaceIds.length && !failed) await sleep(15_000);
  }
  const salesReady = done.size === country.marketplaceIds.length;
  if (salesReady) {
    updates.push(...fill(country, "last30", units));
    notes.push(`30-day sales for ${units.size} ASINs`);
  }

  // 4) Proboxx → OTW-1 / OTW-2
  if (proboxxConfigured()) {
    try {
      const otw = (await proboxxOtwUpdates(fba.asinBySku)).filter((u) => u.country === countryId);
      const touched = new Set(otw.map((u) => u.asin));
      for (const asin of asinsOf(country)) {
        if (touched.has(asin)) continue; // nothing on the water any more → 0
        otw.push({ country: countryId, asin, field: "otw1", value: 0 }, { country: countryId, asin, field: "otw2", value: 0 });
      }
      proboxxUpdates.push(...otw);
      notes.push(`Proboxx shipments for ${touched.size} ASINs`);
    } catch (err) {
      notes.push(`Proboxx failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  applyUpdates(doc, updates, "amazon");
  applyUpdates(doc, proboxxUpdates, "proboxx");
  country.sync = {
    lastSyncedAt: new Date().toISOString(),
    status: failed ? "error" : salesReady ? "ok" : "partial",
    message: failed
      ? `Updated ${notes.join(", ")}. ${failed} — sales not updated.`
      : salesReady
        ? `Updated ${notes.join(", ")}.`
        : `Updated ${notes.join(", ")}. Amazon is still building the Business Report — sync again in a few minutes for sales.`,
    pendingReports: salesReady || failed ? undefined : reports,
  };
  return { notes, salesReady };
}
