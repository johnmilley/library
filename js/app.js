/* App bootstrap: hash routing, theme/display settings, and view wiring. */
import { settings, progress } from "./store.js";
import { loadCatalog, getBook, renderLibrary, renderImports } from "./library.js";
import { initReader, openBook, closeBook, renderNotes, renderTOC, setMode, applyReadingPrefs, toggleBookmark } from "./reader.js";
import { isImportId, getImport, addImport, deleteImport } from "./imports.js";
import { exportData, importData } from "./backup.js";
import { epubToText } from "./epub.js";

const $ = (id) => document.getElementById(id);
const THEMES = ["light", "sepia", "dark"];
const FONT_MIN = 0.95, FONT_MAX = 1.7, LH_MIN = 1.3, LH_MAX = 2.1;

const views = { library: $("library"), reader: $("reader") };

/* ---------- Display settings ---------- */
function applySettings() {
  const s = settings.get();
  document.documentElement.dataset.theme = s.theme;
  document.body.dataset.font = s.font;
  document.documentElement.style.setProperty("--font-size", `${s.fontSize}rem`);
  document.documentElement.style.setProperty("--line-height", s.lineHeight);
  $("theme-color")?.setAttribute("content", s.theme === "dark" ? "#14151a" : "#faf8f4");
  // reflect active state in the popover segments
  document.querySelectorAll("#theme-seg button").forEach((b) =>
    b.classList.toggle("active", b.dataset.themeSet === s.theme));
  document.querySelectorAll("#font-seg button").forEach((b) =>
    b.classList.toggle("active", b.dataset.font === s.font));
  document.querySelectorAll("#mode-seg button").forEach((b) =>
    b.classList.toggle("active", b.dataset.modeSet === s.mode));
  document.querySelectorAll("#align-seg button").forEach((b) =>
    b.classList.toggle("active", b.dataset.alignSet === s.align));
}

function bindSettings() {
  // Library quick theme cycle
  $("theme-btn").addEventListener("click", () => {
    const s = settings.get();
    const next = THEMES[(THEMES.indexOf(s.theme) + 1) % THEMES.length];
    settings.set({ theme: next });
    applySettings();
  });

  // Display popover
  const panel = $("type-panel");
  $("type-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== $("type-btn")) panel.hidden = true;
  });

  panel.addEventListener("click", (e) => {
    const act = e.target.dataset.act;
    const font = e.target.dataset.font;
    const theme = e.target.dataset.themeSet;
    const modeSet = e.target.dataset.modeSet;
    const alignSet = e.target.dataset.alignSet;
    const s = settings.get();
    if (act === "font-dec") settings.set({ fontSize: clamp(s.fontSize - 0.06, FONT_MIN, FONT_MAX) });
    if (act === "font-inc") settings.set({ fontSize: clamp(s.fontSize + 0.06, FONT_MIN, FONT_MAX) });
    if (act === "lh-dec") settings.set({ lineHeight: clamp(s.lineHeight - 0.1, LH_MIN, LH_MAX) });
    if (act === "lh-inc") settings.set({ lineHeight: clamp(s.lineHeight + 0.1, LH_MIN, LH_MAX) });
    if (font) settings.set({ font });
    if (theme) settings.set({ theme });
    if (alignSet) settings.set({ align: alignSet });
    if (modeSet) { settings.set({ mode: modeSet }); setMode(modeSet); }
    if (act || font || theme || modeSet || alignSet) applySettings();
    // font size / spacing / alignment changes need a paged relayout
    if (act || font || alignSet) applyReadingPrefs();
  });
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v * 100) / 100));

/* ---------- Routing ---------- */
function show(view) {
  views.library.hidden = view !== "library";
  views.reader.hidden = view !== "reader";
}

async function route() {
  const hash = location.hash.slice(1); // e.g. "/read/crime-and-punishment"
  const m = hash.match(/^\/read\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (isImportId(id)) {
      const rec = await getImport(id);
      if (rec) {
        show("reader");
        $("type-panel").hidden = true;
        await openBook({ id: rec.id, title: rec.title, author: rec.author, text: rec.text });
        return;
      }
    } else {
      const book = getBook(id);
      if (book && book.downloaded) {
        show("reader");
        $("type-panel").hidden = true;
        await openBook(book);
        return;
      }
    }
  }
  closeBook();
  show("library");
  renderLibrary($("sections"), $("search").value);
  renderImports($("search").value);
}

/* ---------- Side panels (notes + contents) ---------- */
function bindPanels() {
  const notes = $("notes-panel"), toc = $("toc-panel"), scrim = $("scrim");
  const close = () => { notes.hidden = true; toc.hidden = true; scrim.hidden = true; };
  $("notes-btn").addEventListener("click", () => {
    renderNotes(); toc.hidden = true; notes.hidden = false; scrim.hidden = false;
  });
  $("toc-btn").addEventListener("click", () => {
    renderTOC(); notes.hidden = true; toc.hidden = false; scrim.hidden = false;
  });
  $("notes-close").addEventListener("click", close);
  $("toc-close").addEventListener("click", close);
  scrim.addEventListener("click", close);
}

/* ---------- Add / import book ---------- */
function bindImportDialog() {
  const dlg = $("import-dialog");
  const fileInput = $("import-file"), fileLabel = $("import-file-label");
  const titleEl = $("import-title"), authorEl = $("import-author");
  const textEl = $("import-text"), urlEl = $("import-url"), errEl = $("import-error");
  let picked = null;  // { text, title?, author? }

  const setError = (t) => { errEl.textContent = t; errEl.hidden = !t; };
  const reset = () => {
    titleEl.value = ""; authorEl.value = ""; textEl.value = ""; urlEl.value = "";
    picked = null; fileInput.value = ""; fileLabel.textContent = "Choose an EPUB or .txt file…";
    setError("");
  };
  const open = () => { reset(); dlg.hidden = false; titleEl.focus(); };
  const close = () => { dlg.hidden = true; };

  $("add-btn").addEventListener("click", open);
  $("import-cancel").addEventListener("click", close);
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });

  const prefill = (meta) => {
    if (meta.title && !titleEl.value) titleEl.value = meta.title;
    if (meta.author && !authorEl.value) authorEl.value = meta.author;
  };

  // Turn a File (epub/txt/mobi) into { text, title, author }.
  async function readBook(file) {
    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".mobi") || name.endsWith(".azw") || name.endsWith(".azw3"))
      throw new Error("MOBI/AZW isn’t supported — convert it to EPUB first.");
    if (name.endsWith(".epub") || file.type === "application/epub+zip") {
      return epubToText(file);
    }
    return { text: await file.text(), title: file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ") };
  }

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files[0];
    if (!f) return;
    fileLabel.textContent = f.name; setError("");
    try {
      picked = await readBook(f);
      prefill(picked);
    } catch (e) { picked = null; setError(e.message || "Couldn’t read that file."); }
  });

  $("import-save").addEventListener("click", async () => {
    setError("");
    const url = urlEl.value.trim();
    try {
      if (url && !picked && !textEl.value.trim()) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Server returned ${res.status}.`);
        const fname = url.split("/").pop() || "book";
        picked = await readBook(new File([await res.blob()], fname,
          { type: res.headers.get("content-type") || "" }));
        prefill(picked);
      }
    } catch (e) {
      setError("Couldn’t fetch that link (the site may block cross-origin requests). Download the file and choose it instead.");
      return;
    }
    const text = (textEl.value.trim() || picked?.text || "").trim();
    if (!text) { setError("Add a book — choose a file, paste a link, or paste text."); return; }
    const rec = await addImport({ title: titleEl.value, author: authorEl.value, text });
    close();
    location.hash = `/read/${encodeURIComponent(rec.id)}`;
  });
}

/* ---------- Backup / restore ---------- */
function bindBackup() {
  const msg = $("backup-msg"), fileInput = $("backup-file");
  const flash = (t) => { msg.textContent = t; setTimeout(() => (msg.textContent = ""), 5000); };
  $("export-btn").addEventListener("click", async () => {
    const { notes, imports } = await exportData();
    flash(`Exported ${notes} highlight${notes === 1 ? "" : "s"}${imports ? ` + ${imports} imported book${imports === 1 ? "" : "s"}` : ""}.`);
  });
  $("import-btn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files[0];
    if (!f) return;
    try {
      const { added } = await importData(f);
      flash(`Restored. ${added ? `${added} book(s) added. ` : ""}Reloading…`);
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      flash(e.message || "Import failed.");
    }
    fileInput.value = "";
  });
}

/* ---------- Boot ---------- */
async function main() {
  applySettings();
  bindSettings();
  bindPanels();

  initReader({
    reader: $("reader"), scroll: $("reader-scroll"), book: $("book"), bar: $("reader-bar"),
    title: $("reader-title"), author: $("reader-author"), status: $("reading-status"),
    selToolbar: $("sel-toolbar"), selNote: $("sel-note"),
    progressFill: $("progress-fill"),
    noteDialog: $("note-dialog"), noteQuote: $("note-quote"), noteText: $("note-text"),
    noteSave: $("note-save"), noteCancel: $("note-cancel"), noteDelete: $("note-delete"),
    notesPanel: $("notes-panel"), notesList: $("notes-list"),
    tocPanel: $("toc-panel"), tocList: $("toc-list"), scrim: $("scrim"),
    bookmarkBtn: $("bookmark-btn"),
  });
  $("bookmark-btn").addEventListener("click", toggleBookmark);

  $("back-btn").addEventListener("click", () => { location.hash = "/"; });
  $("search").addEventListener("input", () => {
    renderLibrary($("sections"), $("search").value);
    renderImports($("search").value);
  });
  bindImportDialog();
  bindBackup();

  // Card clicks (event-delegated for all shelves)
  document.addEventListener("click", async (e) => {
    const del = e.target.closest(".card__del");
    if (del) {
      e.stopPropagation(); e.preventDefault();
      if (del.dataset.del) { await deleteImport(del.dataset.del); renderImports($("search").value); }
      else if (del.dataset.clear) { progress.clear(del.dataset.clear); }
      renderLibrary($("sections"), $("search").value);
      return;
    }
    const card = e.target.closest(".card[data-id]");
    if (card && !card.disabled) location.hash = `/read/${encodeURIComponent(card.dataset.id)}`;
  });

  await loadCatalog();
  window.addEventListener("hashchange", route);
  await route();
}

main();
