import type { Child, Country, SupplierItem } from "./types";

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Month to stock only Amazon inventory  =  Amazon / Last 30 days sales  (sheet column I). */
export function monthsAmazon(c: Pick<Child, "amazon" | "last30">): number | null {
  const sales = n(c.last30);
  if (sales <= 0) return null;
  return n(c.amazon) / sales;
}

/** Total pipeline = SUM(Amazon : OTW-2)  (sheet columns C..G). */
export function pipeline(c: Pick<Child, "amazon" | "externalWarehouse" | "receiving" | "otw1" | "otw2">): number {
  return n(c.amazon) + n(c.externalWarehouse) + n(c.receiving) + n(c.otw1) + n(c.otw2);
}

/** Month to stock by the last 30 days  =  SUM(Amazon : OTW-2) / Last 30 days sales  (sheet column J). */
export function monthsTotal(c: Child): number | null {
  const sales = n(c.last30);
  if (sales <= 0) return null;
  return pipeline(c) / sales;
}

/** Same thresholds as the sheet's conditional formatting on columns I and J. */
export function stockLevel(months: number | null): "low" | "mid" | "ok" | "none" {
  if (months === null) return "none";
  if (months < 2) return "low";
  if (months < 4) return "mid";
  return "ok";
}

export function sumChildren(children: Child[]) {
  const t = { amazon: 0, externalWarehouse: 0, receiving: 0, otw1: 0, otw2: 0, last30: 0, sending: 0, futureOrder: 0 };
  for (const c of children) {
    t.amazon += n(c.amazon);
    t.externalWarehouse += n(c.externalWarehouse);
    t.receiving += n(c.receiving);
    t.otw1 += n(c.otw1);
    t.otw2 += n(c.otw2);
    t.last30 += n(c.last30);
    t.sending += n(c.sending);
    t.futureOrder += n(c.futureOrder);
  }
  return t;
}

// ── Supplier Inventory tab ───────────────────────────────────────────────────

/** Rows are matched across tabs by ASIN; items without an ASIN (e.g. floor stoppers) by name. */
export function productKey(p: { asin: string | null; name: string }): string {
  return p.asin ? p.asin : `name:${p.name.toLowerCase().replace(/\bdoor\b/g, "").replace(/\s+/g, " ").trim()}`;
}

/** Per product: Sending Inventory and Future order summed over every marketplace tab. */
export function marketplaceTotals(countries: Country[]) {
  const sending = new Map<string, number>();
  const futureOrder = new Map<string, number>();
  for (const c of countries)
    for (const g of c.groups)
      for (const ch of g.children) {
        const k = productKey(ch);
        sending.set(k, (sending.get(k) ?? 0) + n(ch.sending));
        futureOrder.set(k, (futureOrder.get(k) ?? 0) + n(ch.futureOrder));
      }
  return { sending, futureOrder };
}

/**
 * Doorstoppers (regular / wedge, XL, folding, floor) are produced as single units, so an Amazon
 * "2 Pack" ASIN needs 2 units per pack. Everything else is produced as the pack itself (1).
 */
export function defaultPackSize(groupName: string, itemName: string): number {
  if (!/door\s*stopper|doorstopper|floor\s*stopper|wedge/i.test(`${groupName} ${itemName}`)) return 1;
  const m = itemName.match(/(\d+)\s*-?\s*pack/i);
  return m ? Math.max(1, Number(m[1])) : 1;
}

export function packSizeOf(item: SupplierItem): number {
  const p = item.packSize;
  return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : 1;
}

/** New Order from Supplier All MP = SUM(Future order, all MP) × units per pack. */
export function supplierNewOrder(item: SupplierItem, futureOrderAllMp: number): number {
  return futureOrderAllMp * packSizeOf(item);
}

/** Total Inventory Supplier = Ready + Under production − Sending Inventory (all MP) × units per pack. */
export function supplierTotal(item: SupplierItem, sendingAllMp: number): number {
  return n(item.ready) + n(item.underProduction) - sendingAllMp * packSizeOf(item);
}

/**
 * Doorstopper ASINs that differ only by pack size (CHROME 1/2/4/6/10 Pack…) are made from the same
 * single units, so their supplier stock is one shared pool. Everything else is its own pool.
 */
export function poolKeyOf(groupName: string, item: SupplierItem): string {
  if (!/door\s*stopper|doorstopper|floor\s*stopper|wedge/i.test(`${groupName} ${item.name}`)) return `item:${item.id}`;
  const base = item.name
    .replace(/\(?\s*\d+\s*-?\s*pack\s*\)?/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return `pool:${groupName.toLowerCase()}|${base}`;
}

export interface SupplierPool {
  key: string;
  members: SupplierItem[];
  /** Ready + Under production, single units, whole pool. */
  units: number;
  /** Sending Inventory (all MP) × units per pack, whole pool. */
  sendingUnits: number;
  /** Total Inventory Supplier for the pool. */
  total: number;
}

export function supplierPools(doc: { countries: Country[]; supplier?: { groups: { name: string; children: SupplierItem[] }[] } }) {
  const t = marketplaceTotals(doc.countries);
  const byKey = new Map<string, SupplierPool>();
  const ofItem = new Map<string, SupplierPool>();
  for (const g of doc.supplier?.groups ?? [])
    for (const it of g.children) {
      const key = poolKeyOf(g.name, it);
      let pool = byKey.get(key);
      if (!pool) byKey.set(key, (pool = { key, members: [], units: 0, sendingUnits: 0, total: 0 }));
      pool.members.push(it);
      pool.units += n(it.ready) + n(it.underProduction);
      pool.sendingUnits += (t.sending.get(productKey(it)) ?? 0) * packSizeOf(it);
      ofItem.set(it.id, pool);
    }
  for (const p of byKey.values()) p.total = p.units - p.sendingUnits;
  return { pools: [...byKey.values()], ofItem, totals: t };
}

/** Sum of Total Inventory Supplier over the distinct pools the items belong to. */
export function poolTotalOf(items: SupplierItem[], ofItem: Map<string, SupplierPool>): number {
  const seen = new Set<SupplierPool>();
  for (const it of items) {
    const p = ofItem.get(it.id);
    if (p) seen.add(p);
  }
  return [...seen].reduce((s, p) => s + p.total, 0);
}
