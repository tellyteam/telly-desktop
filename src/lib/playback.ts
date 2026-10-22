import type { Channel, Season, Series } from "./model";

// ---- Progress ----

// ---- telly-sync's PLAYBACK.md as functions; the tests run its playback-cases.json ----

/** The next-episode prompt shows for the last minute, whatever the length. */
export const PROMPT_MS = 60_000;
/** Earlier than this, an item starts from the beginning. */
const MIN_RESUME_MS = 15_000;

/** Seconds the next-episode prompt shows, or null when it doesn't. */
export function promptSeconds(durationMs: number, positionMs: number, hasNext: boolean, autoNext: boolean, dismissed: boolean, live: boolean): number | null {
  if (live || !hasNext || !autoNext || dismissed || !(durationMs > 0)) return null;
  const left = Math.round(durationMs - positionMs);
  return left >= 1 && left <= PROMPT_MS ? Math.ceil(left / 1000) : null;
}

/** Whether the next item starts when this one plays to its end. */
export const advanceAtEnd = (hasNext: boolean, autoNext: boolean, dismissed: boolean) => hasNext && autoNext && !dismissed;

/** Within its credits: the last minute or the last 5%, whichever is longer. */
export const watched = (positionMs: number, durationMs: number) => durationMs - positionMs < Math.max(PROMPT_MS, durationMs / 20);

/** Where an item starts: its saved position, unless barely started or watched. */
export function startAt(positionMs: number | null | undefined, durationMs: number | null | undefined): number {
  if (positionMs == null || durationMs == null || positionMs < MIN_RESUME_MS || watched(positionMs, durationMs)) return 0;
  return positionMs;
}

/** "Pick up" goes to the next item when this one was left watched (and there is one). */
export const continueAt = (index: number, count: number, isWatched: (i: number) => boolean) =>
  index + 1 < count && isWatched(index) ? index + 1 : index;

/** A Continue watching entry stays while something in it is left: not a watched film, nor a watched last episode. */
export const shownInContinue = (index: number, count: number, isWatched: (i: number) => boolean) => !isWatched(continueAt(index, count, isWatched));

/** What plays after [index]: the next item, or offline the next downloaded one; null when nothing can. */
export function nextPlayable(index: number, count: number, downloaded: (i: number) => boolean, online: boolean): number | null {
  for (let i = index + 1; i < count; i++) if (online || downloaded(i)) return i;
  return null;
}

/** [position, duration, saved at] in ms; older records have no time. */
export type Progress = [number, number, number?];

export const fraction = ([pos, dur]: Progress) => Math.min(1, Math.max(0, pos / dur));
export const finished = ([pos, dur]: Progress) => watched(pos, dur);

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
export const resumePosition = (p: Progress | undefined) => startAt(p?.[0], p?.[1]);

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
  /** The provider added episodes after the last one watched; cleared once something is played. */
  newEpisodes?: boolean;
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
  if (h.live) return i;
  return continueAt(i, h.items.length, (j) => { const p = progressOf(h.items[j].url); return !!p && finished(p); });
}

/** Whether it stays in Continue watching: something in it is left to watch (PLAYBACK.md). */
export function inContinue(h: LastWatched, progressOf: (url: string) => Progress | undefined): boolean {
  if (h.live) return true;
  const i = Math.min(Math.max(h.index, 0), h.items.length - 1);
  return shownInContinue(i, h.items.length, (j) => { const p = progressOf(h.items[j].url); return !!p && finished(p); });
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

// ---- New episodes (PLAYBACK.md, Continue watching; the same rules as on Fire TV and iPad) ----

/** When a finished series was last looked at: the provider's stamp then, and when (ms). */
export interface EpisodeCheck { added: number; at: number }

/** Where watching continues after [watchedId]: that season's episodes and the index, or null if it's the latest. */
export function episodeAfter(seasons: Season[], watchedId: string): { episodes: Channel[]; index: number } | null {
  for (let s = 0; s < seasons.length; s++) {
    const i = seasons[s].episodes.findIndex((e) => e.id === watchedId);
    if (i < 0) continue;
    if (i + 1 < seasons[s].episodes.length) return { episodes: seasons[s].episodes, index: i + 1 };
    const next = seasons.slice(s + 1).find((x) => x.episodes.length);
    return next ? { episodes: next.episodes, index: 0 } : null;
  }
  return null;
}

/** Whether a series needs fetching again: after the provider changes it, or daily if it doesn't say. */
export function episodesDue(series: Series, checked: EpisodeCheck | undefined, now: number): boolean {
  if (!checked) return true;
  return series.added ? series.added !== checked.added : now - checked.at >= 86_400_000;
}

/** Whether what comes next arrived after it was watched (older history has no time, so never). */
export const episodesNew = (series: Series, watchedAt: number) => watchedAt > 0 && !!series.added && series.added * 1000 > watchedAt;
