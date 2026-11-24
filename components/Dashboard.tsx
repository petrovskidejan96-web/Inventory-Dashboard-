"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  monthsAmazon,
  monthsTotal,
  pipeline,
  productKey,
  stockLevel,
  sumChildren,
  packSizeOf,
  supplierNewOrder,
  poolTotalOf,
  supplierPools,
} from "@/lib/formulas";
import {
  autoSource,
  type CellMeta,
  type Child,
  type Country,
  type InventoryDoc,
  type NumericField,
  type SupplierItem,
} from "@/lib/types";

const DOMAINS: Record<string, string> = { US: "amazon.com", UK: "amazon.co.uk", EU: "amazon.de", CA: "amazon.ca" };

/** Sheet columns C..H. */
const COLUMNS: NumericField[] = ["amazon", "externalWarehouse", "receiving", "otw1", "otw2", "last30"];
/** Typed-in columns shown after the two Month-to-stock formulas. */
const AFTER_COLUMNS: { field: NumericField; label: string }[] = [
  { field: "sending", label: "Sending Inventory" },
  { field: "futureOrder", label: "Future order" },
];

const LOCAL_KEY = "inventory-local-edits-v1";
type TabId = Country["id"] | "SUPPLIER";
type CellValue = number | string | null;
type LocalEdits = Record<string, Record<string, CellValue>>;
type SaveFn = (tab: TabId, rowId: string, field: string, value: CellValue) => void;

const fmtInt = (v: number | null | undefined) => (typeof v === "number" ? Math.round(v).toLocaleString("en-US") : "");
const fmtMonths = (v: number | null) => (v === null ? "—" : v.toFixed(2));

function readLocal(): LocalEdits {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}") as LocalEdits;
  } catch {
    return {};
  }
}
function writeLocal(edits: LocalEdits) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(edits));
  } catch {
    /* storage unavailable */
  }
}

function eachRow(doc: InventoryDoc, fn: (row: Child | SupplierItem) => void) {
  for (const c of doc.countries) for (const g of c.groups) for (const ch of g.children) fn(ch);
  for (const g of doc.supplier?.groups ?? []) for (const it of g.children) fn(it);
}

function applyLocal(doc: InventoryDoc, edits: LocalEdits): InventoryDoc {
  if (!Object.keys(edits).length) return doc;
  const copy = structuredClone(doc);
  eachRow(copy, (row) => {
    const e = edits[row.id];
    if (e) Object.assign(row, e);
  });
  return copy;
}

function timeAgo(iso?: string) {
  if (!iso) return "never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-GB");
}

export default function Dashboard() {
  const [doc, setDoc] = useState<InventoryDoc | null>(null);
  const [persistent, setPersistent] = useState(true);
  const [amazonReady, setAmazonReady] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<TabId>("US");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [lowOnly, setLowOnly] = useState<null | "low" | "mid">(null);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<null | { title: string; lines: string[] }>(null);
  const [error, setError] = useState<string | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/inventory", { cache: "no-store" });
      if (!res.ok) throw new Error(`Couldn't load inventory (${res.status})`);
      const json = (await res.json()) as { doc: InventoryDoc; persistent: boolean; amazon: Record<string, boolean> };
      setPersistent(json.persistent);
      setAmazonReady(json.amazon);
      setDoc(json.persistent ? json.doc : applyLocal(json.doc, readLocal()));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save: SaveFn = useCallback(
    async (tabId, rowId, field, value) => {
      if (!doc) return;
      const next = structuredClone(doc);
      eachRow(next, (row) => {
        if (row.id !== rowId) return;
        (row as unknown as Record<string, unknown>)[field] = value;
        row.meta = { ...(row.meta ?? {}), [field]: { source: "manual", at: new Date().toISOString() } } as never;
      });
      setDoc(next);

      if (!persistent) {
        const edits = readLocal();
        edits[rowId] = { ...(edits[rowId] ?? {}), [field]: value };
        writeLocal(edits);
        return;
      }
      const res = await fetch("/api/inventory", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: [{ country: tabId, id: rowId, field, value }] }),
      });
      if (!res.ok) {
        flash("Couldn't save that change — reloading.");
        load();
      }
    },
    [doc, persistent, flash, load],
  );

  const country = tab === "SUPPLIER" ? null : (doc?.countries.find((c) => c.id === tab) ?? null);

  /**
   * Sending Inventory can't exceed what the supplier still has. Returns a message when it would,
   * using the same maths as the Supplier Inventory tab (units per pack, all marketplaces).
   */
  const checkSending = useCallback(
    (countryLabel: string, child: Child, next: number | null): null | { title: string; lines: string[] } => {
      if (!doc || next === null || next <= (child.sending ?? 0)) return null; // lowering is always fine
      const key = productKey(child);
      const item = doc.supplier?.groups.flatMap((g) => g.children).find((i) => productKey(i) === key);
      if (!item) return null; // no supplier row for this product
      const { ofItem } = supplierPools(doc);
      const pool = ofItem.get(item.id);
      if (!pool) return null;
      const pack = packSizeOf(item);
      const stockUnits = pool.units;
      const otherSendingUnits = pool.sendingUnits - (child.sending ?? 0) * pack;
      const availableUnits = stockUnits - otherSendingUnits;
      const shared = pool.members.length > 1 ? pool.members.map((m) => m.name).join(", ") : null;
      const neededUnits = next * pack;
      if (neededUnits <= availableUnits) return null;
      const availablePacks = Math.max(0, Math.floor(availableUnits / pack));
      return {
        title: "Not enough supplier inventory",
        lines: [
          `You entered ${fmtInt(next)} for ${child.name} (${countryLabel}), but the supplier only has ${fmtInt(availablePacks)} available.`,
          pack > 1
            ? `That's ${fmtInt(Math.max(0, availableUnits))} single units ÷ ${pack} per pack; ${fmtInt(next)} packs would need ${fmtInt(neededUnits)} units.`
            : "",
          `Total Inventory Supplier: ${fmtInt(stockUnits)} ready + under production` +
            (otherSendingUnits > 0 ? ` − ${fmtInt(otherSendingUnits)} already being sent from other rows/marketplaces.` : ".") +
            (shared ? ` Units are shared by ${shared}.` : ""),
          "The value was not saved.",
        ].filter(Boolean),
      };
    },
    [doc],
  );

  const runSync = useCallback(async () => {
    if (!country) return;
    setSyncing(true);
    flash(`Syncing ${country.label} from Amazon${country.id === "EU" ? " (4 marketplaces)" : ""}…`);
    try {
      const res = await fetch(`/api/sync?country=${country.id}`, { method: "POST" });
      const json = (await res.json()) as { doc?: InventoryDoc; error?: string };
      if (json.doc) setDoc(json.doc);
      const c = json.doc?.countries.find((x) => x.id === country.id);
      flash(json.error ?? c?.sync?.message ?? "Sync finished");
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }, [country, flash]);

  if (error)
    return (
      <div className="page">
        <div className="notice error">{error}</div>
      </div>
    );
  if (!doc)
    return (
      <div className="page">
        <div className="empty">Loading inventory…</div>
      </div>
    );

  const tabs: { id: TabId; label: string }[] = [
    ...doc.countries.map((c) => ({ id: c.id as TabId, label: c.label })),
    { id: "SUPPLIER", label: "Supplier Inventory" },
  ];
  const visibleGroupIds =
    tab === "SUPPLIER" ? (doc.supplier?.groups ?? []).map((g) => g.id) : (country?.groups ?? []).map((g) => g.id);
  const allOpen = visibleGroupIds.length > 0 && visibleGroupIds.every((id) => open.has(id));

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="page">
      <div className="topbar">
        <div className="title">
          <h1>Inventory</h1>
          <div className="sub">
            Strongest Home · Sheet {doc.sheetLastUpdated ?? "import"}
            {doc.updatedAt ? ` · last change ${timeAgo(doc.updatedAt)}` : ""}
          </div>
        </div>
        <div className="actions">
          <input
            className="search"
            placeholder="Search product, ASIN or supplier"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn" onClick={() => setOpen(allOpen ? new Set() : new Set(visibleGroupIds))}>
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
          {country && (
            <button
              className="btn primary"
              onClick={runSync}
              disabled={syncing || !persistent || !amazonReady[country.id]}
              title={
                !persistent
                  ? "Connect storage first"
                  : !amazonReady[country.id]
                    ? `Add SP-API credentials for ${country.label}`
                    : "Pull Amazon, AWD, Business Report and Proboxx numbers now"
              }
            >
              {syncing ? "Syncing…" : `Sync ${country.label}`}
            </button>
          )}
        </div>
      </div>

      {!persistent && (
        <div className="notice">
          Showing the numbers imported from the spreadsheet. Shared storage isn&apos;t connected yet, so any edits you make are
          saved in this browser only. Connect Upstash Redis in Vercel to share edits and enable automatic syncing.
        </div>
      )}
      {persistent && country && !amazonReady[country.id] && (
        <div className="notice info">
          Amazon {country.label} isn&apos;t connected yet — add the SP-API credentials in Vercel to fill Amazon, External
          Warehouse and Last 30 days sales automatically.
        </div>
      )}

      <div className="tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab ${t.id === tab ? "active" : ""} ${t.id === "SUPPLIER" ? "supplier" : ""}`}
            onClick={() => {
              setTab(t.id);
              setLowOnly(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {country ? (
        <CountryView
          country={country}
          query={query}
          lowOnly={lowOnly}
          setLowOnly={setLowOnly}
          open={open}
          setOpen={setOpen}
          toggle={toggle}
          onSave={save}
          checkSending={checkSending}
          onBlocked={setBlocked}
        />
      ) : (
        <SupplierView doc={doc} query={query} open={open} toggle={toggle} onSave={save} />
      )}

      <div className="legend">
        <span>
          <span className="sw" style={{ background: "var(--low)" }} />
          under 2 months
        </span>
        <span>
          <span className="sw" style={{ background: "var(--mid)" }} />
          2–4 months
        </span>
        <span>
          <span className="sw" style={{ background: "var(--ok)" }} />
          4+ months
        </span>
        <span>
          <span className="d" style={{ background: "var(--auto)" }} />
          filled by Amazon
        </span>
        <span>
          <span className="d" style={{ background: "var(--proboxx)" }} />
          filled by Proboxx
        </span>
        <span>
          <span className="d" style={{ background: "#f29900" }} />
          edited by hand or API
        </span>
        <span>Click any number to edit it.</span>
      </div>

      {toast && <div className="toast">{toast}</div>}
      {blocked && (
        <div className="modal-backdrop" onClick={() => setBlocked(null)}>
          <div className="modal" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2>⚠️ {blocked.title}</h2>
            {blocked.lines.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
            <div className="modal-actions">
              <button className="btn primary" onClick={() => setBlocked(null)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Country tabs ───────────────────────────────────────────────────────────────

function CountryView({
  country,
  query,
  lowOnly,
  setLowOnly,
  open,
  setOpen,
  toggle,
  onSave,
  checkSending,
  onBlocked,
}: {
  country: Country;
  query: string;
  lowOnly: null | "low" | "mid";
  setLowOnly: (v: null | "low" | "mid") => void;
  open: Set<string>;
  setOpen: (s: Set<string>) => void;
  toggle: (id: string) => void;
  onSave: SaveFn;
  checkSending: (countryLabel: string, child: Child, next: number | null) => null | { title: string; lines: string[] };
  onBlocked: (msg: { title: string; lines: string[] }) => void;
}) {
  const labels = country.columnLabels;
  const q = query.trim().toLowerCase();
  const filtering = Boolean(q || lowOnly);

  const groups = useMemo(
    () =>
      country.groups
        .map((g) => {
          let children = g.children;
          if (q && !g.name.toLowerCase().includes(q))
            children = children.filter(
              (c) => c.name.toLowerCase().includes(q) || (c.asin ?? "").toLowerCase().includes(q),
            );
          if (lowOnly) children = children.filter((c) => stockLevel(monthsTotal(c)) === lowOnly);
          return { ...g, children, all: g.children };
        })
        .filter((g) => g.children.length > 0 || !filtering),
    [country, q, lowOnly, filtering],
  );

  const stats = useMemo(() => {
    const kids = country.groups.flatMap((g) => g.children).filter((c) => c.asin);
    const t = sumChildren(kids);
    const levels = kids.map((c) => stockLevel(monthsTotal(c)));
    return {
      amazon: t.amazon,
      pipe: kids.reduce((s, c) => s + pipeline(c), 0),
      last30: t.last30,
      months: t.last30 > 0 ? t.amazon / t.last30 : null,
      low: levels.filter((l) => l === "low").length,
      mid: levels.filter((l) => l === "mid").length,
      skus: kids.length,
    };
  }, [country]);

  const save = (rowId: string, field: string, value: CellValue) => {
    if (field === "sending") {
      const child = country.groups.flatMap((g) => g.children).find((c) => c.id === rowId);
      const problem = child ? checkSending(country.label, child, value as number | null) : null;
      if (problem) {
        onBlocked(problem);
        return;
      }
    }
    onSave(country.id, rowId, field, value);
  };

  return (
    <>
      <div className="cards">
        <div className="card">
          <div className="label">{labels.amazon}</div>
          <div className="value">{fmtInt(stats.amazon)}</div>
          <div className="hint">units at Amazon · {stats.skus} products</div>
        </div>
        <div className="card">
          <div className="label">Total pipeline</div>
          <div className="value">{fmtInt(stats.pipe)}</div>
          <div className="hint">Amazon → OTW-2</div>
        </div>
        <div className="card">
          <div className="label">{labels.last30}</div>
          <div className="value">{fmtInt(stats.last30)}</div>
          <div className="hint">units sold</div>
        </div>
        <div className={`card ${stockLevel(stats.months)}`}>
          <div className="label">{labels.monthsAmazon}</div>
          <div className="value">{fmtMonths(stats.months)}</div>
          <div className="hint">whole country</div>
        </div>
        <div
          className="card low clickable"
          onClick={() => {
            setLowOnly(lowOnly === "low" ? null : "low");
            setOpen(new Set(country.groups.map((g) => g.id)));
          }}
        >
          <div className="label">Under 2 months (total)</div>
          <div className="value">{stats.low}</div>
          <div className="hint">{lowOnly === "low" ? "showing only these · click to clear" : "click to filter"}</div>
        </div>
        <div
          className="card mid clickable"
          onClick={() => {
            setLowOnly(lowOnly === "mid" ? null : "mid");
            setOpen(new Set(country.groups.map((g) => g.id)));
          }}
        >
          <div className="label">2–4 months (total)</div>
          <div className="value">{stats.mid}</div>
          <div className="hint">{lowOnly === "mid" ? "showing only these · click to clear" : "click to filter"}</div>
        </div>
      </div>

      <div className="syncline">
        Amazon sync: {timeAgo(country.sync?.lastSyncedAt)}
        {country.sync?.message ? ` — ${country.sync.message}` : ""}
      </div>

      <div className="sheet-wrap">
        <table className="sheet wide">
          <colgroup>
            <col style={{ width: "21%" }} />
            <col style={{ width: "7.5%" }} />
            {COLUMNS.map((f) => (
              <col key={f} style={{ width: "6.3%" }} />
            ))}
            <col style={{ width: "8%" }} />
            <col style={{ width: "8%" }} />
            {AFTER_COLUMNS.map((c) => (
              <col key={c.field} style={{ width: "6.5%" }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="items">{labels.items}</th>
              <th>{labels.asin}</th>
              {COLUMNS.map((f) => {
                const src = autoSource(country.id, f);
                return (
                  <th key={f}>
                    {labels[f as keyof typeof labels]}
                    {src && <span className="src">{src.replace("SP-API · ", "")}</span>}
                  </th>
                );
              })}
              <th className="formula">
                {labels.monthsAmazon}
                <span className="src">Amazon ÷ {labels.last30}</span>
              </th>
              <th className="formula">
                {labels.monthsTotal}
                <span className="src">SUM(Amazon : OTW-2) ÷ {labels.last30}</span>
              </th>
              {AFTER_COLUMNS.map((c) => (
                <th key={c.field} className="manual">
                  {c.label}
                  <span className="src">entered manually</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr>
                <td colSpan={12} className="empty">
                  No products match.
                </td>
              </tr>
            )}
            {groups.map((g) => {
              const isOpen = open.has(g.id) || filtering;
              const tot = sumChildren(g.all.filter((c) => c.asin));
              const totChild = tot as unknown as Child;
              const mA = monthsAmazon(totChild);
              const mT = monthsTotal(totChild);
              return (
                <Fragment key={g.id}>
                  <tr className={`parent ${isOpen ? "open" : ""}`} onClick={() => toggle(g.id)}>
                    <td className="items">
                      <span className="chev">▸</span> {g.name}
                      <span className="count">{g.all.length} items</span>
                    </td>
                    <td />
                    {COLUMNS.map((f) => (
                      <td key={f} className="num">
                        {fmtInt(tot[f as keyof typeof tot])}
                      </td>
                    ))}
                    <td className={`m ${stockLevel(mA)}`}>{fmtMonths(mA)}</td>
                    <td className={`m ${stockLevel(mT)}`}>{fmtMonths(mT)}</td>
                    {AFTER_COLUMNS.map((c) => (
                      <td key={c.field} className="num">
                        {fmtInt(tot[c.field as keyof typeof tot]) || ""}
                      </td>
                    ))}
                  </tr>
                  {isOpen &&
                    g.children.map((ch) => {
                      const a = monthsAmazon(ch);
                      const t = monthsTotal(ch);
                      return (
                        <tr className="child" key={ch.id}>
                          <td className="items">{ch.name}</td>
                          <td className="asin">
                            <AsinLink asin={ch.asin} domain={DOMAINS[country.id]} />
                          </td>
                          {COLUMNS.map((f) => (
                            <td key={f} className="num">
                              <NumberCell
                                rowId={ch.id}
                                field={f}
                                label={ch.name}
                                value={ch[f]}
                                meta={ch.meta?.[f]}
                                auto={autoSource(country.id, f)}
                                onSave={save}
                              />
                            </td>
                          ))}
                          <td className={`m ${stockLevel(a)}`}>{ch.asin ? fmtMonths(a) : ""}</td>
                          <td className={`m ${stockLevel(t)}`}>{ch.asin ? fmtMonths(t) : ""}</td>
                          {AFTER_COLUMNS.map((c) => (
                            <td key={c.field} className="num manual-col">
                              <NumberCell
                                rowId={ch.id}
                                field={c.field}
                                label={ch.name}
                                value={ch[c.field] ?? null}
                                meta={ch.meta?.[c.field]}
                                auto={null}
                                onSave={save}
                              />
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Supplier Inventory tab ─────────────────────────────────────────────────────

function SupplierView({
  doc,
  query,
  open,
  toggle,
  onSave,
}: {
  doc: InventoryDoc;
  query: string;
  open: Set<string>;
  toggle: (id: string) => void;
  onSave: SaveFn;
}) {
  const { ofItem, pools, totals } = useMemo(() => supplierPools(doc), [doc]);
  const q = query.trim().toLowerCase();
  const sendingOf = (it: SupplierItem) => totals.sending.get(productKey(it)) ?? 0;
  const futureOf = (it: SupplierItem) => totals.futureOrder.get(productKey(it)) ?? 0;
  const newOrderOf = (it: SupplierItem) => supplierNewOrder(it, futureOf(it));

  const groups = useMemo(
    () =>
      (doc.supplier?.groups ?? [])
        .map((g) => {
          const children =
            q && !g.name.toLowerCase().includes(q)
              ? g.children.filter(
                  (c) =>
                    c.name.toLowerCase().includes(q) ||
                    (c.asin ?? "").toLowerCase().includes(q) ||
                    (c.supplierName ?? "").toLowerCase().includes(q),
                )
              : g.children;
          return { ...g, children, all: g.children };
        })
        .filter((g) => g.children.length > 0 || !q),
    [doc.supplier, q],
  );

  const all = (doc.supplier?.groups ?? []).flatMap((g) => g.children);
  const sum = (items: SupplierItem[], f: (i: SupplierItem) => number) => items.reduce((s, i) => s + f(i), 0);
  const stats = {
    ready: sum(all, (i) => i.ready ?? 0),
    production: sum(all, (i) => i.underProduction ?? 0),
    total: pools.reduce((s, p) => s + p.total, 0),
    newOrder: sum(all, newOrderOf),
    suppliers: new Set(all.map((i) => (i.supplierName ?? "").trim().toLowerCase()).filter(Boolean)).size,
  };
  const save = (rowId: string, field: string, value: CellValue) => onSave("SUPPLIER", rowId, field, value);

  return (
    <>
      <div className="cards">
        <div className="card">
          <div className="label">Ready / Waiting for packing</div>
          <div className="value">{fmtInt(stats.ready)}</div>
          <div className="hint">units at suppliers</div>
        </div>
        <div className="card">
          <div className="label">Under production</div>
          <div className="value">{fmtInt(stats.production)}</div>
          <div className="hint">units being made</div>
        </div>
        <div className={`card ${stats.total < 0 ? "low" : ""}`}>
          <div className="label">Total Inventory Supplier</div>
          <div className="value">{fmtInt(stats.total)}</div>
          <div className="hint">after Sending Inventory, all MP</div>
        </div>
        <div className="card">
          <div className="label">New Order from Supplier All MP</div>
          <div className="value">{fmtInt(stats.newOrder)}</div>
          <div className="hint">units: Future order × units per pack</div>
        </div>
        <div className="card">
          <div className="label">Suppliers</div>
          <div className="value">{stats.suppliers}</div>
          <div className="hint">{all.length} products</div>
        </div>
      </div>

      <div className="syncline">
        Doorstoppers are produced as single units: Sending Inventory and Future order (entered in Amazon packs on the
        marketplace tabs) are multiplied by <b>Units per pack</b> — e.g. 1,000 × CHROME (2 Pack) = 2,000 units. Total
        Inventory Supplier = Ready + Under production − Sending × units per pack; pack sizes of the same doorstopper
        (e.g. CHROME 1/2/4/6/10 Pack) share one pool of units, marked &quot;shared units&quot;. New Order = SUM(Future order,
        all MP) × units per pack. Sending Inventory above what the supplier has is refused with a warning.
      </div>

      <div className="sheet-wrap">
        <table className="sheet">
          <colgroup>
            <col style={{ width: "21%" }} />
            <col style={{ width: "8.5%" }} />
            <col style={{ width: "6%" }} />
            <col style={{ width: "9%" }} />
            <col style={{ width: "9%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "18%" }} />
          </colgroup>
          <thead>
            <tr>
              <th className="items">Items</th>
              <th>ASIN</th>
              <th className="manual">
                Units per pack<span className="src">single units in 1 ASIN</span>
              </th>
              <th className="manual">
                Ready/Waiting for packing supplier<span className="src">entered manually</span>
              </th>
              <th className="manual">
                Under production supplier<span className="src">entered manually</span>
              </th>
              <th className="formula">
                Total Inventory Supplier<span className="src">Ready + Under production − Sending (all MP) × units per pack</span>
              </th>
              <th className="formula">
                New Order from Supplier All MP<span className="src">SUM of Future order, all MP × units per pack</span>
              </th>
              <th className="manual">
                Supplier Name<span className="src">entered manually</span>
              </th>
              <th className="manual">
                Supplier Link<span className="src">entered manually</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr>
                <td colSpan={9} className="empty">
                  No products match.
                </td>
              </tr>
            )}
            {groups.map((g) => {
              const isOpen = open.has(g.id) || Boolean(q);
              const ready = sum(g.all, (i) => i.ready ?? 0);
              const prod = sum(g.all, (i) => i.underProduction ?? 0);
              const total = poolTotalOf(g.all, ofItem);
              const newOrder = sum(g.all, newOrderOf);
              const names = [...new Set(g.all.map((i) => i.supplierName?.trim()).filter(Boolean))];
              return (
                <Fragment key={g.id}>
                  <tr className={`parent ${isOpen ? "open" : ""}`} onClick={() => toggle(g.id)}>
                    <td className="items">
                      <span className="chev">▸</span> {g.name}
                      <span className="count">{g.all.length} items</span>
                    </td>
                    <td />
                    <td />
                    <td className="num">{fmtInt(ready)}</td>
                    <td className="num">{fmtInt(prod)}</td>
                    <td className={`m total ${total < 0 ? "low" : ""}`}>{fmtInt(total)}</td>
                    <td className="m total">{fmtInt(newOrder)}</td>
                    <td className="text-muted">{names.join(", ")}</td>
                    <td />
                  </tr>
                  {isOpen &&
                    g.children.map((it) => {
                      const sending = sendingOf(it);
                      const pool = ofItem.get(it.id);
                      const total = pool?.total ?? 0;
                      const shared = pool && pool.members.length > 1 ? pool.members : null;
                      const newOrder = newOrderOf(it);
                      return (
                        <tr className="child" key={it.id}>
                          <td className="items">{it.name}</td>
                          <td className="asin">
                            <AsinLink asin={it.asin} domain={DOMAINS.US} />
                          </td>
                          <td className="num manual-col">
                            <NumberCell
                              rowId={it.id}
                              field="packSize"
                              label={it.name}
                              value={packSizeOf(it)}
                              meta={it.meta?.packSize}
                              auto={null}
                              onSave={save}
                            />
                          </td>
                          <td className="num manual-col">
                            <NumberCell
                              rowId={it.id}
                              field="ready"
                              label={it.name}
                              value={it.ready}
                              meta={it.meta?.ready}
                              auto={null}
                              onSave={save}
                            />
                          </td>
                          <td className="num manual-col">
                            <NumberCell
                              rowId={it.id}
                              field="underProduction"
                              label={it.name}
                              value={it.underProduction}
                              meta={it.meta?.underProduction}
                              auto={null}
                              onSave={save}
                            />
                          </td>
                          <td
                            className={`m total ${total < 0 ? "low" : ""}`}
                            title={
                              shared
                                ? `Shared single units for ${shared.map((m) => m.name).join(", ")}: ` +
                                  `${fmtInt(pool!.units)} ready + in production − ${fmtInt(pool!.sendingUnits)} units being sent (all packs, all MP)`
                                : `${fmtInt(it.ready ?? 0)} ready + ${fmtInt(it.underProduction ?? 0)} in production − ${fmtInt(sending)} sending × ${packSizeOf(it)} units per pack`
                            }
                          >
                            {fmtInt(total)}
                            {shared && <span className="shared">shared units</span>}
                          </td>
                          <td
                            className="m total"
                            title={`${fmtInt(futureOf(it))} Future order (all MP) × ${packSizeOf(it)} units per pack`}
                          >
                            {fmtInt(newOrder)}
                          </td>
                          <td className="manual-col">
                            <TextCell
                              rowId={it.id}
                              field="supplierName"
                              label={it.name}
                              value={it.supplierName}
                              placeholder=""
                              onSave={save}
                            />
                          </td>
                          <td className="manual-col">
                            <TextCell
                              rowId={it.id}
                              field="supplierLink"
                              label={it.name}
                              value={it.supplierLink}
                              placeholder="paste link"
                              link
                              onSave={save}
                            />
                          </td>
                        </tr>
                      );
                    })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Cells ─────────────────────────────────────────────────────────────────────

function AsinLink({ asin, domain }: { asin: string | null; domain: string }) {
  if (!asin) return null;
  return (
    <a href={`https://www.${domain}/dp/${asin}`} target="_blank" rel="noreferrer">
      {asin}
    </a>
  );
}

function sourceTitle(meta: CellMeta | undefined, auto: string | null) {
  if (meta)
    return `${meta.source === "manual" ? "Edited" : `From ${meta.source}`} · ${new Date(meta.at).toLocaleString("en-GB")}`;
  return auto ? `From spreadsheet · auto-filled by ${auto} after sync` : "From spreadsheet";
}

function NumberCell({
  rowId,
  field,
  label,
  value,
  meta,
  auto,
  onSave,
}: {
  rowId: string;
  field: string;
  label: string;
  value: number | null;
  meta?: CellMeta;
  auto: string | null;
  onSave: (rowId: string, field: string, value: CellValue) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const dotClass =
    meta?.source === "amazon" ? "dot" : meta?.source === "proboxx" ? "dot proboxx" : meta ? "dot manual" : null;

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(null);
      return;
    }
    if (draft === null) return;
    const trimmed = draft.replace(/,/g, "").trim();
    const next = trimmed === "" ? null : Number(trimmed);
    setDraft(null);
    if (next !== null && !Number.isFinite(next)) return;
    if (next === value) return;
    onSave(rowId, field, next);
  };

  return (
    <div className="cell" title={sourceTitle(meta, auto)}>
      {dotClass && <span className={dotClass} />}
      <input
        inputMode="numeric"
        value={draft ?? fmtInt(value)}
        onFocus={(e) => {
          setDraft(value === null ? "" : String(value));
          const el = e.target;
          requestAnimationFrame(() => el.select());
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            (e.target as HTMLInputElement).blur();
          }
        }}
        aria-label={`${label} ${field}`}
      />
    </div>
  );
}

function TextCell({
  rowId,
  field,
  label,
  value,
  placeholder,
  link,
  onSave,
}: {
  rowId: string;
  field: string;
  label: string;
  value: string | null;
  placeholder: string;
  link?: boolean;
  onSave: (rowId: string, field: string, value: CellValue) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const href = link && value ? (/^https?:\/\//i.test(value) ? value : `https://${value}`) : null;

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(null);
      return;
    }
    if (draft === null) return;
    const next = draft.trim() === "" ? null : draft.trim();
    setDraft(null);
    if (next === value) return;
    onSave(rowId, field, next);
  };

  return (
    <div className={`cell text ${link ? "link" : ""}`}>
      <input
        value={draft ?? value ?? ""}
        placeholder={placeholder}
        onFocus={() => setDraft(value ?? "")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            (e.target as HTMLInputElement).blur();
          }
        }}
        aria-label={`${label} ${field}`}
      />
      {href && draft === null && (
        <a className="open-link" href={href} target="_blank" rel="noreferrer" title="Open link">
          ↗
        </a>
      )}
    </div>
  );
}
