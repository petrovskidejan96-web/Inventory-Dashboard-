# Strongest Home – Inventory Dashboard

Interactive version of the **inventory** tab of *Weekly Meeting Table – Strongest Home*.
Each parent (CLEAR PARENT, WHITE PARENT, …) is a row you click to drop down its child products,
with the same columns as the sheet and the two Month-to-stock formulas calculated live.

| Column | Filled from |
|---|---|
| Amazon | SP-API · FBA Inventory — **Available + FC Processing** (no inbound) |
| External Warehouse | SP-API · **AWD available** units (US). Other countries: typed in or pushed via API |
| (receiving status) / Arrived to Amazon | typed in or pushed via API |
| OTW-1, OTW-2 | **Proboxx API** |
| Last 30 days sales | SP-API · **Business Reports** (Sales & Traffic, Units Ordered, child ASIN, last 30 full days) |
| Month to stock only Amazon inventory | `Amazon ÷ Last 30 days sales` |
| Month to stock by the last 30 days | `SUM(Amazon : OTW-2) ÷ Last 30 days sales` |
| Sending Inventory | typed in |
| Future order | typed in |

### Supplier Inventory tab
Same parent → child dropdowns (laid out on the USA parents; supplier-only items and ASINs sold only outside the US get their own groups).

| Column | How |
|---|---|
| Ready/Waiting for packing supplier | typed in |
| Under production supplier | typed in |
| Total Inventory Supplier | `Ready + Under production − Sending Inventory` (Sending summed over USA, UK, DE+FR+IT+ES, Canada for that ASIN) |
| New Order from Supplier All MP | `SUM(Future order)` over all marketplaces for that ASIN |
| Supplier Name | typed in |
| Supplier Link | typed in (opens with ↗) |

Rows are matched across tabs by ASIN; items without an ASIN (floor stoppers) by name. A negative total turns red.

Colours follow the sheet's conditional formatting: red under 2 months, yellow 2–4, green 4+.
Every number can also be edited by clicking it; a small dot shows where each value came from.

The starting data is the sheet as of *Last Updated 11.20.2026* (`data/inventory.seed.json`).

---

## Deploy (GitHub → Vercel)

1. **Import the repo** in Vercel → *Add New… → Project*. Framework is detected as Next.js; no build settings needed.
2. **Storage** – in the Vercel project: *Storage → Marketplace → Upstash → Redis* and connect it.
   This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically. (Without it the dashboard shows the sheet
   data and keeps edits only in your own browser.)
3. **Environment variables** (*Settings → Environment Variables*) – see `.env.example`:

   | Variable | What it is |
   |---|---|
   | `DASHBOARD_USER`, `DASHBOARD_PASSWORD` | Login for the dashboard (browser prompt). **Set this** – the data is commercial. |
   | `INGEST_TOKEN` | Long random string; lets Claude/MCP and other tools write to the dashboard. |
   | `CRON_SECRET` | Long random string; Vercel uses it to authenticate the daily sync. |
   | `SPAPI_CLIENT_ID`, `SPAPI_CLIENT_SECRET` | Your SP-API app (Developer Central → *Develop Apps*). |
   | `SPAPI_REFRESH_TOKEN_NA` | Refresh token for North America (US + Canada). |
   | `SPAPI_REFRESH_TOKEN_EU` | Refresh token for Europe (UK + DE/FR/IT/ES). |
   | `SPAPI_REFRESH_TOKEN_CA`, `_UK`, `_DE`, … | *Optional.* Only when a country is on a separate Seller Central account – overrides the region token for that country. Pair with `SPAPI_CLIENT_ID_CA` / `SPAPI_CLIENT_SECRET_CA` if that account uses a different app. |
   | `PROBOXX_API_URL`, `PROBOXX_API_KEY` | Proboxx shipments endpoint + key (see below). |

4. Redeploy. The **Sync** button pulls the current country now; Vercel Cron syncs every country daily
   (04:00–04:30 UTC, see `vercel.json`).

### SP-API app roles needed
*Amazon Fulfillment* (FBA inventory), *Amazon Warehousing and Distribution* (AWD) and *Brand Analytics / Selling Partner Insights*
roles that include the Sales & Traffic report. Self-authorize the app once per region to get each refresh token.

### Business Reports timing
Amazon builds the report in the background (usually under a minute, sometimes several). If it isn't ready while the
sync is running, stock is updated straight away and sales are picked up on the next sync. Business Report data trails by
about a day, so the window is the 30 full days ending yesterday (UTC).

### Proboxx
Proboxx doesn't publish public API docs, so `lib/proboxx.ts` reads a generic shipments list
(shipment → destination country, ETA, status, lines with ASIN or SKU and units).
Open shipments are sorted by ETA per ASIN: **OTW-1 = the first to arrive, OTW-2 = everything after it.**
Once you have Proboxx's real response format, only `normalize()` in that file needs adjusting.
Alternatively Proboxx/Zapier/Make can push numbers straight to `/api/ingest`.

---

## Feeding data from anywhere

### REST
```bash
curl -X POST https://<your-app>.vercel.app/api/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" -H "content-type: application/json" \
  -d '{"updates":[{"country":"UK","asin":"B08958WBQN","field":"externalWarehouse","value":1200}]}'
```
`country`: `US` · `UK` · `EU` · `CA` — `field`: `amazon` · `externalWarehouse` · `receiving` · `otw1` · `otw2` · `last30` · `sending` · `futureOrder`.
`country: "SUPPLIER"` — `field`: `ready` · `underProduction` (numbers) · `supplierName` · `supplierLink` (text).
An ASIN update hits every row with that ASIN in the country; use `id` (from `/api/inventory`) to target one row.

### MCP (Claude connector)
`/api/mcp` is an MCP server. In Claude: *Settings → Connectors → Add custom connector*,
URL `https://<your-app>.vercel.app/api/mcp`, header `Authorization: Bearer <INGEST_TOKEN>`.
Tools: `get_inventory`, `get_supplier_inventory`, `list_low_stock`, `update_inventory` — so Claude can read the dashboard,
flag low stock, and write in numbers it gets from other connectors.

---

## Local development
```bash
npm install
cp .env.example .env.local   # fill in what you have
npm run dev
```
Re-import the spreadsheet: `python3 scripts/extract_inventory.py "<path>.xlsx" data/inventory.seed.json`
(needs `pip install openpyxl`), then use *Reset to sheet* via `POST /api/inventory {"action":"reset"}`.
