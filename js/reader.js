/* Reader view: loads a book's plain text, paginates it into paragraphs,
   renders highlights, tracks progress, and drives the notes panel + editor. */
import { annotations, progress, uid } from "./store.js";
import { readSelection, renderParagraph, escapeHtml } from "./annotate.js";

const els = {};
let current = null;          // { book, paras }
let hlByPara = new Map();    // para index -> [highlights]
let pendingSel = null;       // selection awaiting a colour choice
let editingId = null;        // highlight id open in the note dialog
let saveTimer = null;

export function initReader(refs) {
  Object.assign(els, refs);

  // Selection -> floating toolbar
  els.scroll.addEventListener("mouseup", onSelectionChange);
  els.scroll.addEventListener("touchend", () => setTimeout(onSelectionChange, 10));

  // Clicking an existing highlight opens its note editor
  els.book.addEventListener("click", (e) => {
    const mark = e.target.closest("mark.hl");
    if (mark) openNote(mark.dataset.id);
  });

  // Selection toolbar buttons
  els.selToolbar.querySelectorAll(".swatch").forEach((sw) =>
    sw.addEventListener("click", () => commitHighlight(sw.dataset.color, false)));
  els.selNote.addEventListener("click", () => commitHighlight("yellow", true));

  // Note dialog
  els.noteSave.addEventListener("click", saveNote);
  els.noteCancel.addEventListener("click", closeNote);
  els.noteDelete.addEventListener("click", deleteHighlight);

  // Progress tracking + auto-hide bar
  els.scroll.addEventListener("scroll", onScroll, { passive: true });
}

export async function openBook(book) {
  current = { book, paras: [] };
  editingId = null;
  els.title.textContent = book.title;
  els.author.textContent = book.author;
  els.book.innerHTML = `<p class="book__byline">Loading…</p>`;

  const res = await fetch(`data/books/${book.file}`);
  if (!res.ok) {
    els.book.innerHTML = `<p class="book__byline">This text isn’t downloaded yet. Run <code>python3 scripts/fetch_books.py ${book.id}</code>.</p>`;
    return;
  }
  const raw = await res.text();
  current.paras = paragraphsFrom(raw);
  indexHighlights();
  renderBook();
  restoreProgress();
}

/* Split plain text into display paragraphs (blank-line separated blocks). */
function paragraphsFrom(raw) {
  return raw
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter(Boolean);
}

function indexHighlights() {
  hlByPara = new Map();
  for (const h of annotations.get(current.book.id)) {
    if (!hlByPara.has(h.para)) hlByPara.set(h.para, []);
    hlByPara.get(h.para).push(h);
  }
}

function isHeading(text) {
  // Short, punctuation-light lines (chapter markers etc.) get centred.
  return text.length <= 60 && /^(chapter|part|book|[ivxlcdm]+\.?$|[0-9]+\.?$)/i.test(text);
}

function renderBook() {
  const { book, paras } = current;
  let html = `<h1 class="book__h">${escapeHtml(book.title)}</h1>` +
             `<p class="book__byline">${escapeHtml(book.author)}` +
             (book.translator ? ` &middot; translated by ${escapeHtml(book.translator)}` : "") +
             `</p>`;
  html += paras.map((text, i) => {
    const cls = isHeading(text) ? "heading" : "";
    return `<p data-i="${i}"${cls ? ` class="${cls}"` : ""}>${renderParagraph(text, hlByPara.get(i))}</p>`;
  }).join("");
  els.book.innerHTML = html;
}

function repaintPara(i) {
  const p = els.book.querySelector(`p[data-i="${i}"]`);
  if (p) p.innerHTML = renderParagraph(current.paras[i], hlByPara.get(i));
}

/* ---------- Selection & highlight creation ---------- */
function onSelectionChange() {
  const sel = readSelection(els.book);
  if (!sel) { hideToolbar(); return; }
  pendingSel = sel;
  showToolbar(sel.rect);
}

function showToolbar(rect) {
  const tb = els.selToolbar;
  tb.hidden = false;
  const top = rect.top - tb.offsetHeight - 10;
  tb.style.left = `${Math.min(Math.max(rect.left + rect.width / 2, 90), window.innerWidth - 90)}px`;
  tb.style.top = `${top < 8 ? rect.bottom + 10 : top}px`;
}
function hideToolbar() { els.selToolbar.hidden = true; pendingSel = null; }

function commitHighlight(color, withNote) {
  if (!pendingSel) return;
  const hl = {
    id: uid(), para: pendingSel.para, start: pendingSel.start,
    end: pendingSel.end, color, note: "", at: Date.now(),
  };
  annotations.add(current.book.id, hl);
  if (!hlByPara.has(hl.para)) hlByPara.set(hl.para, []);
  hlByPara.get(hl.para).push(hl);
  repaintPara(hl.para);
  window.getSelection()?.removeAllRanges();
  hideToolbar();
  if (withNote) openNote(hl.id);
}

/* ---------- Note dialog ---------- */
function findHl(id) {
  for (const list of hlByPara.values()) {
    const h = list.find((x) => x.id === id);
    if (h) return h;
  }
  return null;
}

function openNote(id) {
  const hl = findHl(id);
  if (!hl) return;
  editingId = id;
  els.noteQuote.textContent = current.paras[hl.para].slice(hl.start, hl.end);
  els.noteText.value = hl.note || "";
  els.noteDialog.hidden = false;
  els.noteText.focus();
}
function closeNote() { els.noteDialog.hidden = true; editingId = null; }

function saveNote() {
  if (!editingId) return;
  const note = els.noteText.value.trim();
  annotations.update(current.book.id, editingId, { note });
  const hl = findHl(editingId);
  if (hl) { hl.note = note; repaintPara(hl.para); }
  closeNote();
  if (!els.notesPanel.hidden) renderNotes();
}

function deleteHighlight() {
  if (!editingId) return;
  const hl = findHl(editingId);
  annotations.remove(current.book.id, editingId);
  if (hl) {
    hlByPara.set(hl.para, (hlByPara.get(hl.para) || []).filter((x) => x.id !== editingId));
    repaintPara(hl.para);
  }
  closeNote();
  if (!els.notesPanel.hidden) renderNotes();
}

/* ---------- Notes panel ---------- */
export function renderNotes() {
  const list = annotations.get(current.book.id)
    .slice()
    .sort((a, b) => a.para - b.para || a.start - b.start);
  if (!list.length) {
    els.notesList.innerHTML = `<p class="notes-empty">No highlights yet.<br>Select any text while reading to highlight it or attach a note.</p>`;
    return;
  }
  els.notesList.innerHTML = list.map((h) => {
    const quote = escapeHtml(current.paras[h.para].slice(h.start, h.end));
    const note = h.note ? `<span class="note-item__note">${escapeHtml(h.note)}</span>` : "";
    return `<button class="note-item" data-jump="${h.para}" data-id="${h.id}" style="--c:var(--hl-${h.color})">
        <span class="note-item__quote">“${quote}”</span>${note}
      </button>`;
  }).join("");
  els.notesList.querySelectorAll(".note-item").forEach((b) =>
    b.addEventListener("click", () => jumpTo(Number(b.dataset.jump), b.dataset.id)));
}

function jumpTo(para, id) {
  els.notesPanel.hidden = true;
  els.scrim.hidden = true;
  const p = els.book.querySelector(`p[data-i="${para}"]`);
  if (p) {
    p.scrollIntoView({ behavior: "smooth", block: "center" });
    const mark = p.querySelector(`mark[data-id="${id}"]`);
    if (mark) { mark.style.transition = "outline .4s"; mark.style.outline = "2px solid var(--accent)";
      setTimeout(() => (mark.style.outline = "none"), 1200); }
  }
}

/* ---------- Progress & chrome ---------- */
let lastScroll = 0;
function onScroll() {
  const el = els.scroll;
  const max = el.scrollHeight - el.clientHeight;
  const percent = max > 0 ? (el.scrollTop / max) * 100 : 0;
  els.progressFill.style.width = `${percent}%`;

  // Auto-hide top bar on scroll down, reveal on scroll up.
  if (el.scrollTop > lastScroll + 6 && el.scrollTop > 80) els.bar.classList.add("hidden");
  else if (el.scrollTop < lastScroll - 6) els.bar.classList.remove("hidden");
  lastScroll = el.scrollTop;

  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    progress.set(current.book.id, { scrollTop: el.scrollTop, percent, at: Date.now() });
  }, 350);
}

function restoreProgress() {
  const p = progress.get(current.book.id);
  els.bar.classList.remove("hidden");
  // Defer until layout settles so scrollTop is honoured.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (p?.scrollTop) els.scroll.scrollTop = p.scrollTop;
    onScroll();
  }));
}

export function closeBook() {
  current = null;
  els.selToolbar.hidden = true;
}
