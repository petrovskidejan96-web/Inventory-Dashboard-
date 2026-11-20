"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { monthsAmazon, monthsTotal, pipeline, stockLevel, sumChildren } from "@/lib/formulas";
import { autoSource, type Child, type Country, type InventoryDoc, type NumericField } from "@/lib/types";

const DOMAINS: Record<string, string> = {
  US: "amazon.com",
  UK: "amazon.co.uk",
  EU: "amazon.de",
  CA: "amazon.ca",
};

const COLUMNS: NumericField[] = ["amazon", "externalWarehouse", "receiving", "otw1", "otw2", "last30"];
const LOCAL_KEY = "inventory-local-edits-v1";

type LocalEdits = Record<string, Partial<Record<NumericField, number | null>>>;

const fmtInt = (v: number | null | undefined) =>
  typeof v === "number" ? Math.round(v).toLocaleString("en-US") : "";
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

function applyLocal(doc: InventoryDoc, edits: LocalEdits): InventoryDoc {
  if (!Object.keys(edits).length) return doc;
  const copy = structuredClone(doc);
  for (const c of copy.countries)
    for (const g of c.groups)
      for (const ch of g.children) {
        const e = edits[ch.id];
        if (e) Object.assign(ch, e);
      }
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
  const [countryId, setCountryId] = useState<Country["id"]>("US");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [lowOnly, setLowOnly] = useState<null | "low" | "mid">(null);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/inventory", { cache: "no-store" });
      if (!res.ok) throw new Error(`Couldn't load inventory (${res.status})`);
      const json = (await res.json()) as {
        doc: InventoryDoc;
        persistent: boolean;
        amazon: Record<string, boolean>;
      };
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

  const country = doc?.countries.find((c) => c.id === countryId) ?? null;

  const saveCell = useCallback(
    async (child: Child, field: NumericField, value: number | null) => {
      if (!doc) return;
      // optimistic update
      const next = structuredClone(doc);
      for (const c of next.countries)
        for (const g of c.groups)
          for (const ch of g.children)
            if (ch.id === child.id) {
              ch[field] = value;
              ch.meta = { ...(ch.meta ?? {}), [field]: { source: "manual", at: new Date().toISOString() } };
            }
      setDoc(next);

      if (!persistent) {
        const edits = readLocal();
        edits[child.id] = { ...(edits[child.id] ?? {}), [field]: value };
        writeLocal(edits);
        return;
      }
      const res = await fetch("/api/inventory", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: [{ country: countryId, id: child.id, field, value }] }),
      });
      if (!res.ok) {
        flash("Couldn't save that change — reloading.");
        load();
      }
    },
    [doc, persistent, countryId, flash, load],
  );

  const runSync = useCallback(async () => {
    setSyncing(true);
    flash(`Syncing ${country?.label} from Amazon${countryId === "EU" ? " (4 marketplaces)" : ""}…`);
    try {
      const res = await fetch(`/api/sync?country=${countryId}`, { method: "POST" });
      const json = (await res.json()) as { doc?: InventoryDoc; error?: string };
      if (json.doc) setDoc(json.doc);
      const c = json.doc?.countries.find((x) => x.id === countryId);
      flash(json.error ?? c?.sync?.message ?? "Sync finished");
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }, [countryId, country?.label, flash]);

  const groups = useMemo(() => {
    if (!country) return [];
    const q = query.trim().toLowerCase();
    return country.groups
      .map((g) => {
        let children = g.children;
        if (q) {
          const parentHit = g.name.toLowerCase().includes(q);
          children = parentHit
            ? children
            : children.filter((c) => c.name.toLowerCase().includes(q) || (c.asin ?? "").toLowerCase().includes(q));
        }
        if (lowOnly) children = children.filter((c) => stockLevel(monthsTotal(c)) === lowOnly);
        return { ...g, children, all: g.children };
      })
      .filter((g) => g.children.length > 0 || (!q && !lowOnly));
  }, [country, query, lowOnly]);

  const filtering = Boolean(query.trim() || lowOnly);

  const stats = useMemo(() => {
    if (!country) return null;
    const kids = country.groups.flatMap((g) => g.children).filter((c) => c.asin);
    const t = sumChildren(kids);
    const pipe = kids.reduce((s, c) => s + pipeline(c), 0);
    const levels = kids.map((c) => stockLevel(monthsTotal(c)));
    return {
      amazon: t.amazon,
      pipe,
      last30: t.last30,
      months: t.last30 > 0 ? t.amazon / t.last30 : null,
      low: levels.filter((l) => l === "low").length,
      mid: levels.filter((l) => l === "mid").length,
      skus: kids.length,
    };
  }, [country]);

  if (error) return <div className="page"><div className="notice error">{error}</div></div>;
  if (!doc || !country || !stats) return <div className="page"><div className="empty">Loading inventory…</div></div>;

  const labels = country.columnLabels;
  const allOpen = groups.every((g) => open.has(g.id));

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
            placeholder="Search product or ASIN"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="btn"
            onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map((g) => g.id)))}
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
          <button
            className="btn primary"
            onClick={runSync}
            disabled={syncing || !persistent || !amazonReady[countryId]}
            title={
              !persistent
                ? "Connect storage first"
                : !amazonReady[countryId]
                  ? `Add SP-API credentials for ${country.label}`
                  : "Pull Amazon, AWD, Business Report and Proboxx numbers now"
            }
          >
            {syncing ? "Syncing…" : `Sync ${country.label}`}
          </button>
        </div>
      </div>

      {!persistent && (
        <div className="notice">
          Showing the numbers imported from the spreadsheet. Shared storage isn&apos;t connected yet, so any edits you make are
          saved in this browser only. Connect Upstash Redis in Vercel to share edits and enable automatic syncing.
        </div>
      )}
      {persistent && !amazonReady[countryId] && (
        <div className="notice info">
          Amazon {country.label} isn&apos;t connected yet — add the SP-API credentials in Vercel to fill Amazon,
          External Warehouse and Last 30 days sales automatically.
        </div>
      )}

      <div className="tabs">
        {doc.countries.map((c) => (
          <button
            key={c.id}
            className={`tab ${c.id === countryId ? "active" : ""}`}
            onClick={() => {
              setCountryId(c.id);
              setLowOnly(null);
            }}
          >
            {c.label}
          </button>
        ))}
      </div>

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
          className={`card low clickable`}
          onClick={() => {
            setLowOnly(lowOnly === "low" ? null : "low");
            setOpen(new Set(country.groups.map((g) => g.id)));
          }}
          title="Show only these products"
        >
          <div className="label">Under 2 months (total)</div>
          <div className="value">{stats.low}</div>
          <div className="hint">{lowOnly === "low" ? "showing only these · click to clear" : "click to filter"}</div>
        </div>
        <div
          className={`card mid clickable`}
          onClick={() => {
            setLowOnly(lowOnly === "mid" ? null : "mid");
            setOpen(new Set(country.groups.map((g) => g.id)));
          }}
          title="Show only these products"
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
        <table className="sheet">
          <colgroup>
            <col style={{ width: "26%" }} />
            <col style={{ width: "9%" }} />
            {COLUMNS.map((f) => (
              <col key={f} style={{ width: "7.5%" }} />
            ))}
            <col style={{ width: "10%" }} />
            <col style={{ width: "10%" }} />
          </colgroup>
          <thead>
            <tr>
              <th className="items">{labels.items}</th>
              <th>{labels.asin}</th>
              {COLUMNS.map((f) => {
                const src = autoSource(countryId, f);
                return (
                  <th key={f}>
                    {labels[f]}
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
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr>
                <td colSpan={10} className="empty">No products match.</td>
              </tr>
            )}
            {groups.map((g) => {
              const isOpen = open.has(g.id) || filtering;
              const tot = sumChildren(g.all.filter((c) => c.asin));
              const totChild = { ...tot } as unknown as Child;
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
                        {fmtInt(tot[f])}
                      </td>
                    ))}
                    <td className={`m ${stockLevel(mA)}`}>{fmtMonths(mA)}</td>
                    <td className={`m ${stockLevel(mT)}`}>{fmtMonths(mT)}</td>
                  </tr>
                  {isOpen &&
                    g.children.map((ch) => (
                      <ChildRow
                        key={ch.id}
                        child={ch}
                        countryId={countryId}
                        domain={DOMAINS[countryId]}
                        onSave={saveCell}
                      />
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="legend">
        <span><span className="sw" style={{ background: "var(--low)" }} />under 2 months</span>
        <span><span className="sw" style={{ background: "var(--mid)" }} />2–4 months</span>
        <span><span className="sw" style={{ background: "var(--ok)" }} />4+ months</span>
        <span><span className="d" style={{ background: "var(--auto)" }} />filled by Amazon</span>
        <span><span className="d" style={{ background: "var(--proboxx)" }} />filled by Proboxx</span>
        <span><span className="d" style={{ background: "#f29900" }} />edited by hand or API</span>
        <span>Click any number to edit it.</span>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function ChildRow({
  child,
  countryId,
  domain,
  onSave,
}: {
  child: Child;
  countryId: string;
  domain: string;
  onSave: (child: Child, field: NumericField, value: number | null) => void;
}) {
  const mA = monthsAmazon(child);
  const mT = monthsTotal(child);
  return (
    <tr className="child">
      <td className="items">{child.name}</td>
      <td className="asin">
        {child.asin ? (
          <a href={`https://www.${domain}/dp/${child.asin}`} target="_blank" rel="noreferrer">
            {child.asin}
          </a>
        ) : null}
      </td>
      {COLUMNS.map((f) => (
        <td key={f} className="num">
          <EditableCell child={child} field={f} countryId={countryId} onSave={onSave} />
        </td>
      ))}
      <td className={`m ${stockLevel(mA)}`}>{child.asin ? fmtMonths(mA) : ""}</td>
      <td className={`m ${stockLevel(mT)}`}>{child.asin ? fmtMonths(mT) : ""}</td>
    </tr>
  );
}

function EditableCell({
  child,
  field,
  countryId,
  onSave,
}: {
  child: Child;
  field: NumericField;
  countryId: string;
  onSave: (child: Child, field: NumericField, value: number | null) => void;
}) {
  const value = child[field];
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const meta = child.meta?.[field];
  const dotClass =
    meta?.source === "amazon" ? "dot" : meta?.source === "proboxx" ? "dot proboxx" : meta ? "dot manual" : null;
  const title = meta
    ? `${meta.source === "manual" ? "Edited" : `From ${meta.source}`} · ${new Date(meta.at).toLocaleString("en-GB")}`
    : autoSource(countryId, field)
      ? `From spreadsheet · auto-filled by ${autoSource(countryId, field)} after sync`
      : "From spreadsheet";

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
    onSave(child, field, next);
  };

  return (
    <div className="cell" title={title}>
      {dotClass && <span className={dotClass} />}
      <input
        inputMode="numeric"
        value={draft ?? fmtInt(value)}
        onFocus={(e) => {
          setDraft(value === null ? "" : String(value));
          requestAnimationFrame(() => e.target.select());
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
        aria-label={`${child.name} ${field}`}
      />
    </div>
  );
}
