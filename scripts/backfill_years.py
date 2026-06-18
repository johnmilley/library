#!/usr/bin/env python3
"""Backfill an `era` (author's birth year) onto each catalog book, parsed from
Project Gutenberg's author dates. Used as the chronological sort key so each
section reads as a timeline. Negative = BCE. Real publication `year` fields are
left untouched. Run after curate.py / add_book.py.

    python3 scripts/backfill_years.py
"""
from __future__ import annotations
import csv, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "data" / "catalog.json"
PG = Path("/tmp/pg_catalog.csv")


def birth_year(authors: str):
    prim = authors.split(";")[0]
    # birth year sits just before the dash in "..., 1821-1881" / "428? BCE-348? BCE"
    m = re.search(r"(\d{1,4})\??\s*(BCE)?\s*[-–]", prim)
    if not m:
        return None
    y = int(m.group(1))
    return -y if m.group(2) else y


def main() -> int:
    if not PG.exists():
        print("Need /tmp/pg_catalog.csv (download from gutenberg.org/cache/epub/feeds/).")
        return 1
    rows = {int(r["Text#"]): r for r in csv.DictReader(open(PG, encoding="utf-8"))}
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))

    filled = 0
    for b in catalog["books"]:
        r = rows.get(b.get("gutenberg"))
        if not r:
            continue
        era = birth_year(r["Authors"])
        if era is not None:
            b["era"] = era
            filled += 1

    CATALOG.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n",
                       encoding="utf-8")
    print(f"Set era on {filled}/{len(catalog['books'])} books.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
