/* App bootstrap: hash routing, theme/display settings, and view wiring. */
import { settings } from "./store.js";
import { loadCatalog, getBook, renderLibrary } from "./library.js";
import { initReader, openBook, closeBook, renderNotes } from "./reader.js";

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
    const book = getBook(decodeURIComponent(m[1]));
    if (book && book.downloaded) {
      show("reader");
      $("type-panel").hidden = true;
      await openBook(book);
      return;
    }
  }
  closeBook();
  show("library");
  renderLibrary($("sections"), $("search").value);
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
  $("search").addEventListener("input", () => renderLibrary($("sections"), $("search").value));

  // Card clicks (event-delegated for both shelves)
  document.addEventListener("click", (e) => {
    const card = e.target.closest(".card[data-id]");
    if (card && !card.disabled) location.hash = `/read/${encodeURIComponent(card.dataset.id)}`;
  });

  await loadCatalog();
  window.addEventListener("hashchange", route);
  await route();
}

main();
