/**
 * Minimal Amazon Selling Partner API client (LWA refresh-token flow, no AWS signing needed).
 * Docs: https://developer-docs.amazon.com/sp-api/
 *
 * Column mapping (as specified by Strongest Home):
 *   Amazon             = FBA fulfillable ("Available") + FC Processing units, no inbound
 *   External Warehouse = AWD available units (US only)
 *   Last 30 days sales = Business Reports → Units Ordered per child ASIN (GET_SALES_AND_TRAFFIC_REPORT)
 */
import { gunzipSync } from "node:zlib";

export type Region = "NA" | "EU";

const ENDPOINTS: Record<Region, string> = {
  NA: process.env.SPAPI_ENDPOINT_NA || "https://sellingpartnerapi-na.amazon.com",
  EU: process.env.SPAPI_ENDPOINT_EU || "https://sellingpartnerapi-eu.amazon.com",
};
const LWA_TOKEN_URL = process.env.LWA_TOKEN_URL || "https://api.amazon.com/auth/o2/token";

export const MARKETPLACE_REGION: Record<string, Region> = {
  ATVPDKIKX0DER: "NA", // US
  A2EUQ1WTGCTBG2: "NA", // CA
  A1F83G8C2ARO7P: "EU", // UK
  A1PA6795UKMFR9: "EU", // DE
  A13V1IB3VIYZZH: "EU", // FR
  APJ6JRA9NG5V4: "EU", // IT
  A1RKKUPIHCS9HS: "EU", // ES
};

const tokenCache: Partial<Record<Region, { token: string; expires: number }>> = {};

export function spapiConfigured(region: Region): boolean {
  return Boolean(
    process.env.SPAPI_CLIENT_ID && process.env.SPAPI_CLIENT_SECRET && process.env[`SPAPI_REFRESH_TOKEN_${region}`],
  );
}

async function accessToken(region: Region): Promise<string> {
  const cached = tokenCache[region];
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const refresh = process.env[`SPAPI_REFRESH_TOKEN_${region}`];
  if (!refresh || !process.env.SPAPI_CLIENT_ID || !process.env.SPAPI_CLIENT_SECRET) {
    throw new Error(
      `SP-API credentials missing for ${region} (SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SPAPI_REFRESH_TOKEN_${region}).`,
    );
  }
  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: process.env.SPAPI_CLIENT_ID,
      client_secret: process.env.SPAPI_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Login with Amazon token request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache[region] = { token: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(
  region: Region,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string | undefined> = {},
  body?: unknown,
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);
  const url = `${ENDPOINTS[region]}${path}${qs.size ? `?${qs}` : ""}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        "x-amz-access-token": await accessToken(region),
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`SP-API ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
  throw new Error(`SP-API ${path} kept throttling; try again in a minute.`);
}

// ── FBA inventory ───────────────────────────────────────────────────────────

interface InventorySummary {
  asin?: string;
  sellerSku?: string;
  inventoryDetails?: {
    fulfillableQuantity?: number;
    reservedQuantity?: { fcProcessingQuantity?: number };
  };
}

export interface FbaInventory {
  /** Amazon column per ASIN: fulfillable + FC processing, summed over all SKUs of the ASIN. */
  stockByAsin: Map<string, number>;
  /** Seller SKU → ASIN, used to place AWD (SKU-level) quantities on the right row. */
  asinBySku: Map<string, string>;
}

export async function fbaInventory(marketplaceId: string): Promise<FbaInventory> {
  const region = MARKETPLACE_REGION[marketplaceId];
  const stockByAsin = new Map<string, number>();
  const asinBySku = new Map<string, string>();
  let nextToken: string | undefined;
  do {
    const page = await call<{
      payload?: { inventorySummaries?: InventorySummary[] };
      pagination?: { nextToken?: string };
    }>(region, "GET", "/fba/inventory/v1/summaries", {
      details: "true",
      granularityType: "Marketplace",
      granularityId: marketplaceId,
      marketplaceIds: marketplaceId,
      nextToken,
    });
    for (const s of page.payload?.inventorySummaries ?? []) {
      if (!s.asin) continue;
      if (s.sellerSku) asinBySku.set(s.sellerSku, s.asin);
      const d = s.inventoryDetails ?? {};
      const qty = (d.fulfillableQuantity ?? 0) + (d.reservedQuantity?.fcProcessingQuantity ?? 0);
      stockByAsin.set(s.asin, (stockByAsin.get(s.asin) ?? 0) + qty);
    }
    nextToken = page.pagination?.nextToken;
    if (nextToken) await sleep(550); // 2 req/s; tokens expire after 30 s so keep moving
  } while (nextToken);
  return { stockByAsin, asinBySku };
}

// ── AWD (Amazon Warehousing & Distribution) — US only ───────────────────────

/** AWD available units per ASIN (availableDistributableQuantity, summed over SKUs). */
export async function awdAvailableByAsin(asinBySku: Map<string, string>) {
  const byAsin = new Map<string, number>();
  const unmappedSkus: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await call<{
      inventory?: { sku?: string; inventoryDetails?: { availableDistributableQuantity?: number } }[];
      nextToken?: string;
    }>("NA", "GET", "/awd/2024-05-09/inventory", { details: "SHOW", maxResults: "200", nextToken });
    for (const item of page.inventory ?? []) {
      if (!item.sku) continue;
      const qty = item.inventoryDetails?.availableDistributableQuantity ?? 0;
      const asin = asinBySku.get(item.sku);
      if (!asin) {
        if (qty) unmappedSkus.push(item.sku);
        continue;
      }
      byAsin.set(asin, (byAsin.get(asin) ?? 0) + qty);
    }
    nextToken = page.nextToken;
    if (nextToken) await sleep(550);
  } while (nextToken);
  return { byAsin, unmappedSkus };
}

// ── Business Reports (Sales & Traffic by child ASIN) ────────────────────────

/** Requests the Business Report for the last 30 full days. Returns the reportId to poll. */
export async function requestBusinessReport(marketplaceId: string): Promise<string> {
  const region = MARKETPLACE_REGION[marketplaceId];
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - 1); // yesterday
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29); // 30 days inclusive
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const res = await call<{ reportId: string }>(region, "POST", "/reports/2021-06-30/reports", {}, {
    reportType: "GET_SALES_AND_TRAFFIC_REPORT",
    marketplaceIds: [marketplaceId],
    dataStartTime: day(start),
    dataEndTime: day(end),
    reportOptions: { dateGranularity: "DAY", asinGranularity: "CHILD" },
  });
  return res.reportId;
}

export type ReportResult =
  | { state: "pending" }
  | { state: "failed"; message: string }
  | { state: "done"; unitsByAsin: Map<string, number> };

/** Checks a report once; when it's ready, downloads it and returns Units Ordered per child ASIN. */
export async function readBusinessReport(marketplaceId: string, reportId: string): Promise<ReportResult> {
  const region = MARKETPLACE_REGION[marketplaceId];
  const report = await call<{ processingStatus: string; reportDocumentId?: string }>(
    region,
    "GET",
    `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`,
  );
  if (report.processingStatus === "IN_QUEUE" || report.processingStatus === "IN_PROGRESS") return { state: "pending" };
  if (report.processingStatus !== "DONE" || !report.reportDocumentId) {
    return { state: "failed", message: `Business report ${report.processingStatus.toLowerCase()}` };
  }
  const doc = await call<{ url: string; compressionAlgorithm?: string }>(
    region,
    "GET",
    `/reports/2021-06-30/documents/${encodeURIComponent(report.reportDocumentId)}`,
  );
  const raw = Buffer.from(await (await fetch(doc.url)).arrayBuffer());
  const text = (doc.compressionAlgorithm === "GZIP" ? gunzipSync(raw) : raw).toString("utf8");
  const json = JSON.parse(text) as {
    salesAndTrafficByAsin?: { childAsin?: string; parentAsin?: string; salesByAsin?: { unitsOrdered?: number } }[];
  };
  const unitsByAsin = new Map<string, number>();
  for (const row of json.salesAndTrafficByAsin ?? []) {
    const asin = row.childAsin || row.parentAsin;
    if (!asin) continue;
    unitsByAsin.set(asin, (unitsByAsin.get(asin) ?? 0) + (row.salesByAsin?.unitsOrdered ?? 0));
  }
  return { state: "done", unitsByAsin };
}
