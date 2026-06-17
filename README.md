# Readpublica

A clean, distraction-free reader for public-domain classics — built for phones
and small desktop windows. Highlight, take notes, and pick up where you left
off. No accounts, no tracking; your notes live in your browser.

Starts with a **Russian Classics** shelf (Dostoevsky, Tolstoy, Turgenev,
Gogol, Chekhov, Lermontov…) in the public-domain translations of Constance
Garnett, the Maudes, and their contemporaries.

## Features

- 📖 Two reading modes — continuous **scroll** or e-reader **page-turning**
- 🔤 Adjustable text size, spacing, serif/sans, ragged/justified, and
  light / sepia / dark themes
- 🗂 **Table of contents** with chapter detection and jump-to-chapter
- ⏱ Live **reading-time estimate**, progress %, and current chapter
- ✏️ Select any text to **highlight** (four colours) or attach a **note**
- 📝 A per-book notes panel; tap any note to jump back to the passage
- 🔖 Paragraph-anchored position memory + a "continue reading" shelf
- ➕ Add your own books — open a `.txt` or paste text (stored in your browser)
- 📱 Mobile-first; chrome auto-hides while you read
- ⚡️ Static site — deploys to GitHub Pages, works offline once loaded

## Run locally

```bash
python3 scripts/fetch_books.py     # download the catalog's texts
python3 -m http.server 8000        # open http://localhost:8000
```

## Add more books

```bash
python3 scripts/add_book.py 2554                         # any Gutenberg id…
python3 scripts/add_book.py https://www.gutenberg.org/ebooks/1399   # …or URL
```

See `CLAUDE.md` for architecture and data model.

## A note on scope

Original texts are public domain, but translations carry their own copyright,
so the free corpus is the 19th / early-20th-century canon. Texts come from
[Project Gutenberg](https://www.gutenberg.org).
