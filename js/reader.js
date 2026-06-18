/* Reader view. Loads a book's plain text, splits it into paragraphs, detects
   chapters, renders highlights, and supports two reading modes:
     - scroll: continuous vertical scroll
     - paged:  e-reader style page-turning (CSS multi-column + translateX)
   Plus a table of contents, reading-time estimate, notes, and highlights. */
import { annotations, progress, settings, uid } from "./store.js";
import { readSelection, renderParagraph, escapeHtml } from "./annotate.js";

const WPM = 230; // words per minute, for time-left estimates
const IMG_MARK = "", ALT_MARK = ""; // image-block sentinels (see epub.js)

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
let touchStart = null;     // swipe tracking
let suppressTap = false;   // ignore the click a swipe would otherwise fire

export function initReader(refs) {
  Object.assign(els, refs);

  els.scroll.addEventListener("mouseup", onSelectionChange);
  els.scroll.addEventListener("touchstart", (e) => {
    touchStart = e.touches.length === 1
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
  }, { passive: true });
  els.scroll.addEventListener("touchend", (e) => {
    setTimeout(onSelectionChange, 10);
    handleSwipe(e);
  }, { passive: true });

  els.book.addEventListener("click", (e) => {
    const mark = e.target.closest("mark.hl");
    if (mark) { openNote(mark.dataset.id); return; }
    if (!window.getSelection().isCollapsed) return;   // selecting text
    const x = e.clientX - els.scroll.getBoundingClientRect().left;
    // A tap in the strip where the bar lives reveals it (when hidden), either mode.
    if (els.bar.classList.contains("hidden") && e.clientY <= els.bar.offsetHeight + 4) {
      els.bar.classList.remove("hidden"); return;
    }
    if (mode === "paged") { handlePageTap(e); return; }
    // Scroll mode: a tap in the middle band toggles the bar.
    const w = els.scroll.clientWidth;
    if (x > w * 0.30 && x < w * 0.70) els.bar.classList.toggle("hidden");
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
  current = { book, paras: [], paraEls: [], chapters: [], chapterParas: new Set(), words: 0 };
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
  current.paraEls = [...els.book.querySelectorAll("[data-i]")].filter((el) => Number(el.dataset.i) >= 0);
  setMode(settings.get().mode, /*restore*/ true);
}

function paragraphsFrom(raw) {
  return raw.replace(/\r\n?/g, "\n").split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").trim()).filter(Boolean);
}

/* Normalise old single-paragraph highlights {para,start,end} to the span shape
   {sp,so,ep,eo} so both load seamlessly. */
function normHl(h) {
  return h.sp !== undefined ? h : { ...h, sp: h.para, so: h.start, ep: h.para, eo: h.end };
}

/* Text covered by a highlight span, across paragraphs. */
function hlText(h) {
  const p = current.paras;
  if (h.sp === h.ep) return (p[h.sp] || "").slice(h.so, h.eo);
  const parts = [(p[h.sp] || "").slice(h.so)];
  for (let i = h.sp + 1; i < h.ep; i++) parts.push(p[i] || "");
  parts.push((p[h.ep] || "").slice(0, h.eo));
  return parts.filter(Boolean).join(" ").trim();
}

// Build per-paragraph mark segments from (possibly multi-paragraph) highlights.
function indexHighlights() {
  hlByPara = new Map();
  const paras = current.paras;
  for (const raw of annotations.get(current.book.id)) {
    const h = normHl(raw);
    for (let i = h.sp; i <= h.ep && i < paras.length; i++) {
      const start = i === h.sp ? h.so : 0;
      const end = i === h.ep ? h.eo : paras[i].length;
      if (end <= start) continue;
      if (!hlByPara.has(i)) hlByPara.set(i, []);
      hlByPara.get(i).push({ id: h.id, color: h.color, note: h.note, start, end });
    }
  }
}

// Rebuild + repaint the paragraphs a highlight touches, keeping the reader's
// place in paged mode (a mark can nudge the column flow).
function refreshSpan(sp, ep) {
  const anchor = mode === "paged" ? currentParaIndex() : null;
  indexHighlights();
  for (let i = sp; i <= ep; i++) repaintPara(i);
  if (mode === "paged") { layoutPaged(); gotoPara(anchor ?? sp, false); }
}

/* ---------- Chapters ----------
   Tiered, pattern-based detection, informed by the real divider styles in
   these texts:
   - Tier A (high confidence): structural keywords (CHAPTER/PART/BOOK/ACT/
     SCENE/CANTO/LETTER/…) and bare roman numerals (I, II, IV, …).
   - Tier B (fallback): ALL-CAPS or numbered title lines — used only when a
     book has no structural headings (e.g. a short-story collection whose only
     dividers are caps titles like THE SISTERS / ARABY).
   - A book's own "Contents" listing (a run of headings with almost no body
     text between them) is removed so the table of contents isn't doubled. */
const KW_RE = /^(chapter|part|section|book|canto|act|scene|volume|stave|letter|prologue|epilogue|fytte|introduction|argument)\b/i;
// Strict roman numeral (uppercase), e.g. I, II, IV, XIV — rejects words like "DID".
const ROMAN_RE = /^(?=[MDCLXVI])M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})\.?$/;

function classifyLine(t) {
  if (KW_RE.test(t)) return "kw";
  // bare roman numeral, but skip a lone C/D/L/M (usually an initial or list mark)
  if (ROMAN_RE.test(t) && !/^[CDLM]\.?$/.test(t)) return "roman";
  if (/^\d{1,3}[.)]?$/.test(t)) return "num";
  if (t === t.toUpperCase() && /[A-Z]/.test(t) && t.length <= 48 && t.split(/\s+/).length <= 8) return "caps";
  return null;
}

function detectChapters() {
  const paras = current.paras;
  const len = paras.map((p) => (p.startsWith(IMG_MARK) ? 0 : p.length));
  const cand = [];
  paras.forEach((t, i) => {
    if (t.startsWith(IMG_MARK) || t.length > 64) return;
    const type = classifyLine(t);
    if (type) cand.push({ i, type, label: t });
  });

  // Drop dense runs (>=4 candidates with <200 chars of body between each) —
  // that's the book's own contents listing, measured by text not paragraphs
  // (so books with very long paragraphs aren't mistaken for a listing).
  const drop = new Set();
  const bodyBetween = (a, b) => {
    let n = 0;
    for (let k = cand[a].i + 1; k < cand[b].i; k++) n += len[k];
    return n;
  };
  for (let k = 0; k < cand.length;) {
    let j = k;
    while (j + 1 < cand.length && bodyBetween(j, j + 1) < 200) j++;
    if (j - k + 1 >= 4) for (let m = k; m <= j; m++) drop.add(m);
    k = j + 1;
  }
  let chosen = cand.filter((_, idx) => !drop.has(idx));
  const structural = chosen.filter((c) => c.type === "kw" || c.type === "roman");
  if (structural.length >= 3) chosen = structural;   // ignore caps/num noise when structure exists

  current.chapters = chosen.map((c) => ({ para: c.i, label: c.label.replace(/\s+/g, " ").trim() }));
  current.chapterParas = new Set(current.chapters.map((c) => c.para));
}

/* ---------- Rendering ---------- */
function renderBook() {
  const { book, paras } = current;
  let html = `<h1 class="book__h" data-i="-1">${escapeHtml(book.title)}</h1>` +
             `<p class="book__byline">${escapeHtml(book.author)}` +
             (book.translator ? ` &middot; translated by ${escapeHtml(book.translator)}` : "") +
             `</p>`;
  html += paras.map((text, i) => {
    if (text.startsWith(IMG_MARK)) {
      const [url, alt = ""] = text.slice(IMG_MARK.length).split(ALT_MARK);
      return `<figure class="book__img" data-i="${i}"><img src="${url}" alt="${escapeHtml(alt)}" loading="lazy"></figure>`;
    }
    const cls = current.chapterParas.has(i) ? " class=\"heading\"" : "";
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
  if (suppressTap) return;                          // a swipe already turned the page
  if (!window.getSelection().isCollapsed) return;   // user is selecting text
  const x = e.clientX - els.scroll.getBoundingClientRect().left;
  const w = els.scroll.clientWidth;
  if (x < w * 0.32) goPage(-1);
  else if (x > w * 0.68) goPage(1);
  else els.bar.classList.toggle("hidden");          // center tap toggles chrome
}

// Horizontal swipe in paged mode: left → next page, right → previous.
function handleSwipe(e) {
  const start = touchStart;
  touchStart = null;
  if (mode !== "paged" || !start || !window.getSelection().isCollapsed) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - start.x, dy = t.clientY - start.y;
  if (Date.now() - start.t < 800 && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    suppressTap = true;
    setTimeout(() => (suppressTap = false), 400);
    goPage(dx < 0 ? 1 : -1);
  }
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
  const top = els.scroll.scrollTop;
  // Never auto-hide; but scrolling up reveals the bar if it was tapped away.
  if (top < lastScroll - 4 && els.bar.classList.contains("hidden")) {
    els.bar.classList.remove("hidden");
  }
  lastScroll = top;
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
  const hl = { id: uid(), sp: pendingSel.sp, so: pendingSel.so,
    ep: pendingSel.ep, eo: pendingSel.eo, color, note: "", at: Date.now() };
  annotations.add(current.book.id, hl);
  window.getSelection()?.removeAllRanges();
  hideToolbar();
  refreshSpan(hl.sp, hl.ep);
  if (withNote) openNote(hl.id);
}

function findHl(id) {
  const raw = annotations.get(current.book.id).find((h) => h.id === id);
  return raw ? normHl(raw) : null;
}
function openNote(id) {
  const hl = findHl(id);
  if (!hl) return;
  editingId = id;
  els.noteQuote.textContent = hlText(hl);
  els.noteText.value = hl.note || "";
  els.noteDialog.hidden = false;
  els.noteText.focus();
}
function closeNote() { els.noteDialog.hidden = true; editingId = null; }
function saveNote() {
  if (!editingId) return;
  const note = els.noteText.value.trim();
  const hl = findHl(editingId);
  annotations.update(current.book.id, editingId, { note });
  if (hl) refreshSpan(hl.sp, hl.ep);
  closeNote();
  if (!els.notesPanel.hidden) renderNotes();
}
function deleteHighlight() {
  if (!editingId) return;
  const hl = findHl(editingId);
  annotations.remove(current.book.id, editingId);
  if (hl) refreshSpan(hl.sp, hl.ep);
  closeNote();
  if (!els.notesPanel.hidden) renderNotes();
}

/* ---------- Notes panel ---------- */
export function renderNotes() {
  const list = annotations.get(current.book.id).map(normHl)
    .sort((a, b) => a.sp - b.sp || a.so - b.so);
  if (!list.length) {
    els.notesList.innerHTML = `<p class="notes-empty">No highlights yet.<br>Select any text while reading to highlight it or attach a note.</p>`;
    return;
  }
  els.notesList.innerHTML = list.map((h) => {
    const quote = escapeHtml(hlText(h));
    const note = h.note ? `<span class="note-item__note">${escapeHtml(h.note)}</span>` : "";
    return `<button class="note-item" data-jump="${h.sp}" data-id="${h.id}" style="--c:var(--hl-${h.color})">
        <span class="note-item__quote">“${quote}”</span>${note}</button>`;
  }).join("");
  els.notesList.querySelectorAll(".note-item").forEach((b) =>
    b.addEventListener("click", () => { closePanels(); flashJump(Number(b.dataset.jump), b.dataset.id); }));
}

/* ---------- Table of contents ---------- */
export function renderTOC() {
  if (!current.chapters.length) {
    els.tocList.innerHTML = `<p class="notes-empty">No chapters detected in this text.<br>Use the progress bar to navigate.</p>`;
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
  els.bar.classList.remove("hidden");
  els.selToolbar.hidden = true;
}
