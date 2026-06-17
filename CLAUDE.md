# Readpublica

A clean, mobile-first reader for freely accessible public-domain classics in
plain text. Vanilla HTML/CSS/JS front-end + a small Python toolchain for
populating the library from Project Gutenberg. No build step, no framework, no
backend — it deploys as static files (GitHub Pages compatible; all paths
relative).

## Why the corpus looks the way it does

The original texts are public domain, but **translations carry their own
copyright**. The "good free translations" are therefore the early-1900s ones —
Constance Garnett, the Maudes, Eva Martin — which is what the catalog uses.
That effectively caps the free corpus at the 19th / early-20th-century canon;
modern translations and living authors can't be included for free.

## Layout

```
index.html            Single-page shell: library view + reader view
css/style.css         All styling; themes via CSS custom properties
js/
  app.js              Bootstrap, hash routing (#/ and #/read/<id>), settings
  store.js            localStorage layer (settings, progress, annotations)
  library.js          Catalog load, search, card grid, "continue reading"
  reader.js           Rendering, scroll/paged modes, TOC, highlights, notes
  annotate.js         Highlight engine: offset math + paragraph rendering
  imports.js          In-browser book import stored in IndexedDB
data/
  catalog.json        Source of truth: sections + books with metadata
  books/*.txt         Cleaned plain-text bodies (git-ignored; fetched locally)
scripts/
  fetch_books.py      Download catalog books from Gutenberg (resumable,
                      checkpoints catalog every 25, loose title verification)
  add_book.py         One-command import of any Gutenberg id/URL
  curate.py           Bulk-build the catalog from Gutenberg's pg_catalog.csv
                      by curated per-section author lists (see below)
```

## Data model (localStorage, prefix `rr:`)

- `rr:settings` — `{ theme, font, fontSize, lineHeight }` (global)
- `rr:progress:<bookId>` — `{ scrollTop, percent, at }`
- `rr:anno:<bookId>` — `[{ id, para, start, end, color, note, at }]`

A **highlight** is a character range within one paragraph (`para` = paragraph
index, `start`/`end` = offsets into that paragraph's text). Selections are
constrained to a single paragraph so offsets stay stable across reloads.
Overlapping highlights are resolved per character (last one wins) when
rendering, so the output is always a flat, non-nested run of `<mark>`s.

## Catalog entry shape

```json
{
  "id": "crime-and-punishment", "section": "russian",
  "title": "Crime and Punishment", "author": "Fyodor Dostoevsky",
  "translator": "Constance Garnett", "year": 1866,
  "gutenberg": 2554, "file": "crime-and-punishment.txt",
  "downloaded": true, "words": 203505
}
```

`downloaded`/`words` are written by the fetch scripts. A book with
`downloaded:false` shows in the library greyed-out ("not downloaded").

Sections currently: `russian`, `english`, `shakespeare`, `western`
(Classics of Western Civilisation), `bibles`. Note the RSVCE is copyrighted
and cannot be offered — `bibles` uses the public-domain KJV and Douay-Rheims.

## Reading features (reader.js)

- **Two modes** (`settings.mode`): `scroll` (continuous) and `paged` (e-reader
  page-turning via CSS multi-column + `translateX`; tap left/right thirds or
  arrow keys to turn, center tap toggles chrome). Page count/anchor recompute
  on resize and on font/spacing/alignment changes.
- **Position is paragraph-anchored** (`progress = {para, percent}`), so it
  survives mode switches, font changes, and reflow — not a raw scrollTop.
- **Table of contents**: `detectChapters()` finds headings (Chapter/Part/Book/
  Act/Scene/roman/number/ALL-CAPS lines); the ☰ panel lists them with the
  current chapter highlighted and jumps on click.
- **Reading-time estimate**: words remaining ÷ 230 wpm, shown in the status bar
  with % (scroll) or page x/y (paged) and the current chapter.
- **Alignment** (`settings.align`): `left` (ragged, default — easiest on small
  screens) or `justify`.

## Bulk curation (curate.py)

`curate.py` reads Gutenberg's `pg_catalog.csv` and selects English-language
Text works whose PRIMARY author matches curated per-section lists in `AUTHORS`.
Bare-surname patterns anchor on the surname segment (so "Horace" can't match
"Walpole, Horace"); "Surname, First" patterns substring-match for disambiguation.
De-dupes by normalized title (lowest gid wins), caps per author (`CAP`), and
merges new entries (downloaded=false) without touching existing ones. Bibles are
matched by title and restricted to complete editions. Run with `--dry-run` first.
The RSVCE is copyright and intentionally excluded.

## Imported books (IndexedDB)

Books the reader adds in-browser (the ＋ button → open a .txt or paste text)
are stored in IndexedDB under db `reading-room`, store `imports`, with ids
prefixed `import:`. They appear in a "Your imports" shelf and are opened by
`route()` loading the record and passing its `text` straight to `openBook`
(catalog books instead lazy-fetch their file). Highlights/notes/progress key
off the `import:<uuid>` id, so all reader features work unchanged. Importing a
Gutenberg *URL* still goes through `scripts/add_book.py` (browser fetches of
gutenberg.org are blocked by CORS).

## Adding books

```bash
python3 scripts/add_book.py 2554                 # any Gutenberg id or URL
python3 scripts/add_book.py <id> --section russian --author "…" --year 1866
python3 scripts/fetch_books.py                   # fetch everything missing
python3 scripts/fetch_books.py --list            # show status
```

`add_book.py` downloads the text, strips Gutenberg boilerplate, auto-detects
Title/Author/Translator from the header, slugifies an id, and appends to
`catalog.json`. To add a whole new shelf (e.g. an English section), add a
section to `catalog.json` then import with `--section <id>`.

## Run locally

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```
ES modules require http(s), so open via a server, not `file://`.

## Conventions

- Vanilla everything; no dependencies in the browser, stdlib-only in Python.
- All asset paths relative (GitHub Pages friendly).
- Themes/typography are CSS variables set on `:root`/`body` by `applySettings()`.
- Keep selection-based highlighting single-paragraph; don't introduce
  cross-paragraph ranges without revisiting the offset model.
