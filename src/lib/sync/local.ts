/**
 * Between this app's own records and a sync parcel. The parcel gets ids and times only; what comes
 * back is turned into playable history using this device's own lists and login.
 */
import * as P from "../playback";
import { isSyncableId, isSyncableKey, keptAfterClear, slotOf, trim, type HistoryEntry, type Parcel } from "./parcel";

/** What sync remembers beside the app's own records: when My List changed, and removals. */
export interface Ledger {
  list: Record<string, [number, boolean]>;
  /** History slot → when it was taken out of Continue watching. */
  removed: Record<string, number>;
  /** When watch progress was last cleared, on any device (0 if never). */
  cleared: number;
}

export const emptyLedger = (): Ledger => ({ list: {}, removed: {}, cleared: 0 });

export interface Local {
  progress: Record<string, P.Progress>;
  history: P.LastWatched[];
  favourites: string[];
  ledger: Ledger;
}

/** The sync form of a history entry; null for ones that can't be shared (no ids, or M3U URLs). */
export function entryOf(h: P.LastWatched): HistoryEntry | null {
  const id = P.current(h).id;
  if (!isSyncableId(id)) return null;
  if (h.live) return { kind: "live", id, at: h.at };
  if (P.isFilm(h)) return { kind: "film", id, at: h.at };
  return isSyncableId(h.seriesId) ? { kind: "series", id, series: h.seriesId, at: h.at } : null;
}

function removalOf(slot: string, at: number): HistoryEntry | null {
  if (slot === "live") return { kind: "live", id: "0", at, removed: true };
  const [kind, id] = [slot.slice(0, slot.indexOf(":")), slot.slice(slot.indexOf(":") + 1)];
  if (!isSyncableId(id)) return null;
  if (kind === "film") return { kind: "film", id, at, removed: true };
  if (kind === "series") return { kind: "series", id, series: id, at, removed: true };
  return null;
}

export function toParcel(local: Local, now: number): Parcel {
  const progress: Parcel["progress"] = {};
  for (const [k, [pos, dur, at]] of Object.entries(local.progress)) if (isSyncableKey(k) && dur > 0) progress[k] = [pos, dur, at ?? 0];

  const history = new Map<string, HistoryEntry>();
  for (const h of local.history) {
    const e = entryOf(h);
    if (e && !history.has(slotOf(e))) history.set(slotOf(e), e);
  }
  for (const [slot, at] of Object.entries(local.ledger.removed)) {
    const e = removalOf(slot, at);
    if (e && (history.get(slot)?.at ?? -1) < at) history.set(slot, e);
  }

  const list: Parcel["list"] = {};
  for (const [k, v] of Object.entries(local.ledger.list)) if (isSyncableKey(k) && !v[1]) list[k] = v;
  for (const k of local.favourites) if (isSyncableKey(k)) list[k] = [local.ledger.list[k]?.[0] ?? 0, true];

  return trim({ v: 1, at: now, progress, history: [...history.values()], list, cleared: local.ledger.cleared }, now);
}

/** Turns a shared history entry into a playable one here; null if this device can't (yet). */
export type Resolver = (e: HistoryEntry) => Promise<P.LastWatched | null>;

/** This device's records after taking in [merged]. Only newer things replace local ones. */
export async function apply(local: Local, merged: Parcel, resolve: Resolver, maxHistory = 30): Promise<Local> {
  const cleared = Math.max(local.ledger.cleared, merged.cleared);
  const progress = Object.fromEntries(Object.entries(local.progress).filter(([, v]) => keptAfterClear(v[2] ?? 0, cleared)));
  for (const [k, v] of Object.entries(merged.progress)) {
    if (!progress[k] || v[2] > (progress[k][2] ?? 0)) progress[k] = v;
  }

  const ledger: Ledger = { list: { ...local.ledger.list }, removed: { ...local.ledger.removed }, cleared };
  const on = new Set(local.favourites);
  for (const [k, [at, isOn]] of Object.entries(merged.list)) {
    const mine = ledger.list[k]?.[0] ?? (on.has(k) ? 0 : -1);
    if (at <= mine) continue;
    ledger.list[k] = [at, isOn];
    if (isOn) on.add(k);
    else on.delete(k);
  }
  // Newest additions first; ones never timed keep their place at the end.
  const when = (k: string) => ledger.list[k]?.[0] ?? 0;
  const favourites = [...on].map((k, i) => [k, i] as const)
    .sort((a, b) => when(b[0]) - when(a[0]) || local.favourites.indexOf(a[0]) - local.favourites.indexOf(b[0]) || a[1] - b[1])
    .map(([k]) => k);

  const bySlot = new Map(local.history.filter((h) => keptAfterClear(h.at, cleared)).map((h) => [P.slot(h), h]));
  for (const e of merged.history) {
    const slot = slotOf(e);
    const mine = bySlot.get(slot);
    if (e.removed) {
      if (mine && mine.at < e.at) bySlot.delete(slot);
      if ((ledger.removed[slot] ?? -1) < e.at && (!mine || mine.at < e.at)) ledger.removed[slot] = e.at;
      continue;
    }
    if (mine && mine.at >= e.at) continue;
    if ((ledger.removed[slot] ?? -1) >= e.at) continue;
    const resolved = await resolve(e).catch(() => null);
    if (resolved) bySlot.set(slot, { ...resolved, at: e.at });
  }
  const history = [...bySlot.values()].sort((a, b) => b.at - a.at).slice(0, maxHistory);

  return { progress, history, favourites, ledger };
}
