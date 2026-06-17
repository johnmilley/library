#!/usr/bin/env python3
"""Build a deep, scholarly catalog from Gutenberg's master catalog.

Reads pg_catalog.csv (the full Project Gutenberg index) and selects
English-language, public-domain *Text* works whose PRIMARY author matches a
curated per-section author list. De-duplicates by title (keeping the lowest
Gutenberg id, which is usually the canonical edition), caps per author to keep
the library balanced, and merges new entries into data/catalog.json with
downloaded=false. Existing entries are left untouched.

    python3 scripts/curate.py --catalog /tmp/pg_catalog.csv --dry-run
    python3 scripts/curate.py --catalog /tmp/pg_catalog.csv

Then `python3 scripts/fetch_books.py` downloads the bodies.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "data" / "catalog.json"

# Per-author works cap (prolific authors otherwise dominate).
CAP = {"shakespeare": 45, "russian": 24, "english": 12, "western": 14, "bibles": 12}

# Sections where a work can exist in several worthwhile translations; we keep
# up to MAX_EDITIONS distinct translators per work rather than collapsing them.
TRANSLATED = {"russian", "western"}
MAX_EDITIONS = 3

# Primary-author match patterns. Bare surname where unambiguous; "Surname, First"
# where a surname is shared by several authors.
AUTHORS = {
    "russian": [
        "Dostoyevsky", "Tolstoy", "Turgenev", "Gogol", "Chekhov", "Pushkin",
        "Lermontov", "Goncharov", "Gorky", "Andreyev", "Kuprin", "Korolenko",
        "Garshin", "Saltykov", "Sologub", "Artsybashev", "Merezhkovsky",
        "Ostrovsky", "Krylov", "Leskov", "Aksakov", "Pisemsky", "Bunin",
    ],
    "english": [
        "Chaucer", "Malory", "Spenser, Edmund", "Sidney, Philip", "Marlowe",
        "Donne, John", "Herbert, George", "Milton, John", "Bunyan",
        "Dryden, John", "Defoe", "Swift, Jonathan", "Pope, Alexander",
        "Addison, Joseph", "Steele, Richard", "Richardson, Samuel",
        "Fielding, Henry", "Sterne, Laurence", "Smollett", "Johnson, Samuel",
        "Goldsmith, Oliver", "Sheridan, Richard", "Burns, Robert",
        "Blake, William", "Wordsworth, William", "Coleridge, Samuel",
        "Byron, George", "Shelley, Percy", "Keats, John", "Lamb, Charles",
        "Hazlitt, William", "Austen, Jane", "Scott, Walter", "Shelley, Mary",
        "Peacock, Thomas", "Dickens, Charles", "Thackeray", "Gaskell",
        "Brontë", "Bronte", "Eliot, George", "Trollope, Anthony",
        "Collins, Wilkie", "Carroll, Lewis", "Hardy, Thomas", "Meredith, George",
        "Butler, Samuel", "Gissing, George", "Stevenson, Robert", "Wilde, Oscar",
        "Kipling", "Doyle, Arthur Conan", "Wells, H. G.", "Bennett, Arnold",
        "Galsworthy", "Chesterton", "Conrad, Joseph", "Forster, E. M.",
        "Joyce, James", "Woolf, Virginia", "Lawrence, D. H.", "Mansfield, Katherine",
        "Tennyson", "Browning, Robert", "Browning, Elizabeth", "Arnold, Matthew",
        "Rossetti, Christina", "Rossetti, Dante", "Swinburne", "Housman",
        "Yeats", "Hopkins, Gerard",
    ],
    "shakespeare": ["Shakespeare, William"],
    "western": [
        "Homer", "Hesiod", "Aeschylus", "Sophocles", "Euripides", "Aristophanes",
        "Herodotus", "Thucydides", "Xenophon", "Plato", "Aristotle", "Plutarch",
        "Epictetus", "Sappho", "Pindar", "Demosthenes", "Lucian", "Marcus Aurelius",
        "Aurelius Antoninus", "Virgil", "Ovid", "Horace", "Catullus", "Lucretius",
        "Cicero", "Caesar, Julius", "Livy", "Tacitus", "Seneca", "Juvenal",
        "Sallust", "Suetonius", "Apuleius", "Plautus", "Terence", "Augustine",
        "Boethius", "Aquinas", "Dante", "Petrarch", "Boccaccio", "Machiavelli",
        "Erasmus", "More, Thomas", "Montaigne", "Bacon, Francis", "Descartes",
        "Hobbes", "Spinoza", "Pascal", "Locke, John", "Leibniz", "Berkeley, George",
        "Hume, David", "Rousseau", "Voltaire", "Montesquieu", "Kant", "Smith, Adam",
        "Burke, Edmund", "Paine, Thomas", "Hegel", "Schopenhauer", "Mill, John Stuart",
        "Nietzsche", "Kierkegaard", "Darwin, Charles", "Tocqueville", "Goethe",
    ],
}

# Bibles: matched by title keyword rather than author.
BIBLE_KEYWORDS = [
    "king james", "american standard", "douay", "world english bible",
    "young's literal", "webster", "darby", "revised version", "wycliffe",
    "geneva bible", "tyndale", "bible in basic english", "emphasized bible",
]

SKIP_TITLE = re.compile(r"index of the project gutenberg|complete project gutenberg",
                        re.IGNORECASE)


def norm_title(t: str) -> str:
    t = t.split("\n")[0].split("\r")[0].lower()
    t = re.sub(r"[^a-z0-9 ]", "", t)
    t = re.sub(r"^(the|a|an) ", "", t)
    return re.sub(r"\s+", " ", t).strip()


def slugify(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", title.split("\n")[0].lower()).strip("-")
    return re.sub(r"-+", "-", s)[:60] or "untitled"


def display_author(primary: str) -> str:
    parts = [p.strip() for p in primary.split(",")]
    names = [p for p in parts if not re.search(r"\d|BCE|CE\b", p)]
    if len(names) >= 2:
        return f"{names[1]} {names[0]}".strip()
    return names[0] if names else primary.strip()


def is_english(lang: str) -> bool:
    return "en" in [x.strip() for x in lang.split(";")]


def primary_author(authors: str) -> str:
    return authors.split(";")[0].strip()


def detect_translator(authors: str) -> str | None:
    """Best-guess translator: a secondary author, preferring one tagged
    [Translator]. Used for the translated sections to tell editions apart."""
    parts = [p.strip() for p in authors.split(";")]
    if len(parts) < 2:
        return None
    secs = parts[1:]
    tagged = [s for s in secs if "[translator]" in s.lower()]
    cand = re.sub(r"\[[^\]]*\]", "", (tagged[0] if tagged else secs[0])).strip(" ,")
    name = display_author(cand)
    return name or None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", default="/tmp/pg_catalog.csv")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    existing_ids = {b.get("gutenberg") for b in catalog["books"]}
    existing_slugs = {b["id"] for b in catalog["books"]}

    rows = list(csv.DictReader(open(args.catalog, encoding="utf-8")))
    rows = [r for r in rows if r["Type"] == "Text" and is_english(r["Language"])
            and not SKIP_TITLE.search(r["Title"])]

    # author pattern -> section, longest patterns first so "Eliot, George"
    # beats a bare "Eliot" if both ever appear.
    patterns = []
    for section, names in AUTHORS.items():
        for n in names:
            patterns.append((n.lower(), section))

    picked = {}  # gutenberg id -> entry
    per_author = {}  # (section, pattern) -> count
    row_by_gid = {int(r["Text#"]): r for r in rows}

    def match(prim, surname):
        # "Surname, First" patterns: substring on the primary author.
        # Bare-surname patterns: anchor on the surname segment so "Horace"
        # can't match the first name in "Walpole, Horace".
        for pat, sec in patterns:
            if "," in pat:
                if pat in prim:
                    return sec, (sec, pat)
            elif surname == pat or surname.startswith(pat + " "):
                return sec, (sec, pat)
        return None, None

    # Seed cumulative per-author counts from what's already in the catalog, so
    # re-running adds new translations without piling on an author's lesser works.
    for b in catalog["books"]:
        r = row_by_gid.get(b.get("gutenberg"))
        if not r:
            continue
        prim = primary_author(r["Authors"]).lower()
        _, key = match(prim, prim.split(",")[0].strip())
        if key:
            per_author[key] = per_author.get(key, 0) + 1

    for r in rows:
        gid = int(r["Text#"])
        if gid in existing_ids or gid in picked:
            continue
        prim = primary_author(r["Authors"]).lower()
        surname = prim.split(",")[0].strip()
        title = r["Title"].split("\n")[0].strip()
        section = None
        key = None

        # Bible match first (by title) — complete editions only, no single books.
        tl = title.lower()
        if "bible" in tl and any(k in tl for k in BIBLE_KEYWORDS) \
                and not re.search(r"\bbook \d|\bpart\b|\bvolume\b|, book|: ", tl):
            section, key = "bibles", ("bibles", "bible")
        if not section:
            section, key = match(prim, surname)
        if not section:
            continue

        if per_author.get(key, 0) >= CAP.get(section, 10):
            continue

        slug = slugify(title)
        if slug in existing_slugs:
            slug = f"{slug}-{gid}"
        existing_slugs.add(slug)

        entry = {
            "id": slug, "section": section, "title": title,
            "author": "Bible" if section == "bibles" else display_author(primary_author(r["Authors"])),
            "translator": detect_translator(r["Authors"]) if section in TRANSLATED else None,
            "year": None, "gutenberg": gid, "file": f"{slug}.txt",
        }
        entry = {k: v for k, v in entry.items() if v is not None}
        picked[gid] = entry
        per_author[key] = per_author.get(key, 0) + 1

    # De-dupe — seeded with what's ALREADY in the catalog so we never add a
    # duplicate-title English edition, and only add genuinely new translations.
    # Translated sections keep up to MAX_EDITIONS distinct translators per work.
    tsurname = lambda name: (name or "").split()[-1].lower() if name else ""
    seen = set()
    editions = {}
    for b in catalog["books"]:
        sec, nt = b["section"], norm_title(b["title"])
        if sec in TRANSLATED:
            seen.add((sec, nt, tsurname(b.get("translator"))))
            editions[(sec, nt)] = editions.get((sec, nt), 0) + 1
        else:
            seen.add((sec, nt))

    new_entries = []
    for e in sorted(picked.values(), key=lambda e: e["gutenberg"]):
        sec, nt = e["section"], norm_title(e["title"])
        if sec in TRANSLATED:
            tkey = (sec, nt, tsurname(e.get("translator")))
            if tkey in seen or editions.get((sec, nt), 0) >= MAX_EDITIONS:
                continue
            seen.add(tkey)
            editions[(sec, nt)] = editions.get((sec, nt), 0) + 1
        else:
            if (sec, nt) in seen:
                continue
            seen.add((sec, nt))
        new_entries.append(e)

    # Backfill translators onto existing translated-section entries.
    for b in catalog["books"]:
        if b["section"] in TRANSLATED and not b.get("translator"):
            r = row_by_gid.get(b.get("gutenberg"))
            if r:
                t = detect_translator(r["Authors"])
                if t:
                    b["translator"] = t

    # Report
    from collections import Counter
    c = Counter(e["section"] for e in new_entries)
    print(f"New works selected: {len(new_entries)}")
    for s in catalog["sections"]:
        print(f"  +{c[s['id']]:>4}  {s['title']}")
    cur = Counter(b["section"] for b in catalog["books"])
    print("Totals after merge:")
    for s in catalog["sections"]:
        print(f"   {cur[s['id']] + c[s['id']]:>4}  {s['title']}")
    print(f"  GRAND TOTAL: {len(catalog['books']) + len(new_entries)}")

    if args.dry_run:
        print("\n(dry run — catalog not modified)")
        return 0

    catalog["books"].extend(new_entries)
    CATALOG.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n",
                       encoding="utf-8")
    print(f"\nMerged. catalog.json now has {len(catalog['books'])} books.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
