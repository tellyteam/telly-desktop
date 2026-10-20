/**
 * What a device shares (telly-sync PROTOCOL.md): ids, positions and times only, and how parcels
 * from several devices combine. Newest wins, key by key; removals are just newer entries.
 */

export type HistoryKind = "live" | "film" | "series";

export interface HistoryEntry {
  kind: HistoryKind;
  /** The channel, film or episode id. */
  id: string;
  /** Series only. */
  series?: string;
  at: number;
  removed?: boolean;
}

export interface Parcel {
  v: 1;
  at: number;
  /** key → [position ms, duration ms, saved at]. */
  progress: Record<string, [number, number, number]>;
  history: HistoryEntry[];
  /** My List key → [changed at, on the list]. */
  list: Record<string, [number, boolean]>;
  /** When watch progress was last cleared (0 if never): older progress and history are dropped everywhere. */
  cleared: number;
}

export const MAX_PROGRESS = 2000;
export const MAX_HISTORY = 40;
export const MAX_LIST = 2000;
/** Removals are shared for this long, then forgotten. */
export const TOMBSTONE_MS = 90 * 86_400_000;

/** Plain keys only (`series/123.mkv`, `film:456`): anything URL-like might carry a login. */
const KEY = /^[a-z]{1,8}[/:][A-Za-z0-9._-]{1,40}$/;
const ID = /^[A-Za-z0-9._-]{1,40}$/;

export const isSyncableKey = (k: string) => KEY.test(k);
export const isSyncableId = (id: string | undefined): id is string => id !== undefined && ID.test(id);

/** Whether something saved at [at] survives a clear at [cleared] (0: never cleared). */
export const keptAfterClear = (at: number, cleared: number) => !cleared || at > cleared;

export const slotOf = (h: Pick<HistoryEntry, "kind" | "id" | "series">) =>
  h.kind === "live" ? "live" : h.kind === "film" ? `film:${h.id}` : `series:${h.series}`;

const isTime = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Whatever another device sent, reduced to well-formed entries; null if it isn't a parcel at all. */
export function parse(json: string): Parcel | null {
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || raw.v !== 1) return null;
  const progress: Parcel["progress"] = {};
  for (const [k, v] of Object.entries(raw.progress ?? {})) {
    if (isSyncableKey(k) && Array.isArray(v) && v.length === 3 && v.every(isTime) && v[1] > 0) progress[k] = [v[0], v[1], v[2]];
  }
  const history: HistoryEntry[] = [];
  for (const h of Array.isArray(raw.history) ? raw.history : []) {
    if (!h || !["live", "film", "series"].includes(h.kind) || !isSyncableId(h.id) || !isTime(h.at)) continue;
    if (h.kind === "series" && !isSyncableId(h.series)) continue;
    history.push({ kind: h.kind, id: h.id, ...(h.kind === "series" ? { series: h.series } : {}), at: h.at, ...(h.removed === true ? { removed: true } : {}) });
  }
  const list: Parcel["list"] = {};
  for (const [k, v] of Object.entries(raw.list ?? {})) {
    if (isSyncableKey(k) && Array.isArray(v) && v.length === 2 && isTime(v[0]) && typeof v[1] === "boolean") list[k] = [v[0], v[1]];
  }
  return { v: 1, at: isTime(raw.at) ? raw.at : 0, progress, history, list, cleared: isTime(raw.cleared) ? raw.cleared : 0 };
}

const newestFirst = <T>(entries: [string, T][], at: (t: T) => number, max: number) =>
  Object.fromEntries(entries.sort((a, b) => at(b[1]) - at(a[1])).slice(0, max));

/**
 * Keeps a parcel within its limits, drops removals older than [TOMBSTONE_MS], and drops progress
 * and history from before it was last cleared.
 */
export function trim(p: Parcel, now: number): Parcel {
  const fresh = (at: number, removal: boolean) => !removal || now - at < TOMBSTONE_MS;
  const history = p.history
    .filter((h) => fresh(h.at, !!h.removed) && keptAfterClear(h.at, p.cleared))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_HISTORY);
  return {
    v: 1,
    at: p.at,
    progress: newestFirst(Object.entries(p.progress).filter(([, v]) => keptAfterClear(v[2], p.cleared)), (v) => v[2], MAX_PROGRESS),
    history,
    list: newestFirst(Object.entries(p.list).filter(([, v]) => fresh(v[0], !v[1])), (v) => v[0], MAX_LIST),
    cleared: p.cleared,
  };
}

/**
 * [own] combined with other devices' parcels: per key and per history slot the newest wins, and
 * [own] wins a tie.
 */
export function merge(own: Parcel, others: Parcel[], now: number): Parcel {
  const progress = { ...own.progress };
  const list = { ...own.list };
  const history = new Map(own.history.map((h) => [slotOf(h), h]));
  let cleared = own.cleared;
  for (const p of others) {
    cleared = Math.max(cleared, p.cleared);
    for (const [k, v] of Object.entries(p.progress)) if (!progress[k] || v[2] > progress[k][2]) progress[k] = v;
    for (const [k, v] of Object.entries(p.list)) if (!list[k] || v[0] > list[k][0]) list[k] = v;
    for (const h of p.history) {
      const mine = history.get(slotOf(h));
      if (!mine || h.at > mine.at) history.set(slotOf(h), h);
    }
  }
  return trim({ v: 1, at: now, progress, history: [...history.values()], list, cleared }, now);
}
