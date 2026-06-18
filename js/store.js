/* Local persistence: everything lives in localStorage, namespaced under "rr:".
   No accounts, no server — a reader's notes belong to the reader. */

const PREFIX = "rr:";
const k = (s) => PREFIX + s;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(k(key));
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(k(key), JSON.stringify(value)); } catch {}
}

/* ---- Global display settings ---- */
const DEFAULT_SETTINGS = {
  theme: "light",
  font: "serif",
  fontSize: 1.18,   // rem
  lineHeight: 1.65,
  align: "left",    // "left" (ragged, easiest to read) | "justify"
  mode: "scroll",   // "scroll" | "paged"
  sort: "timeline", // "timeline" (by era) | "title" (A–Z by author)
};
export const settings = {
  get: () => ({ ...DEFAULT_SETTINGS, ...read("settings", {}) }),
  set: (patch) => write("settings", { ...settings.get(), ...patch }),
};

/* ---- Collapsed library sections ---- */
export const collapsed = {
  map: () => read("collapsed", {}),
  get: (id) => !!read("collapsed", {})[id],
  toggle: (id) => {
    const c = read("collapsed", {});
    c[id] = !c[id];
    write("collapsed", c);
    return c[id];
  },
};

/* ---- Per-book reading progress ---- */
export const progress = {
  get: (bookId) => read(`progress:${bookId}`, null),
  set: (bookId, data) => write(`progress:${bookId}`, data),
  clear: (bookId) => { try { localStorage.removeItem(k(`progress:${bookId}`)); } catch {} },
  all: () => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(k("progress:"))) {
        const id = key.slice(k("progress:").length);
        try { out[id] = JSON.parse(localStorage.getItem(key)); } catch {}
      }
    }
    return out;
  },
};

/* ---- Per-book annotations (highlights, optionally with notes) ---- */
export const annotations = {
  get: (bookId) => read(`anno:${bookId}`, []),
  set: (bookId, list) => write(`anno:${bookId}`, list),
  add(bookId, hl) {
    const list = annotations.get(bookId);
    list.push(hl);
    annotations.set(bookId, list);
    return list;
  },
  update(bookId, id, patch) {
    const list = annotations.get(bookId).map((h) => (h.id === id ? { ...h, ...patch } : h));
    annotations.set(bookId, list);
    return list;
  },
  remove(bookId, id) {
    const list = annotations.get(bookId).filter((h) => h.id !== id);
    annotations.set(bookId, list);
    return list;
  },
};

export const uid = () =>
  (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/* ---- Backup: dump / load every rr:* key (settings, progress, annotations) ---- */
export function dumpLocal() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PREFIX)) {
      try { out[key.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(key)); } catch {}
    }
  }
  return out;
}

export function loadLocal(obj) {
  // Merge: annotations are unioned per book (by id); everything else overwrites.
  for (const [key, value] of Object.entries(obj || {})) {
    if (key.startsWith("anno:")) {
      const existing = read(key, []);
      const seen = new Set(existing.map((h) => h.id));
      write(key, existing.concat((value || []).filter((h) => !seen.has(h.id))));
    } else {
      write(key, value);
    }
  }
}
