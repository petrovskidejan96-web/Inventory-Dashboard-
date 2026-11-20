"""Extract the 'inventory' tab of the Weekly Meeting Table into seed JSON for the dashboard."""
import json
import sys
from datetime import datetime, timezone

import openpyxl

SRC, OUT = sys.argv[1], sys.argv[2]

wb = openpyxl.load_workbook(SRC, data_only=True)
ws = wb["inventory"]

SECTIONS = [
    # (title row, header row, first data row, last data row, id, label, marketplaces)
    (3, 2, 4, 80, "US", "USA", ["ATVPDKIKX0DER"]),
    (83, 85, 86, 138, "UK", "UK", ["A1F83G8C2ARO7P"]),
    (139, 141, 142, 184, "EU", "DE+FR+IT+ES", ["A1PA6795UKMFR9", "A13V1IB3VIYZZH", "APJ6JRA9NG5V4", "A1RKKUPIHCS9HS"]),
    (187, 189, 190, 250, "CA", "Canada", ["A2EUQ1WTGCTBG2"]),
]

FIELDS = ["amazon", "externalWarehouse", "receiving", "otw1", "otw2", "last30"]  # columns C..H


def clean(v):
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip()
        return s or None
    return v


def num(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return int(v) if float(v).is_integer() else round(float(v), 4)
    return None


def group_name(children):
    names = " ".join(c["name"] for c in children).lower()
    if "strip" in names or "square" in names:
        return "Strip & Square Bumpers"
    if "ring" in names:
        return "Rings"
    return "Other"


countries = []
for title_row, header_row, start, end, cid, label, mkts in SECTIONS:
    headers = [clean(ws.cell(header_row, c).value) for c in range(1, 11)]
    groups = []
    current = None
    prev_blank = True
    for r in range(start, end + 1):
        a = clean(ws.cell(r, 1).value)
        b = clean(ws.cell(r, 2).value)
        if a is None:
            prev_blank = True
            current = None
            continue
        bold = bool(ws.cell(r, 1).font.b)
        is_parent = b is None and (bold or r == start) and all(
            num(ws.cell(r, c).value) is None for c in range(3, 9)
        )
        if is_parent:
            current = {"id": f"{cid}-p{r}", "name": a, "sourceRow": r, "children": []}
            groups.append(current)
        else:
            if current is None:
                current = {"id": f"{cid}-p{r}", "name": None, "sourceRow": r, "children": []}
                groups.append(current)
            child = {"id": f"{cid}-r{r}", "name": a, "asin": b, "sourceRow": r}
            for i, f in enumerate(FIELDS):
                child[f] = num(ws.cell(r, 3 + i).value)
            current["children"].append(child)
        prev_blank = False
    for g in groups:
        if g["name"] is None:
            g["name"] = group_name(g["children"])
    countries.append({
        "id": cid,
        "label": label,
        "marketplaceIds": mkts,
        "columnLabels": {
            "items": headers[0], "asin": headers[1], "amazon": headers[2],
            "externalWarehouse": headers[3], "receiving": headers[4], "otw1": headers[5],
            "otw2": headers[6], "last30": headers[7], "monthsAmazon": headers[8],
            "monthsTotal": headers[9],
        },
        "groups": groups,
    })

out = {
    "source": "Weekly Meeting Table - Strongest Home - New.xlsx / inventory",
    "sheetLastUpdated": clean(ws["B1"].value),
    "importedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "countries": countries,
}
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, indent=2)

for c in countries:
    print(c["id"], c["columnLabels"]["amazon"], "|", c["columnLabels"]["last30"])
    for g in c["groups"]:
        print("   ", g["name"], len(g["children"]))
