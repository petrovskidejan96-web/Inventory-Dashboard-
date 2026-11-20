import type { Child } from "./types";

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
  const t = { amazon: 0, externalWarehouse: 0, receiving: 0, otw1: 0, otw2: 0, last30: 0 };
  for (const c of children) {
    t.amazon += n(c.amazon);
    t.externalWarehouse += n(c.externalWarehouse);
    t.receiving += n(c.receiving);
    t.otw1 += n(c.otw1);
    t.otw2 += n(c.otw2);
    t.last30 += n(c.last30);
  }
  return t;
}
