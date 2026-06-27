// Minimal XSPF (https://xspf.org) read/write — enough to interoperate with
// Strawberry's exported .xspf playlists. We only care about each track's
// file location, title, creator (artist) and duration.

export interface XspfItem {
  /** Absolute filesystem path (decoded from the file:// location). */
  path: string;
  title: string;
  artist: string;
  /** Seconds, or null if unknown. */
  duration: number | null;
}

function fileUriToPath(loc: string): string {
  let p = loc.trim();
  if (p.startsWith("file://")) p = p.slice("file://".length);
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

export function parseXspf(xml: string): XspfItem[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const items: XspfItem[] = [];
  for (const tr of Array.from(doc.getElementsByTagName("track"))) {
    const loc = tr.getElementsByTagName("location")[0]?.textContent?.trim();
    if (!loc) continue;
    const durMs = parseInt(
      tr.getElementsByTagName("duration")[0]?.textContent?.trim() || "",
      10,
    );
    items.push({
      path: fileUriToPath(loc),
      title: tr.getElementsByTagName("title")[0]?.textContent?.trim() || "",
      artist: tr.getElementsByTagName("creator")[0]?.textContent?.trim() || "",
      duration: isFinite(durMs) && durMs > 0 ? durMs / 1000 : null,
    });
  }
  return items;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildXspf(items: XspfItem[]): string {
  const tracks = items
    .map((it) => {
      // Bare percent-encoded absolute path, matching Strawberry's style
      // (it omits the file:// scheme). encodeURI keeps the slashes.
      const lines = [
        `      <location>${esc(encodeURI(it.path))}</location>`,
      ];
      if (it.title) lines.push(`      <title>${esc(it.title)}</title>`);
      if (it.artist) lines.push(`      <creator>${esc(it.artist)}</creator>`);
      if (it.duration != null)
        lines.push(`      <duration>${Math.round(it.duration * 1000)}</duration>`);
      return `    <track>\n${lines.join("\n")}\n    </track>`;
    })
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<playlist version="1" xmlns="http://xspf.org/ns/0/">\n` +
    `  <trackList>\n${tracks}\n  </trackList>\n</playlist>\n`
  );
}
