import type { Channel } from "./model";

// ---- Progress ----

/**
 * The last minute counts as the credits: the episode is treated as watched, and the "next
 * episode" prompt shows. Streaming credits typically run 60–90 s, broadcast 20–40 s.
 */
export const END_MARGIN_MS = 60_000;
const MIN_RESUME_MS = 15_000;

/** [position, duration, saved at] in ms; older records have no time. */
export type Progress = [number, number, number?];

/**
 * How close to the end counts as watched: the last minute, or the last 5% when that's longer
 * (long episodes often run two or three minutes of credits). The same rule as on Fire TV.
 */
export const endMargin = (dur: number) => Math.max(END_MARGIN_MS, dur / 20);

export const fraction = ([pos, dur]: Progress) => Math.min(1, Math.max(0, pos / dur));
export const finished = ([pos, dur]: Progress) => dur - pos < endMargin(dur);

/**
 * Xtream stream URLs embed the username and password (`/series/user/pass/123.mkv`), so the key
 * keeps only the kind and file name: `series/123.mkv`.
 */
export function progressKey(url: string): string {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    return segs.length >= 4 ? `${segs[segs.length - 4]}/${segs[segs.length - 1]}` : url;
  } catch {
    return url;
  }
}

/** Where to start: the saved position, unless barely started or already finished. */
export function resumePosition(p: Progress | undefined): number {
  if (!p || p[0] < MIN_RESUME_MS || finished(p)) return 0;
  return p[0];
}

// ---- History ("pick up where you left off") ----

export const FILM = "Film";

/** A recently watched thing with its whole playlist (a live group or a season), newest first. */
export interface LastWatched {
  /** "Live TV", "Film", or the series name. */
  heading: string;
  live: boolean;
  index: number;
  items: Channel[];
  /** Series only, to open its page. */
  seriesId?: string;
  /** Poster or cover for the Continue watching row. */
  art?: string;
  at: number;
}

export const current = (h: LastWatched) => h.items[Math.min(Math.max(h.index, 0), h.items.length - 1)];
export const isFilm = (h: LastWatched) => !h.live && h.heading === FILM;

/** One history slot per series, per film, and one for live TV. */
export function slot(h: LastWatched): string {
  if (h.live) return "live";
  if (isFilm(h)) return `film:${current(h).id}`;
  return `series:${h.seriesId ?? h.heading}`;
}

export function remember(history: LastWatched[], entry: LastWatched, max = 30): LastWatched[] {
  return [entry, ...history.filter((h) => slot(h) !== slot(entry))].slice(0, max);
}

/**
 * Where "pick up" should go: the next episode if this one was left in its last minute (the credits;
 * and there is a next one), otherwise this item.
 */
export function continueIndex(h: LastWatched, progressOf: (url: string) => Progress | undefined): number {
  const i = Math.min(Math.max(h.index, 0), h.items.length - 1);
  if (h.live || i + 1 >= h.items.length) return i;
  const p = progressOf(h.items[i].url);
  return p && finished(p) ? i + 1 : i;
}

// ---- Aspect ratio ----

export type Aspect =
  | { kind: "original" } | { kind: "zoom" } | { kind: "stretch" } | { kind: "16:9" } | { kind: "4:3" }
  | { kind: "custom"; w: number; h: number };

export const ASPECTS: { aspect: Aspect; label: string }[] = [
  { aspect: { kind: "original" }, label: "Original" },
  { aspect: { kind: "zoom" }, label: "Zoom to fill" },
  { aspect: { kind: "stretch" }, label: "Stretch to window" },
  { aspect: { kind: "16:9" }, label: "Force 16:9" },
  { aspect: { kind: "4:3" }, label: "Force 4:3" },
  { aspect: { kind: "custom", w: 1, h: 1 }, label: "Custom…" },
];

export function encodeAspect(a: Aspect): string {
  return a.kind === "custom" ? `custom:${a.w}:${a.h}` : a.kind;
}

export function decodeAspect(text: string | undefined): Aspect {
  if (text === "zoom" || text === "stretch" || text === "16:9" || text === "4:3") return { kind: text };
  if (text?.startsWith("custom:")) {
    const [, w, h] = text.split(":");
    return { kind: "custom", w: Number(w) || 1, h: Number(h) || 1 };
  }
  return { kind: "original" };
}

/**
 * Scale factors that turn the video's natural fitted picture ([frameW] × [frameH] inside the
 * window's [screenW] × [screenH]) into the chosen aspect.
 */
export function aspectScale(a: Aspect, frameW: number, frameH: number, screenW: number, screenH: number): [number, number] {
  if (frameW <= 0 || frameH <= 0 || screenW <= 0 || screenH <= 0) return [1, 1];
  const forced = (ratio: number): [number, number] => {
    const [w, h] = screenW / screenH > ratio ? [screenH * ratio, screenH] : [screenW, screenW / ratio];
    return [w / frameW, h / frameH];
  };
  switch (a.kind) {
    case "original": return [1, 1];
    case "zoom": { const s = Math.max(screenW / frameW, screenH / frameH); return [s, s]; }
    case "stretch": return [screenW / frameW, screenH / frameH];
    case "16:9": return forced(16 / 9);
    case "4:3": return forced(4 / 3);
    case "custom": return [a.w, a.h];
  }
}

/** The picture's size when fitted (object-fit: contain) into the window. */
export function fitted(videoW: number, videoH: number, screenW: number, screenH: number): [number, number] {
  if (videoW <= 0 || videoH <= 0) return [0, 0];
  const s = Math.min(screenW / videoW, screenH / videoH);
  return [videoW * s, videoH * s];
}

// ---- Which engine plays a stream ----

export type Engine = "hls" | "mpegts" | "native";

export function engineFor(url: string, live: boolean): Engine {
  let path = url.toLowerCase();
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch { /* use the whole string */ }
  if (path.endsWith(".m3u8") || path.endsWith(".m3u")) return "hls";
  if (path.endsWith(".ts") || path.endsWith(".mpegts")) return "mpegts";
  // Live streams with no extension are almost always MPEG-TS (Xtream's default).
  if (live && !/\.[a-z0-9]{2,4}$/.test(path)) return "mpegts";
  return "native";
}

// ---- Time ----

export function clock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
