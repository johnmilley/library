#!/usr/bin/env python3
"""Fetch public-domain book texts from Project Gutenberg into data/books/.

The catalog (data/catalog.json) is the single source of truth. Each book
entry carries a Gutenberg id and a target filename. This script downloads
the plain-text edition, strips the Gutenberg boilerplate, and records a
`downloaded: true` flag plus a rough `words` count back onto the catalog
so the web app can show what's actually available offline.

Usage:
    python3 scripts/fetch_books.py                 # fetch everything missing
    python3 scripts/fetch_books.py --all           # re-fetch everything
    python3 scripts/fetch_books.py id1 id2 ...      # fetch only these book ids
    python3 scripts/fetch_books.py --list           # show catalog status

No third-party dependencies — standard library only.
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "data" / "catalog.json"
BOOKS_DIR = ROOT / "data" / "books"

# Gutenberg serves the same text under a few URL shapes; try them in order.
URL_PATTERNS = [
    "https://www.gutenberg.org/cache/epub/{id}/pg{id}.txt",
    "https://www.gutenberg.org/files/{id}/{id}-0.txt",
    "https://www.gutenberg.org/files/{id}/{id}.txt",
]

START_RE = re.compile(r"\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG.*?\*\*\*",
                      re.IGNORECASE)
END_RE = re.compile(r"\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG.*?\*\*\*",
                    re.IGNORECASE)


def fetch_url(url: str) -> str | None:
    req = urllib.request.Request(url, headers={"User-Agent": "reading-room/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
        return None


def strip_boilerplate(raw: str) -> str:
    """Keep only the work itself, between the START/END markers."""
    start = START_RE.search(raw)
    if start:
        raw = raw[start.end():]
    end = END_RE.search(raw)
    if end:
        raw = raw[:end.start()]
    # Normalise line endings and collapse 3+ blank lines to a paragraph break.
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    raw = re.sub(r"\n{3,}", "\n\n", raw)
    return raw.strip() + "\n"


def fetch_book(book: dict) -> tuple[bool, int]:
    gid = book.get("gutenberg")
    if not gid:
        print(f"  ! {book['id']}: no gutenberg id, skipping")
        return False, 0
    for pattern in URL_PATTERNS:
        url = pattern.format(id=gid)
        raw = fetch_url(url)
        if raw and len(raw) > 2000:
            text = strip_boilerplate(raw)
            out = BOOKS_DIR / book["file"]
            out.write_text(text, encoding="utf-8")
            words = len(text.split())
            print(f"  + {book['id']}: {words:,} words  ({url})")
            return True, words
        time.sleep(0.4)
    print(f"  ! {book['id']}: all download URLs failed (gutenberg {gid})")
    return False, 0


def main() -> int:
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    books = catalog["books"]
    BOOKS_DIR.mkdir(parents=True, exist_ok=True)

    args = sys.argv[1:]
    if "--list" in args:
        for b in books:
            mark = "✓" if b.get("downloaded") else " "
            words = f"{b.get('words', 0):,}w" if b.get("downloaded") else "—"
            print(f"  [{mark}] {b['id']:<32} {words:>10}  {b['author']}")
        return 0

    force = "--all" in args
    ids = [a for a in args if not a.startswith("--")]

    selected = [b for b in books if (not ids or b["id"] in ids)]
    print(f"Fetching {len(selected)} book(s) into {BOOKS_DIR}\n")

    changed = 0
    for b in selected:
        already = (BOOKS_DIR / b["file"]).exists() and b.get("downloaded")
        if already and not force:
            print(f"  = {b['id']}: already present, skipping")
            continue
        ok, words = fetch_book(b)
        b["downloaded"] = ok
        if ok:
            b["words"] = words
            changed += 1
        time.sleep(0.6)  # be polite to Gutenberg

    CATALOG.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n",
                       encoding="utf-8")
    print(f"\nDone. {changed} book(s) fetched. Catalog updated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
