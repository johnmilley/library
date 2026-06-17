/* User-imported books live in IndexedDB (localStorage is too small for whole
   novels). Each record holds metadata + the full plain text. Imported books
   surface in the library under "Your Imports" and read exactly like catalog
   books — highlights, notes, and progress all work the same way. */

const DB_NAME = "reading-room";
const STORE = "imports";
const ID_PREFIX = "import:";

let dbPromise = null;
function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = fn(store);
    t.oncomplete = () => resolve(out && "_result" in out ? out._result : out);
    t.onerror = () => reject(t.error);
  }));
}

export const isImportId = (id) => typeof id === "string" && id.startsWith(ID_PREFIX);

export async function addImport({ title, author, text }) {
  const id = ID_PREFIX + (crypto.randomUUID?.() ?? Date.now().toString(36));
  const record = {
    id, title: title?.trim() || "Untitled", author: author?.trim() || "Unknown",
    words: text.split(/\s+/).filter(Boolean).length, at: Date.now(), text,
  };
  await tx("readwrite", (s) => s.put(record));
  return record;
}

export async function getImport(id) {
  return tx("readonly", (s) => {
    const out = {};
    s.get(id).onsuccess = (e) => (out._result = e.target.result || null);
    return out;
  });
}

export async function listImports() {
  return tx("readonly", (s) => {
    const out = {};
    s.getAll().onsuccess = (e) => {
      // newest first, without the heavy `text` field
      out._result = (e.target.result || [])
        .sort((a, b) => b.at - a.at)
        .map(({ text, ...meta }) => meta);
    };
    return out;
  });
}

export async function deleteImport(id) {
  return tx("readwrite", (s) => s.delete(id));
}
