/* Portable backup: export everything the reader owns — display settings,
   per-book progress, highlights & notes, and any imported books — to a single
   JSON file, and restore it (merging, never clobbering existing highlights).
   This is the "long-term storage" hatch: keep the file anywhere (Drive,
   Dropbox, email) and re-import on any device. */
import { dumpLocal, loadLocal } from "./store.js";
import { exportImports, importImports } from "./imports.js";

const FORMAT = "readpublica-backup";
const LEGACY_FORMAT = "reading-room-backup";
const VERSION = 1;

export async function exportData() {
  const payload = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    local: dumpLocal(),
    imports: await exportImports(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `readpublica-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  const local = payload.local;
  const notes = Object.entries(local)
    .filter(([k]) => k.startsWith("anno:"))
    .reduce((n, [, v]) => n + (v?.length || 0), 0);
  return { notes, imports: payload.imports.length };
}

export async function importData(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("That file isn’t valid JSON."); }
  if (data.format !== FORMAT && data.format !== LEGACY_FORMAT)
    throw new Error("That doesn’t look like a Readpublica backup.");
  loadLocal(data.local || {});
  const added = await importImports(data.imports || []);
  return { added };
}
