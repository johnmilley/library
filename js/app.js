/* App bootstrap: hash routing, theme/display settings, and view wiring. */
import { settings } from "./store.js";
import { loadCatalog, getBook, renderLibrary, renderImports } from "./library.js";
import { initReader, openBook, closeBook, renderNotes } from "./reader.js";
import { isImportId, getImport, addImport, deleteImport } from "./imports.js";

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
    const s = settings.get();
    if (act === "font-dec") settings.set({ fontSize: clamp(s.fontSize - 0.06, FONT_MIN, FONT_MAX) });
    if (act === "font-inc") settings.set({ fontSize: clamp(s.fontSize + 0.06, FONT_MIN, FONT_MAX) });
    if (act === "lh-dec") settings.set({ lineHeight: clamp(s.lineHeight - 0.1, LH_MIN, LH_MAX) });
    if (act === "lh-inc") settings.set({ lineHeight: clamp(s.lineHeight + 0.1, LH_MIN, LH_MAX) });
    if (font) settings.set({ font });
    if (theme) settings.set({ theme });
    if (act || font || theme) applySettings();
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

/* ---------- Notes panel ---------- */
function bindNotesPanel() {
  const panel = $("notes-panel"), scrim = $("scrim");
  const close = () => { panel.hidden = true; scrim.hidden = true; };
  $("notes-btn").addEventListener("click", () => {
    renderNotes();
    panel.hidden = false;
    scrim.hidden = false;
  });
  $("notes-close").addEventListener("click", close);
  scrim.addEventListener("click", close);
}

/* ---------- Add / import book ---------- */
function bindImportDialog() {
  const dlg = $("import-dialog");
  const fileInput = $("import-file"), fileLabel = $("import-file-label");
  const titleEl = $("import-title"), authorEl = $("import-author");
  const textEl = $("import-text"), errEl = $("import-error");
  let pickedText = null;

  const reset = () => {
    titleEl.value = ""; authorEl.value = ""; textEl.value = "";
    pickedText = null; fileInput.value = ""; fileLabel.textContent = "Choose a .txt file…";
    errEl.hidden = true;
  };
  const open = () => { reset(); dlg.hidden = false; titleEl.focus(); };
  const close = () => { dlg.hidden = true; };

  $("add-btn").addEventListener("click", open);
  $("import-cancel").addEventListener("click", close);
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });

  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    if (!f) return;
    fileLabel.textContent = f.name;
    if (!titleEl.value) titleEl.value = f.name.replace(/\.txt$/i, "").replace(/[_-]+/g, " ");
    const reader = new FileReader();
    reader.onload = () => { pickedText = String(reader.result); };
    reader.readAsText(f);
  });

  $("import-save").addEventListener("click", async () => {
    const text = (textEl.value.trim() || pickedText || "").trim();
    if (!text) { errEl.textContent = "Add some text — choose a file or paste it in."; errEl.hidden = false; return; }
    const rec = await addImport({ title: titleEl.value, author: authorEl.value, text });
    close();
    location.hash = `/read/${encodeURIComponent(rec.id)}`;
  });
}

/* ---------- Boot ---------- */
async function main() {
  applySettings();
  bindSettings();
  bindNotesPanel();

  initReader({
    scroll: $("reader-scroll"), book: $("book"), bar: $("reader-bar"),
    title: $("reader-title"), author: $("reader-author"),
    selToolbar: $("sel-toolbar"), selNote: $("sel-note"),
    progressFill: $("progress-fill"),
    noteDialog: $("note-dialog"), noteQuote: $("note-quote"), noteText: $("note-text"),
    noteSave: $("note-save"), noteCancel: $("note-cancel"), noteDelete: $("note-delete"),
    notesPanel: $("notes-panel"), notesList: $("notes-list"), scrim: $("scrim"),
  });

  $("back-btn").addEventListener("click", () => { location.hash = "/"; });
  $("search").addEventListener("input", () => {
    renderLibrary($("sections"), $("search").value);
    renderImports($("search").value);
  });
  bindImportDialog();

  // Card clicks (event-delegated for all shelves)
  document.addEventListener("click", async (e) => {
    const del = e.target.closest(".card__del");
    if (del) {
      e.stopPropagation();
      await deleteImport(del.dataset.del);
      renderImports($("search").value);
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
