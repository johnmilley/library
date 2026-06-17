/* Minimal in-browser EPUB reader — no dependencies.
   An EPUB is a ZIP archive: META-INF/container.xml points to an OPF package
   file, whose <manifest>/<spine> list the XHTML documents in reading order.
   We unzip just what we need (raw-deflate via DecompressionStream), pull the
   text out of each spine document, and return clean plain text + metadata. */

const td = new TextDecoder();

/* ---- tiny ZIP reader (central directory + per-entry inflate) ---- */
async function readZip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  // locate End Of Central Directory record (scan back for 0x06054b50)
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i > u8.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid EPUB (no ZIP directory).");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // central directory offset

  const entries = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries[name] = { method, compSize, localOff };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { dv, u8, entries };
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function entryBytes(zip, name) {
  const e = zip.entries[name];
  if (!e) return null;
  const { dv, u8 } = zip;
  // local header: data begins after name + extra fields
  const nameLen = dv.getUint16(e.localOff + 26, true);
  const extraLen = dv.getUint16(e.localOff + 28, true);
  const start = e.localOff + 30 + nameLen + extraLen;
  const raw = u8.subarray(start, start + e.compSize);
  return e.method === 0 ? raw : inflateRaw(raw);
}
async function entryText(zip, name) {
  const b = await entryBytes(zip, name);
  return b ? td.decode(b) : null;
}

const xml = (s) => new DOMParser().parseFromString(s, "application/xml");
const dirOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");
function resolve(base, href) {
  href = href.split("#")[0];
  if (!base) return decodeURIComponent(href);
  const parts = (base + href).split("/");
  const out = [];
  for (const seg of parts) {
    if (seg === "..") out.pop();
    else if (seg !== "." && seg !== "") out.push(seg);
  }
  return decodeURIComponent(out.join("/"));
}

function bytesToBase64(bytes) {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

// Image blocks are encoded as a sentinel paragraph the reader recognises:
//   <data-url><alt>
export const IMG_MARK = "";
const ALT_MARK = "";

/* Extract text + image blocks from one XHTML doc, preserving reading order.
   `images` maps full zip paths -> data URLs; `docDir` resolves <img src>. */
function blocksFromXhtml(html, docDir, images) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style").forEach((n) => n.remove());
  const nodes = doc.querySelectorAll(
    "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,img,image");
  const out = [];
  if (!nodes.length) {
    const t = (doc.body || doc).textContent.replace(/\s+/g, " ").trim();
    return t ? [t] : [];
  }
  nodes.forEach((el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "img" || tag === "image") {
      const src = el.getAttribute("src") || el.getAttribute("xlink:href")
        || el.getAttributeNS?.("http://www.w3.org/1999/xlink", "href");
      const url = src && images[resolve(docDir, src)];
      if (url) out.push(IMG_MARK + url + ALT_MARK + (el.getAttribute("alt") || ""));
    } else {
      const t = el.textContent.replace(/\s+/g, " ").trim();
      if (t) out.push(t);
    }
  });
  return out;
}

export async function epubToText(file) {
  const zip = await readZip(await file.arrayBuffer());
  const container = await entryText(zip, "META-INF/container.xml");
  if (!container) throw new Error("Not a valid EPUB (no container.xml).");
  const opfPath = xml(container).querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath) throw new Error("EPUB is missing its package file.");

  const opf = xml(await entryText(zip, opfPath));
  const base = dirOf(opfPath);
  const title = opf.querySelector("metadata title")?.textContent?.trim()
    || file.name.replace(/\.epub$/i, "");
  const author = opf.querySelector("metadata creator")?.textContent?.trim() || "Unknown";

  const manifest = {};
  opf.querySelectorAll("manifest > item").forEach((it) => {
    manifest[it.getAttribute("id")] = {
      href: it.getAttribute("href"),
      type: it.getAttribute("media-type"),
    };
  });

  // Decode images once into data URLs, keyed by full zip path. Skip absurdly
  // large ones so a single photo can't blow up local storage.
  const images = {};
  for (const it of Object.values(manifest)) {
    if (!/^image\//.test(it.type || "")) continue;
    const path = resolve(base, it.href);
    const bytes = await entryBytes(zip, path);
    if (bytes && bytes.length <= 4_000_000)
      images[path] = `data:${it.type};base64,${bytesToBase64(bytes)}`;
  }

  const spine = [...opf.querySelectorAll("spine > itemref")].map((r) => r.getAttribute("idref"));
  const blocks = [];
  for (const idref of spine) {
    const item = manifest[idref];
    if (!item || !/x?html/.test(item.type || "")) continue;
    const path = resolve(base, item.href);
    const html = await entryText(zip, path);
    if (html) blocks.push(...blocksFromXhtml(html, dirOf(path), images));
  }
  const text = blocks.join("\n\n");
  if (!text.trim()) throw new Error("Couldn’t extract text from this EPUB.");
  return { title, author, text };
}
