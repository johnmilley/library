# The Reading Room

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
  reader.js           Book rendering, selection→highlight, notes, progress
  annotate.js         Highlight engine: offset math + paragraph rendering
data/
  catalog.json        Source of truth: sections + books with metadata
  books/*.txt         Cleaned plain-text bodies (git-ignored; fetched locally)
scripts/
  fetch_books.py      Download catalog books from Gutenberg, update flags
  add_book.py         One-command import of any Gutenberg id/URL
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
