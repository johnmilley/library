#!/usr/bin/env python3
"""Add any Project Gutenberg book to the library with one command.

    python3 scripts/add_book.py 2554
    python3 scripts/add_book.py https://www.gutenberg.org/ebooks/1399
    python3 scripts/add_book.py 1399 --section russian --translator "Constance Garnett"

It downloads the text, auto-detects Title/Author/Translator from Gutenberg's
header, generates a slug id, drops the cleaned text into data/books/, and
appends an entry to data/catalog.json. Re-running with an existing id just
re-downloads. No third-party dependencies.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_books import (  # noqa: E402
    CATALOG, BOOKS_DIR, URL_PATTERNS, fetch_url, strip_boilerplate,
)


def parse_id(arg: str) -> int | None:
    m = re.search(r"(\d+)", arg)
    return int(m.group(1)) if m else None


def slugify(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return re.sub(r"-+", "-", s)[:60] or "untitled"


def detect_meta(raw: str) -> dict:
    """Pull Title/Author/Translator from the Gutenberg header block."""
    head = raw[:4000]
    def grab(label):
        m = re.search(rf"^{label}:\s*(.+)$", head, re.IGNORECASE | re.MULTILINE)
        return m.group(1).strip() if m else None
    return {
        "title": grab("Title"),
        "author": grab("Author"),
        "translator": grab("Translator"),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Add a Gutenberg book to the library.")
    ap.add_argument("source", help="Gutenberg id or ebook URL")
    ap.add_argument("--section", default="russian")
    ap.add_argument("--title")
    ap.add_argument("--author")
    ap.add_argument("--translator")
    ap.add_argument("--year", type=int)
    args = ap.parse_args()

    gid = parse_id(args.source)
    if not gid:
        print(f"Could not find a Gutenberg id in {args.source!r}")
        return 1

    raw = None
    for pattern in URL_PATTERNS:
        raw = fetch_url(pattern.format(id=gid))
        if raw and len(raw) > 2000:
            break
    if not raw:
        print(f"Download failed for Gutenberg id {gid}")
        return 1

    meta = detect_meta(raw)
    title = args.title or meta["title"] or f"Gutenberg #{gid}"
    author = args.author or meta["author"] or "Unknown"
    translator = args.translator or meta["translator"]

    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    book_id = slugify(title)
    if any(s["id"] == args.section for s in catalog["sections"]) is False:
        print(f"Note: section '{args.section}' is not defined in the catalog yet.")

    text = strip_boilerplate(raw)
    BOOKS_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"{book_id}.txt"
    (BOOKS_DIR / fname).write_text(text, encoding="utf-8")

    entry = {
        "id": book_id, "section": args.section, "title": title, "author": author,
        "translator": translator, "year": args.year, "gutenberg": gid,
        "file": fname, "downloaded": True, "words": len(text.split()),
    }
    entry = {k: v for k, v in entry.items() if v is not None}

    existing = next((b for b in catalog["books"] if b["id"] == book_id), None)
    if existing:
        existing.update(entry)
        action = "Updated"
    else:
        catalog["books"].append(entry)
        action = "Added"

    CATALOG.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n",
                       encoding="utf-8")
    print(f"{action}: {title} — {author}"
          + (f" (tr. {translator})" if translator else "")
          + f"  [{entry['words']:,} words]\n  id: {book_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
