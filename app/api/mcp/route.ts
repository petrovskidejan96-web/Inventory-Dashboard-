/**
 * A small MCP server (Streamable HTTP, stateless JSON responses) so Claude — or any MCP client —
 * can read the dashboard and fill in columns. Add it in Claude as a custom connector:
 *   URL:  https://<your-app>/api/mcp
 *   Auth: header  Authorization: Bearer <INGEST_TOKEN>
 */
import { NextResponse } from "next/server";
import { hasBasicAuth, hasIngestToken } from "@/lib/auth";
import { monthsAmazon, monthsTotal } from "@/lib/formulas";
import { applyUpdates, loadDoc, saveDoc, storageConfigured, validateUpdate } from "@/lib/store";
import { NUMERIC_FIELDS, type CellUpdate, type InventoryDoc } from "@/lib/types";

export const dynamic = "force-dynamic";

const SERVER_INFO = { name: "strongest-home-inventory", version: "1.0.0" };
const COUNTRY_ENUM = ["US", "UK", "EU", "CA"];

const TOOLS = [
  {
    name: "get_inventory",
    description:
      "Read the inventory dashboard: every parent with its child products, the columns Amazon, External Warehouse, " +
      "receiving, OTW-1, OTW-2, Last 30 days sales, and the two Month-to-stock formulas.",
    inputSchema: {
      type: "object",
      properties: { country: { type: "string", enum: COUNTRY_ENUM, description: "Limit to one country section." } },
    },
  },
  {
    name: "list_low_stock",
    description: "List products whose Month to stock (Amazon only, or total pipeline) is below a threshold.",
    inputSchema: {
      type: "object",
      properties: {
        country: { type: "string", enum: COUNTRY_ENUM },
        months: { type: "number", description: "Threshold in months (default 2)." },
        basis: { type: "string", enum: ["amazon", "total"], description: "Which month-to-stock column (default amazon)." },
      },
    },
  },
  {
    name: "update_inventory",
    description:
      "Write numbers into the dashboard. Identify a row by ASIN (updates every row with that ASIN in the country) " +
      "or by row id from get_inventory. Fields: " + NUMERIC_FIELDS.join(", ") + ".",
    inputSchema: {
      type: "object",
      required: ["updates"],
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            required: ["country", "field", "value"],
            properties: {
              country: { type: "string", enum: COUNTRY_ENUM },
              asin: { type: "string" },
              id: { type: "string" },
              field: { type: "string", enum: [...NUMERIC_FIELDS] },
              value: { type: ["number", "null"] },
            },
          },
        },
      },
    },
  },
];

const round = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

function flatten(doc: InventoryDoc, country?: string) {
  return doc.countries
    .filter((c) => !country || c.id === country)
    .map((c) => ({
      country: c.id,
      label: c.label,
      lastSync: c.sync?.lastSyncedAt ?? null,
      parents: c.groups.map((g) => ({
        parent: g.name,
        children: g.children.map((ch) => ({
          id: ch.id,
          name: ch.name,
          asin: ch.asin,
          amazon: ch.amazon,
          externalWarehouse: ch.externalWarehouse,
          receiving: ch.receiving,
          otw1: ch.otw1,
          otw2: ch.otw2,
          last30: ch.last30,
          monthsToStockAmazon: round(monthsAmazon(ch)),
          monthsToStockTotal: round(monthsTotal(ch)),
        })),
      })),
    }));
}

async function callTool(name: string, args: Record<string, unknown>) {
  const doc = await loadDoc();
  if (name === "get_inventory") return flatten(doc, args.country as string | undefined);
  if (name === "list_low_stock") {
    const limit = typeof args.months === "number" ? args.months : 2;
    const basis = args.basis === "total" ? "total" : "amazon";
    return flatten(doc, args.country as string | undefined).flatMap((c) =>
      c.parents.flatMap((p) =>
        p.children
          .filter((ch) => {
            const m = basis === "total" ? ch.monthsToStockTotal : ch.monthsToStockAmazon;
            return m !== null && m < limit;
          })
          .map((ch) => ({ country: c.country, parent: p.parent, ...ch })),
      ),
    );
  }
  if (name === "update_inventory") {
    if (!storageConfigured()) throw new Error("Dashboard storage is not configured, so updates can't be saved.");
    const updates = args.updates;
    if (!Array.isArray(updates) || !updates.every(validateUpdate)) {
      throw new Error("updates must be [{ country, asin|id, field, value }]");
    }
    const result = applyUpdates(doc, updates as CellUpdate[], "api");
    await saveDoc(doc);
    return result;
  }
  throw new Error(`Unknown tool: ${name}`);
}

type RpcMessage = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

async function handle(msg: RpcMessage) {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: (msg.params?.protocolVersion as string) || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Inventory dashboard for Strongest Home. Use get_inventory to read it and update_inventory to fill in columns.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name as string;
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      try {
        const data = await callTool(name, args);
        return reply({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: data } });
      } catch (err) {
        return reply({ content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true });
      }
    }
    default:
      return error(-32601, `Method not found: ${msg.method}`);
  }
}

export async function POST(req: Request) {
  if (!hasIngestToken(req.headers) && !(process.env.DASHBOARD_PASSWORD && hasBasicAuth(req.headers))) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as RpcMessage | RpcMessage[] | null;
  if (!body) return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });

  const messages = Array.isArray(body) ? body : [body];
  const requests = messages.filter((m) => m.id !== undefined && m.id !== null);
  if (!requests.length) return new Response(null, { status: 202 }); // notifications only
  const responses = await Promise.all(requests.map(handle));
  return NextResponse.json(Array.isArray(body) ? responses : responses[0]);
}

export async function GET() {
  return new Response("This MCP endpoint accepts POST (Streamable HTTP, JSON responses).", {
    status: 405,
    headers: { allow: "POST" },
  });
}

export async function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
