/* Library view: catalog grid, search, and a "continue reading" shelf. */
import { progress, collapsed, settings } from "./store.js";
import { listImports } from "./imports.js";

const lastName = (a) => (a || "").trim().split(/\s+/).pop().toLowerCase();
const byTimeline = (a, b) =>
  (a.era ?? 1e9) - (b.era ?? 1e9) || (a.year ?? 0) - (b.year ?? 0) || a.title.localeCompare(b.title);
const byTitle = (a, b) =>
  lastName(a.author).localeCompare(lastName(b.author)) || a.title.localeCompare(b.title);

let catalog = null;

export async function loadCatalog() {
  if (catalog) return catalog;
  const res = await fetch("data/catalog.json");
  catalog = await res.json();
  return catalog;
}

export function getBook(id) {
  return catalog?.books.find((b) => b.id === id) || null;
}

function pct(book) {
  const p = progress.get(book.id);
  return p && p.percent ? Math.round(p.percent) : 0;
}

const tidy = (s) => (s || "").replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();

function cardHtml(book, { dismiss = false } = {}) {
  const off = !book.downloaded;
  const done = pct(book);
  const meta = [book.year, book.translator && `tr. ${tidy(book.translator)}`].filter(Boolean).join(" · ");
  const bar = done > 0 && !off
    ? `<div class="card__bar"><i style="width:${done}%"></i></div>` : "";
  const status = off
    ? `<span class="tag tag--off">not downloaded</span>`
    : (done ? `<span class="card__meta">${done}% read</span>` : "");
  const del = dismiss
    ? `<span class="card__del" data-clear="${book.id}" title="Remove from this shelf" aria-label="Remove from currently reading">✕</span>` : "";
  return `
    <button class="card ${off ? "card--off" : ""}" data-id="${book.id}" ${off ? "disabled" : ""}>
      ${del}
      <span class="card__title">${book.title}</span>
      <span class="card__author">${tidy(book.author)}</span>
      <span class="card__meta">${meta}</span>
      ${status}
      ${bar}
    </button>`;
}

/* "Your imports" shelf — books the reader added in-browser (IndexedDB). */
export async function renderImports(query = "") {
  const wrap = document.getElementById("imports-wrap");
  const list = document.getElementById("imports-list");
  const q = query.trim().toLowerCase();
  let items = [];
  try { items = await listImports(); } catch { /* IndexedDB unavailable */ }
  items = items.filter((b) => !q || b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q));
  if (!items.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  list.innerHTML = items.map((b) => {
    const done = progress.get(b.id)?.percent ? Math.round(progress.get(b.id).percent) : 0;
    const bar = done ? `<div class="card__bar"><i style="width:${done}%"></i></div>` : "";
    return `
      <button class="card" data-id="${b.id}">
        <span class="card__del" data-del="${b.id}" title="Remove" aria-label="Remove">✕</span>
        <span class="card__title">${escapeText(b.title)}</span>
        <span class="card__author">${escapeText(b.author)}</span>
        <span class="card__meta">${b.words.toLocaleString()} words${done ? ` · ${done}% read` : ""}</span>
        ${bar}
      </button>`;
  }).join("");
}

function escapeText(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function renderLibrary(root, query = "") {
  const q = query.trim().toLowerCase();
  const match = (b) =>
    !q || b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q);

  // Continue-reading shelf (downloaded books with saved progress, recent first).
  const reading = catalog.books
    .filter((b) => b.downloaded && progress.get(b.id)?.percent > 0)
    .sort((a, b) => (progress.get(b.id)?.at || 0) - (progress.get(a.id)?.at || 0));
  const contWrap = document.getElementById("continue-wrap");
  const contList = document.getElementById("continue-list");
  if (reading.length && !q) {
    contList.innerHTML = reading.slice(0, 6).map((b) => cardHtml(b, { dismiss: true })).join("");
    contWrap.hidden = false;
  } else {
    contWrap.hidden = true;
  }

  const cmp = settings.get().sort === "title" ? byTitle : byTimeline;
  root.innerHTML = catalog.sections.map((sec) => {
    const books = catalog.books.filter((b) => b.section === sec.id && match(b)).sort(cmp);
    if (!books.length) return "";
    // When searching, always show results expanded; otherwise honour saved state.
    const isCollapsed = !q && collapsed.get(sec.id);
    return `
      <section class="section${isCollapsed ? " section--collapsed" : ""}" data-section="${sec.id}">
        <button class="section__head" aria-expanded="${!isCollapsed}">
          <span class="section__title">${sec.title}</span>
          <span class="section__count">${books.length}</span>
          <span class="section__chev" aria-hidden="true">▾</span>
        </button>
        <div class="section__body">
          ${sec.blurb ? `<p class="section__blurb">${sec.blurb}</p>` : ""}
          <div class="book-grid">${books.map((b) => cardHtml(b)).join("")}</div>
        </div>
      </section>`;
  }).join("") || `<p class="notes-empty">No works match “${query}”.</p>`;
}
