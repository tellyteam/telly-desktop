import * as cache from "./cache";
import { getJson, getText } from "./backend";
import * as guide from "./guide";
import { parseM3u } from "./m3u";
import { groupInOrder, type Channel, type Details, type Group, type Provider, type Series, type SeriesData } from "./model";
import * as X from "./xtream";

/**
 * Loads catalogues from the user's provider. This is the only place provider data is fetched.
 * `cache` reads what was saved last time (undefined if nothing yet); `network` downloads afresh
 * and replaces the saved copy, but only once the new copy parses.
 */
export type Source = "cache" | "network";

class XtreamSession {
  readonly server: URL;
  private scopeP: Promise<string>;
  constructor(readonly p: Extract<Provider, { kind: "xtream" }>, readonly source: Source) {
    this.server = X.serverUrl(p.server);
    this.scopeP = cache.scope("xtream", this.server.toString(), p.username);
  }

  api(action?: string, extra?: Record<string, string>) {
    return X.apiUrl(this.server, this.p.username, this.p.password, action, extra);
  }

  /** Stream format for live channels; logging in when online (which also checks the account). */
  async format(): Promise<string | undefined> {
    const scope = await this.scopeP;
    if (this.source === "cache") return (await cache.read(scope, "format"))?.text;
    const acc = X.account(await getJson(this.api()));
    if (!acc.authenticated) throw new Error(`Login was rejected${acc.status ? ` (status: ${acc.status})` : ""}.`);
    const format = X.preferredFormat(acc.outputFormats);
    await cache.write(scope, "format", format);
    return format;
  }

  async list<T>(action: string, parse: (json: unknown) => T, extra?: Record<string, string>, cacheName = action): Promise<T | undefined> {
    const scope = await this.scopeP;
    if (this.source === "cache") {
      const saved = await cache.read(scope, cacheName);
      if (!saved) return undefined;
      try {
        return parse(JSON.parse(saved.text));
      } catch {
        return undefined;
      }
    }
    const text = await getText(this.api(action, extra));
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("The provider did not return valid JSON. Check the server address.");
    }
    const parsed = parse(json);
    await cache.write(scope, cacheName, text);
    return parsed;
  }

  categories(action: string) {
    return this.list(action, X.categories);
  }
}

export async function liveGroups(p: Provider, source: Source): Promise<Group<Channel>[] | undefined> {
  let groups: Group<Channel>[];
  if (p.kind === "xtream") {
    const x = new XtreamSession(p, source);
    const format = await x.format();
    const cats = format && (await x.categories("get_live_categories"));
    if (!format || !cats) return undefined;
    const channels = await x.list("get_live_streams", (j) => X.liveChannels(x.server, p.username, p.password, format, cats, j));
    if (!channels) return undefined;
    groups = groupInOrder(channels, [...cats.values()], (c) => c.group);
  } else {
    const url = p.url.trim();
    const scope = await cache.scope("m3u", url);
    let text: string | undefined;
    if (source === "cache") text = (await cache.read(scope, "playlist"))?.text;
    else text = await getText(url);
    if (text === undefined) return undefined;
    const channels = parseM3u(text);
    if (source === "network" && channels.length) await cache.write(scope, "playlist", text);
    // First-seen order matches the playlist's own ordering.
    groups = groupInOrder(channels, [], (c) => c.group);
  }
  if (!groups.length && source === "network") throw new Error("The provider returned no channels.");
  return groups;
}

export async function filmGroups(p: Provider, source: Source): Promise<Group<Channel>[] | undefined> {
  if (p.kind !== "xtream") return [];
  const x = new XtreamSession(p, source);
  const cats = await x.categories("get_vod_categories");
  if (!cats) return undefined;
  const films = await x.list("get_vod_streams", (j) => X.films(x.server, p.username, p.password, cats, j));
  return films && groupInOrder(films, [...cats.values()], (f) => f.group);
}

export async function seriesGroups(p: Provider, source: Source): Promise<Group<Series>[] | undefined> {
  if (p.kind !== "xtream") return [];
  const x = new XtreamSession(p, source);
  const cats = await x.categories("get_series_categories");
  if (!cats) return undefined;
  const series = await x.list("get_series", (j) => X.series(cats, j));
  return series && groupInOrder(series, [...cats.values()], (s) => s.group);
}

export async function seriesData(p: Provider, series: Series, source: Source): Promise<SeriesData | undefined> {
  if (p.kind !== "xtream") return undefined;
  const x = new XtreamSession(p, source);
  return x.list("get_series_info", (j) => ({ details: X.details(j), seasons: X.seasons(x.server, p.username, p.password, j) }),
    { series_id: series.id }, `series_info_${series.id}`);
}

export async function filmDetails(p: Provider, film: Channel, source: Source): Promise<Details | undefined> {
  if (p.kind !== "xtream") return undefined;
  const x = new XtreamSession(p, source);
  return x.list("get_vod_info", X.details, { vod_id: film.id }, `vod_info_${film.id}`);
}

/** Checks a login before it's saved: Xtream logs in, M3U downloads the playlist. */
export async function verify(p: Provider): Promise<void> {
  await liveGroups(p, "network");
}

// ---- Programme guide: fetched per channel on demand, kept in memory until the programme ends ----

const guideCache = new Map<string, { list: guide.Programme[]; validUntil: number }>();
const inFlight = new Map<string, Promise<guide.Programme[]>>();
let running = 0;
const queue: (() => void)[] = [];

async function gate<T>(fn: () => Promise<T>): Promise<T> {
  // At most four guide requests at once; providers rate-limit.
  if (running >= 4) await new Promise<void>((r) => queue.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

export function cachedGuide(channel: Channel, now = Date.now()): guide.Programme[] | undefined {
  const e = guideCache.get(channel.id);
  return e && now < e.validUntil ? e.list : undefined;
}

export async function programmes(p: Provider, channel: Channel): Promise<guide.Programme[]> {
  const cached = cachedGuide(channel);
  if (cached) return cached;
  if (p.kind !== "xtream") return []; // M3U guides need XMLTV; not supported yet
  let pending = inFlight.get(channel.id);
  if (!pending) {
    pending = gate(async () => {
      const server = X.serverUrl(p.server);
      const json = await getJson(X.apiUrl(server, p.username, p.password, "get_short_epg", { stream_id: channel.id, limit: "8" }));
      const list = guide.programmes(json);
      const now = Date.now();
      const nn = guide.nowNext(list, now);
      const until = nn.now?.end ?? nn.next?.start ?? now + 20 * 60_000;
      guideCache.set(channel.id, { list, validUntil: Math.min(until, now + 2 * 60 * 60_000) });
      return list;
    }).catch(() => [] as guide.Programme[]).finally(() => inFlight.delete(channel.id));
    inFlight.set(channel.id, pending);
  }
  return pending;
}

export const clearSavedCatalogues = () => cache.clearAll();
