/** Where the lists come from. The login never leaves the computer except to this provider. */
export type Provider =
  | { kind: "xtream"; name: string; server: string; username: string; password: string; allowCleartext: boolean }
  | { kind: "m3u"; name: string; url: string; allowCleartext: boolean };

/** Anything the player can play: a live channel, a film or a series episode. */
export interface Channel {
  id: string;
  name: string;
  group: string;
  /** Channel logo, film poster or episode still. */
  logo?: string;
  url: string;
  /** XMLTV channel id, for the programme guide (live channels only). */
  epgId?: string;
  /** When the provider added it (epoch seconds; 0 if unknown), for "Recently added". */
  added?: number;
  /** Episodes only: the episode's own synopsis and length, when the provider has them. */
  plot?: string;
  runtime?: string;
}

export interface Series {
  id: string;
  name: string;
  group: string;
  cover?: string;
  plot?: string;
  added?: number;
}

export interface Group<T> {
  name: string;
  items: T[];
}

export interface Season {
  name: string;
  episodes: Channel[];
}

/** Extra information for a detail page; every field is optional because panels vary. */
export interface Details {
  plot?: string;
  genre?: string;
  year?: string;
  /** Already formatted, e.g. "7.4". */
  rating?: string;
  /** Already formatted, e.g. "1h 52m" or "45 min". */
  runtime?: string;
  cast?: string;
  backdrop?: string;
}

export interface SeriesData {
  details: Details;
  seasons: Season[];
}

export const UNCATEGORISED = "Uncategorised";

/**
 * Groups [items] in the provider's category order (which providers curate), then any categories
 * it didn't list, keeping each group's items in their original order.
 */
export function groupInOrder<T>(items: T[], categoryOrder: string[], groupOf: (t: T) => string): Group<T>[] {
  const byGroup = new Map<string, T[]>();
  for (const item of items) {
    const g = groupOf(item);
    let list = byGroup.get(g);
    if (!list) byGroup.set(g, (list = []));
    list.push(item);
  }
  const ordered = [...new Set([...categoryOrder.filter((c) => byGroup.has(c)), ...byGroup.keys()])];
  return ordered.map((name) => ({ name, items: byGroup.get(name)! }));
}

/** Thrown with a message that's safe to show: it never contains a URL (Xtream URLs carry the login). */
export class ProviderError extends Error {}
