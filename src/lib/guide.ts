/** Now/next for live channels, from Xtream's `get_short_epg`; titles usually arrive base64-encoded. */

export interface Programme {
  title: string;
  description?: string;
  start: number; // epoch ms
  end: number;
}

export interface NowNext {
  now?: Programme;
  next?: Programme;
}

export const progress = (p: Programme, now: number) => Math.min(1, Math.max(0, (now - p.start) / (p.end - p.start)));

export function programmes(root: unknown): Programme[] {
  const listings = typeof root === "object" && root !== null ? (root as Record<string, unknown>).epg_listings : undefined;
  if (!Array.isArray(listings)) return [];
  const num = (v: unknown) => (typeof v === "number" || typeof v === "string") && String(v).trim() !== "" ? Number(v) : NaN;
  const out: Programme[] = [];
  for (const o of listings) {
    if (typeof o !== "object" || o === null) continue;
    const r = o as Record<string, unknown>;
    const start = num(r.start_timestamp);
    let end = num(r.stop_timestamp);
    if (!Number.isFinite(end)) end = num(r.end_timestamp);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const title = typeof r.title === "string" ? maybeBase64(r.title).trim() : "";
    if (!title) continue;
    const description = typeof r.description === "string" ? maybeBase64(r.description).trim() || undefined : undefined;
    out.push({ title, description, start: start * 1000, end: end * 1000 });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function nowNext(list: Programme[], now: number): NowNext {
  const i = list.findIndex((p) => now >= p.start && now < p.end);
  return i >= 0 ? { now: list[i], next: list[i + 1] } : { next: list.find((p) => p.start > now) };
}

/** Decodes base64 if the text is valid base64 of readable UTF-8; otherwise returns it as it is. */
export function maybeBase64(text: string): string {
  const t = text.trim();
  if (!t || t.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return text;
  try {
    const bytes = Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
    const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // eslint-disable-next-line no-control-regex
    return s && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�]/.test(s) ? s : text;
  } catch {
    return text;
  }
}
