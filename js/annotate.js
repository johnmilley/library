/* Highlight engine.
   Paragraphs render as <p data-i="N">. A highlight is stored as
   { id, para, start, end, color, note } where start/end are character
   offsets into that paragraph's plain text. Selections are constrained to a
   single paragraph, which keeps offsets stable and rendering simple. */

export function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

/* Absolute character offset of (node, offset) within `root`'s text content. */
function offsetWithin(root, node, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0, n;
  while ((n = walker.nextNode())) {
    if (n === node) return total + offset;
    total += n.textContent.length;
  }
  // If node itself is an element (e.g. selection ended at element boundary).
  return total;
}

/* Read the current selection. Returns a span {sp, so, ep, eo, rect} across one
   or more paragraphs (sp/ep = start/end paragraph index, so/eo = offsets), or
   null when empty/collapsed/outside the body text. */
export function readSelection(container) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const pa = closestPara(range.startContainer, container);
  const pb = closestPara(range.endContainer, container);
  if (!pa || !pb) return null;

  let sp = Number(pa.dataset.i), so = offsetWithin(pa, range.startContainer, range.startOffset);
  let ep = Number(pb.dataset.i), eo = offsetWithin(pb, range.endContainer, range.endOffset);
  if (sp > ep || (sp === ep && eo < so)) { [sp, ep] = [ep, sp]; [so, eo] = [eo, so]; }
  if (sp === ep && eo <= so) return null;
  return { sp, so, ep, eo, rect: range.getBoundingClientRect() };
}

function closestPara(node, container) {
  let el = node.nodeType === 3 ? node.parentElement : node;
  while (el && el !== container) {
    if (el.dataset && el.dataset.i != null && Number(el.dataset.i) >= 0) return el;
    el = el.parentElement;
  }
  return null;
}

/* Render one paragraph's text with its highlights baked in as <mark>s.
   Overlapping highlights are resolved per-character (last one wins), so the
   output is always a clean, non-nested sequence of runs. */
export function renderParagraph(text, hls) {
  if (!hls || hls.length === 0) return escapeHtml(text);
  const owner = new Array(text.length).fill(null);
  for (const h of hls) {
    const a = Math.max(0, h.start), b = Math.min(text.length, h.end);
    for (let i = a; i < b; i++) owner[i] = h;
  }
  let html = "", i = 0;
  while (i < text.length) {
    const o = owner[i];
    let j = i + 1;
    while (j < text.length && owner[j] === o) j++;
    const seg = escapeHtml(text.slice(i, j));
    if (o) {
      const noteCls = o.note ? " has-note" : "";
      html += `<mark class="hl${noteCls}" data-id="${o.id}" style="--hl:var(--hl-${o.color})">${seg}</mark>`;
    } else {
      html += seg;
    }
    i = j;
  }
  return html;
}
