/* Reader view. Loads a book's plain text, splits it into paragraphs, detects
   chapters, renders highlights, and supports two reading modes:
     - scroll: continuous vertical scroll
     - paged:  e-reader style page-turning (CSS multi-column + translateX)
   Plus a table of contents, reading-time estimate, notes, and highlights. */
import { annotations, progress, settings, uid } from "./store.js";
import { readSelection, renderParagraph, escapeHtml } from "./annotate.js";

const WPM = 230; // words per minute, for time-left estimates

const els = {};
let current = null;          // { book, paras, paraEls, chapters, words }
let hlByPara = new Map();
let pendingSel = null;
let editingId = null;
let saveTimer = null;

// paged-mode state
let mode = "scroll";
let page = 0;
let totalPages = 1;
let stride = 1;
let gap = 0;

export function initReader(refs) {
  Object.assign(els, refs);

  els.scroll.addEventListener("mouseup", onSelectionChange);
  els.scroll.addEventListener("touchend", () => setTimeout(onSelectionChange, 10));

  els.book.addEventListener("click", (e) => {
    const mark = e.target.closest("mark.hl");
    if (mark) { openNote(mark.dataset.id); return; }
    if (mode === "paged") handlePageTap(e);
  });

  // Stop the native long-press / right-click menu so our highlight toolbar wins.
  els.book.addEventListener("contextmenu", (e) => e.preventDefault());

  els.selToolbar.querySelectorAll(".swatch").forEach((sw) =>
    sw.addEventListener("click", () => commitHighlight(sw.dataset.color, false)));
  els.selNote.addEventListener("click", () => commitHighlight("yellow", true));

  els.noteSave.addEventListener("click", saveNote);
  els.noteCancel.addEventListener("click", closeNote);
  els.noteDelete.addEventListener("click", deleteHighlight);
  els.noteDialog.addEventListener("click", (e) => { if (e.target === els.noteDialog) closeNote(); });

  els.scroll.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize);
  document.addEventListener("keydown", onKey);
}

export async function openBook(book) {
  current = { book, paras: [], paraEls: [], chapters: [], words: 0 };
  editingId = null;
  page = 0;
  els.title.textContent = book.title;
  els.author.textContent = book.author;
  els.book.innerHTML = `<p class="book__byline">Loading…</p>`;

  let raw = book.text;
  if (raw == null) {
    const res = await fetch(`data/books/${book.file}`);
    if (!res.ok) {
      els.book.innerHTML = `<p class="book__byline">This text isn’t downloaded yet. Run <code>python3 scripts/fetch_books.py ${book.id}</code>.</p>`;
      return;
    }
    raw = await res.text();
  }
  current.paras = paragraphsFrom(raw);
  current.words = current.paras.reduce((n, p) => n + p.split(/\s+/).length, 0);
  indexHighlights();
  detectChapters();
  applyReadingPrefs();
  renderBook();
  current.paraEls = [...els.book.querySelectorAll("p[data-i]")];
  setMode(settings.get().mode, /*restore*/ true);
}

function paragraphsFrom(raw) {
  return raw.replace(/\r\n?/g, "\n").split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").trim()).filter(Boolean);
}

function indexHighlights() {
  hlByPara = new Map();
  for (const h of annotations.get(current.book.id)) {
    if (!hlByPara.has(h.para)) hlByPara.set(h.para, []);
    hlByPara.get(h.para).push(h);
  }
}

/* ---------- Chapters ---------- */
const HEADING_RE = /^(chapter|part|book|canto|act|scene|letter|volume|prologue|epilogue|introduction)\b/i;
function isHeading(text) {
  if (text.length > 70) return false;
  if (HEADING_RE.test(text)) return true;
  if (/^[IVXLCDM]+\.?$/.test(text)) return true;          // roman numeral alone
  if (/^\d{1,3}\.?$/.test(text)) return true;              // number alone
  if (text.length <= 48 && text === text.toUpperCase() && /[A-Z]/.test(text)) return true; // ALL CAPS line
  return false;
}

function detectChapters() {
  current.chapters = [];
  current.paras.forEach((t, i) => {
    if (isHeading(t)) current.chapters.push({ para: i, label: t.replace(/\s+/g, " ").trim() });
  });
}

/* ---------- Rendering ---------- */
function renderBook() {
  const { book, paras } = current;
  let html = `<h1 class="book__h" data-i="-1">${escapeHtml(book.title)}</h1>` +
             `<p class="book__byline">${escapeHtml(book.author)}` +
             (book.translator ? ` &middot; translated by ${escapeHtml(book.translator)}` : "") +
             `</p>`;
  html += paras.map((text, i) => {
    const cls = isHeading(text) ? " class=\"heading\"" : "";
    return `<p data-i="${i}"${cls}>${renderParagraph(text, hlByPara.get(i))}</p>`;
  }).join("");
  els.book.innerHTML = html;
}

function repaintPara(i) {
  const p = els.book.querySelector(`p[data-i="${i}"]`);
  if (p) p.innerHTML = renderParagraph(current.paras[i], hlByPara.get(i));
}

export function applyReadingPrefs() {
  const s = settings.get();
  document.body.dataset.align = s.align;
  if (current && mode === "paged") {
    const anchor = currentParaIndex();
    requestAnimationFrame(() => { layoutPaged(); gotoPara(anchor, false); updateStatus(); });
  }
}

/* ---------- Mode switching ---------- */
export function setMode(next, restore = false) {
  if (!current) return;
  const saved = progress.get(current.book.id);
  const goStart = restore && !saved;          // fresh open → show the title page
  const anchor = restore ? (saved?.para ?? 0) : currentParaIndex();
  mode = next === "paged" ? "paged" : "scroll";
  els.scroll.dataset.mode = mode;
  els.reader.dataset.mode = mode;
  const settle = () => {
    if (goStart) { page = 0; mode === "paged" ? applyPage(false) : (els.scroll.scrollTop = 0); }
    else gotoPara(anchor, false);
    lastScroll = els.scroll.scrollTop;
    els.bar.classList.remove("hidden");
    updateStatus();
  };
  if (mode === "paged") { layoutPaged(); requestAnimationFrame(settle); }
  else { clearPagedStyles(); requestAnimationFrame(() => requestAnimationFrame(settle)); }
}

function clearPagedStyles() {
  for (const v of ["--col-w", "--col-gap", "--page-h", "--pad", "--page-x"])
    els.book.style.removeProperty(v);
}

/* ---------- Paged engine ---------- */
function layoutPaged() {
  const c = els.scroll;
  const pad = Math.max(18, Math.min(40, Math.round(c.clientWidth * 0.07)));
  stride = c.clientWidth;
  gap = pad * 2;
  const colW = stride - gap;
  els.book.style.setProperty("--col-w", colW + "px");
  els.book.style.setProperty("--col-gap", gap + "px");
  els.book.style.setProperty("--page-h", c.clientHeight + "px");
  els.book.style.setProperty("--pad", pad + "px");
  els.book.style.setProperty("--page-x", "0px");
  // force reflow then measure
  const sw = els.book.scrollWidth;
  totalPages = Math.max(1, Math.round((sw + gap) / stride));
  page = Math.min(page, totalPages - 1);
  applyPage(false);
}

function applyPage(animate = true) {
  els.book.style.transition = animate ? "" : "none";
  els.book.style.setProperty("--page-x", (page * stride) + "px");
  if (!animate) requestAnimationFrame(() => (els.book.style.transition = ""));
}

function goPage(delta) {
  const np = Math.min(Math.max(page + delta, 0), totalPages - 1);
  if (np === page) return;
  page = np;
  applyPage(true);
  saveProgress();
  updateStatus();
}

function handlePageTap(e) {
  if (!window.getSelection().isCollapsed) return;   // user is selecting text
  const x = e.clientX - els.scroll.getBoundingClientRect().left;
  const w = els.scroll.clientWidth;
  if (x < w * 0.32) goPage(-1);
  else if (x > w * 0.68) goPage(1);
  else els.bar.classList.toggle("hidden");          // center tap toggles chrome
}

/* page index of a paragraph element, using the current translate as reference */
function paraPage(el) {
  const cRect = els.scroll.getBoundingClientRect();
  const pad = parseFloat(els.book.style.getPropertyValue("--pad")) || 0;
  const rel = el.getBoundingClientRect().left - cRect.left - pad;
  return page + Math.round(rel / stride);
}

/* ---------- Navigation shared by both modes ---------- */
export function gotoPara(i, animate = true) {
  const el = current.paraEls.find((p) => Number(p.dataset.i) === i) || current.paraEls[0];
  if (!el) return;
  if (mode === "paged") {
    page = Math.min(Math.max(paraPage(el), 0), totalPages - 1);
    applyPage(animate);
  } else {
    els.scroll.scrollTo({ top: el.offsetTop - 12, behavior: animate ? "smooth" : "auto" });
  }
}

function currentParaIndex() {
  if (!current.paraEls.length) return 0;
  if (mode === "paged") {
    // first paragraph whose page >= current page (pages are monotonic in index)
    let lo = 0, hi = current.paraEls.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (paraPage(current.paraEls[mid]) >= page) { ans = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    return Number(current.paraEls[ans].dataset.i) || 0;
  }
  const top = els.scroll.scrollTop + 8;
  let lo = 0, hi = current.paraEls.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (current.paraEls[mid].offsetTop <= top) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return Number(current.paraEls[ans].dataset.i) || 0;
}

/* ---------- Progress + status ---------- */
function readingFraction() {
  const i = currentParaIndex();
  return current.paras.length ? Math.min(1, Math.max(0, i / current.paras.length)) : 0;
}

function currentChapterLabel() {
  const i = currentParaIndex();
  let label = "";
  for (const ch of current.chapters) { if (ch.para <= i) label = ch.label; else break; }
  return label;
}

function updateStatus() {
  const frac = readingFraction();
  els.progressFill.style.width = `${frac * 100}%`;
  const minsLeft = Math.round((current.words * (1 - frac)) / WPM);
  const pct = Math.round(frac * 100);
  const chap = currentChapterLabel();
  const left = minsLeft > 0 ? `${minsLeft} min left` : "finished";
  const pageInfo = mode === "paged" ? `${page + 1} / ${totalPages}` : `${pct}%`;
  els.status.innerHTML =
    `<span>${escapeHtml(chap || current.book.title)}</span>` +
    `<span>${pageInfo} · ${left}</span>`;
}

function saveProgress() {
  progress.set(current.book.id, {
    para: currentParaIndex(), percent: readingFraction() * 100, at: Date.now(),
  });
}

let lastScroll = 0;
function onScroll() {
  if (mode !== "scroll") return;
  const el = els.scroll;
  if (el.scrollTop > lastScroll + 6 && el.scrollTop > 80) els.bar.classList.add("hidden");
  else if (el.scrollTop < lastScroll - 6) els.bar.classList.remove("hidden");
  lastScroll = el.scrollTop;
  updateStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProgress, 350);
}

let resizeTimer = null;
function onResize() {
  if (!current || mode !== "paged") return;
  clearTimeout(resizeTimer);
  const anchor = currentParaIndex();
  resizeTimer = setTimeout(() => { layoutPaged(); gotoPara(anchor, false); updateStatus(); }, 150);
}

function onKey(e) {
  if (els.reader.hidden || mode !== "paged") return;
  if (e.key === "ArrowRight") goPage(1);
  else if (e.key === "ArrowLeft") goPage(-1);
}

/* ---------- Selection & highlights ---------- */
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
  const hl = { id: uid(), para: pendingSel.para, start: pendingSel.start,
    end: pendingSel.end, color, note: "", at: Date.now() };
  annotations.add(current.book.id, hl);
  if (!hlByPara.has(hl.para)) hlByPara.set(hl.para, []);
  hlByPara.get(hl.para).push(hl);
  repaintPara(hl.para);
  window.getSelection()?.removeAllRanges();
  hideToolbar();
  if (mode === "paged") layoutPaged();   // repaint may change column flow slightly
  if (withNote) openNote(hl.id);
}

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
  const list = annotations.get(current.book.id).slice()
    .sort((a, b) => a.para - b.para || a.start - b.start);
  if (!list.length) {
    els.notesList.innerHTML = `<p class="notes-empty">No highlights yet.<br>Select any text while reading to highlight it or attach a note.</p>`;
    return;
  }
  els.notesList.innerHTML = list.map((h) => {
    const quote = escapeHtml(current.paras[h.para].slice(h.start, h.end));
    const note = h.note ? `<span class="note-item__note">${escapeHtml(h.note)}</span>` : "";
    return `<button class="note-item" data-jump="${h.para}" data-id="${h.id}" style="--c:var(--hl-${h.color})">
        <span class="note-item__quote">“${quote}”</span>${note}</button>`;
  }).join("");
  els.notesList.querySelectorAll(".note-item").forEach((b) =>
    b.addEventListener("click", () => { closePanels(); flashJump(Number(b.dataset.jump), b.dataset.id); }));
}

/* ---------- Table of contents ---------- */
export function renderTOC() {
  if (!current.chapters.length) {
    els.tocList.innerHTML = `<p class="notes-empty">No chapters detected in this text.<br>Use the progress bar or search to navigate.</p>`;
    return;
  }
  const hereI = currentParaIndex();
  let activeIdx = 0;
  current.chapters.forEach((ch, k) => { if (ch.para <= hereI) activeIdx = k; });
  els.tocList.innerHTML = current.chapters.map((ch, k) =>
    `<button class="toc-item${k === activeIdx ? " toc-item--active" : ""}" data-jump="${ch.para}">${escapeHtml(ch.label)}</button>`
  ).join("");
  els.tocList.querySelectorAll(".toc-item").forEach((b) =>
    b.addEventListener("click", () => { closePanels(); gotoPara(Number(b.dataset.jump)); updateStatus(); }));
  const active = els.tocList.querySelector(".toc-item--active");
  if (active) active.scrollIntoView({ block: "center" });
}

function flashJump(para, id) {
  gotoPara(para);
  setTimeout(() => {
    const mark = els.book.querySelector(`mark[data-id="${id}"]`);
    if (mark) { mark.style.outline = "2px solid var(--accent)";
      setTimeout(() => (mark.style.outline = "none"), 1200); }
  }, mode === "paged" ? 320 : 420);
}

function closePanels() {
  els.notesPanel.hidden = true;
  els.tocPanel.hidden = true;
  els.scrim.hidden = true;
}

export function closeBook() {
  if (current) saveProgress();
  current = null;
  els.selToolbar.hidden = true;
}
