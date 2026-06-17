/* Library view: catalog grid, search, and a "continue reading" shelf. */
import { progress } from "./store.js";
import { listImports } from "./imports.js";

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

function cardHtml(book) {
  const off = !book.downloaded;
  const done = pct(book);
  const meta = [book.year, book.translator && `tr. ${book.translator}`].filter(Boolean).join(" · ");
  const bar = done > 0 && !off
    ? `<div class="card__bar"><i style="width:${done}%"></i></div>` : "";
  const status = off
    ? `<span class="tag tag--off">not downloaded</span>`
    : (done ? `<span class="card__meta">${done}% read</span>` : "");
  return `
    <button class="card ${off ? "card--off" : ""}" data-id="${book.id}" ${off ? "disabled" : ""}>
      <span class="card__title">${book.title}</span>
      <span class="card__author">${book.author}</span>
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
    contList.innerHTML = reading.slice(0, 4).map(cardHtml).join("");
    contWrap.hidden = false;
  } else {
    contWrap.hidden = true;
  }

  root.innerHTML = catalog.sections.map((sec) => {
    const books = catalog.books.filter((b) => b.section === sec.id && match(b));
    if (!books.length) return "";
    return `
      <section class="section">
        <h2 class="section__title">${sec.title}</h2>
        ${sec.blurb ? `<p class="section__blurb">${sec.blurb}</p>` : ""}
        <div class="book-grid">${books.map(cardHtml).join("")}</div>
      </section>`;
  }).join("") || `<p class="notes-empty">No works match “${query}”.</p>`;
}
