import * as backend from "./backend";
import type { Channel, Group, Provider, Series } from "./model";
import * as P from "./playback";
import * as repo from "./repo";
import { isNewer, latestRelease, WEEK_MS, type Release } from "./updates";

export type Route =
  | { name: "home" | "search" | "live" | "series" | "films" | "mylist" | "settings" }
  | { name: "setup"; editing?: boolean }
  | { name: "grid"; kind: "films" | "series"; group: string }
  | { name: "seriesDetail"; series: Series }
  | { name: "filmDetail"; film: Channel };

/** What the player is asked to play: a playlist (a live group or a season) and where to start. */
export interface PlayRequest {
  heading: string;
  live: boolean;
  items: Channel[];
  index: number;
  seriesId?: string;
  art?: string;
  /** Aspect is remembered per channel, film or series. */
  aspectKey: string;
  /** Start here (ms) instead of the saved position. */
  startAt?: number;
}

export interface Settings {
  autoNext: boolean;
  offerVlc: boolean;
}

interface Meta {
  updatedAt?: number;
  updateCheckedAt?: number;
}

export type FavKind = "live" | "film" | "series";
export const favKey = (kind: FavKind, id: string) => `${kind}:${id}`;

const normalise = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

class App {
  ready = $state(false);
  provider = $state<Provider | null>(null);
  // Catalogues can hold tens of thousands of items: raw state, replaced wholesale, never proxied.
  live = $state.raw<Group<Channel>[] | null>(null);
  films = $state.raw<Group<Channel>[] | null>(null);
  series = $state.raw<Group<Series>[] | null>(null);
  refreshing = $state(false);
  loadError = $state<string | null>(null);
  meta = $state<Meta>({});

  favourites = $state<string[]>([]);
  progress = $state<Record<string, P.Progress>>({});
  history = $state<P.LastWatched[]>([]);
  aspects = $state<Record<string, string>>({});
  settings = $state<Settings>({ autoNext: true, offerVlc: true });

  route = $state<Route>({ name: "home" });
  private back: Route[] = [];
  player = $state<PlayRequest | null>(null);

  update = $state<{ checking: boolean; latest?: Release; error?: string; current: string }>({ checking: false, current: "" });

  private liveById = new Map<string, Channel>();
  private filmById = new Map<string, Channel>();
  private seriesById = new Map<string, Series>();

  // ---- Start-up ----

  async start() {
    await backend.initBackend();
    const [fav, prog, hist, asp, set, meta, savedProvider, version] = await Promise.all([
      backend.storeRead<string[]>("favourites"),
      backend.storeRead<Record<string, P.Progress>>("progress"),
      backend.storeRead<P.LastWatched[]>("history"),
      backend.storeRead<Record<string, string>>("aspects"),
      backend.storeRead<Settings>("settings"),
      backend.storeRead<Meta>("meta"),
      backend.secretGet("provider").catch(() => null),
      backend.appVersion(),
    ]);
    this.favourites = fav ?? [];
    this.progress = prog ?? {};
    this.history = hist ?? [];
    this.aspects = asp ?? {};
    this.settings = { ...this.settings, ...set };
    this.meta = meta ?? {};
    this.update.current = version;

    const provider = parseProvider(savedProvider);
    if (!provider) {
      this.route = { name: "setup" };
      this.ready = true;
      return;
    }
    await this.useProvider(provider);
    this.ready = true;
    if (Date.now() - (this.meta.updateCheckedAt ?? 0) > WEEK_MS) void this.checkForUpdate(false);
  }

  /** Shows the saved lists straight away, then refreshes them in the background. */
  private async useProvider(p: Provider) {
    this.provider = p;
    backend.setAllowCleartext(p.allowCleartext);
    const [live, films, series] = await Promise.all([
      repo.liveGroups(p, "cache").catch(() => undefined),
      repo.filmGroups(p, "cache").catch(() => undefined),
      repo.seriesGroups(p, "cache").catch(() => undefined),
    ]);
    this.setCatalogues(live ?? null, films ?? null, series ?? null);
    void this.refresh();
  }

  private setCatalogues(live: Group<Channel>[] | null, films: Group<Channel>[] | null, series: Group<Series>[] | null) {
    if (live) {
      this.live = live;
      this.liveById = new Map(live.flatMap((g) => g.items.map((c) => [c.id, c] as const)));
    }
    if (films) {
      this.films = films;
      this.filmById = new Map(films.flatMap((g) => g.items.map((c) => [c.id, c] as const)));
    }
    if (series) {
      this.series = series;
      this.seriesById = new Map(series.flatMap((g) => g.items.map((s) => [s.id, s] as const)));
    }
    this.searchIndex = undefined;
  }

  async refresh() {
    const p = this.provider;
    if (!p || this.refreshing) return;
    this.refreshing = true;
    this.loadError = null;
    const results = await Promise.allSettled([repo.liveGroups(p, "network"), repo.filmGroups(p, "network"), repo.seriesGroups(p, "network")]);
    if (this.provider !== p) return; // the provider changed meanwhile
    const [live, films, series] = results.map((r) => (r.status === "fulfilled" ? r.value ?? null : null));
    this.setCatalogues(live as Group<Channel>[] | null, films as Group<Channel>[] | null, series as Group<Series>[] | null);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) {
      // Only an error worth a screen when there's nothing saved to show instead.
      if (!this.live) this.loadError = (failed.reason as Error).message || "Couldn't load your lists.";
      else console.warn("Refresh failed", failed.reason);
    } else {
      this.meta.updatedAt = Date.now();
      backend.storeWrite("meta", this.meta);
    }
    this.refreshing = false;
  }

  // ---- Provider ----

  async saveProvider(p: Provider) {
    backend.setAllowCleartext(p.allowCleartext);
    await repo.verify(p); // throws with a readable message
    await backend.secretSet("provider", JSON.stringify(p));
    this.live = this.films = this.series = null;
    this.back = [];
    this.route = { name: "home" };
    await this.useProvider(p);
  }

  async signOut() {
    await backend.secretDelete("provider");
    // History holds stream URLs, which carry the login.
    this.history = [];
    await backend.storeDelete("history");
    await repo.clearSavedCatalogues();
    this.provider = null;
    this.live = this.films = this.series = null;
    this.back = [];
    this.route = { name: "setup" };
  }

  async setAllowCleartext(allow: boolean) {
    if (!this.provider) return;
    const p = { ...this.provider, allowCleartext: allow };
    await backend.secretSet("provider", JSON.stringify(p));
    this.provider = p;
    backend.setAllowCleartext(allow);
  }

  async clearSavedData() {
    await repo.clearSavedCatalogues();
    this.meta.updatedAt = undefined;
    backend.storeWrite("meta", this.meta);
    await this.refresh();
  }

  // ---- Navigation ----

  go(route: Route) {
    if (JSON.stringify(route) === JSON.stringify(this.route)) return;
    // Top-level sections start a fresh trail, like tabs.
    const top = ["home", "search", "live", "series", "films", "mylist", "settings"].includes(route.name);
    this.back = top ? [] : [...this.back, this.route];
    this.route = route;
  }

  goBack(): boolean {
    const prev = this.back.pop();
    if (!prev) return false;
    this.route = prev;
    return true;
  }

  get canGoBack() {
    return this.back.length > 0;
  }

  // ---- Lookups ----

  liveChannel = (id: string) => this.liveById.get(id);
  film = (id: string) => this.filmById.get(id);
  seriesItem = (id: string) => this.seriesById.get(id);

  private searchIndex?: { live: [string, Channel][]; films: [string, Channel][]; series: [string, Series][] };

  search(query: string, limit = 40) {
    const q = normalise(query.trim());
    if (!q) return { live: [], films: [], series: [] };
    this.searchIndex ??= {
      live: (this.live ?? []).flatMap((g) => g.items).map((c) => [normalise(c.name), c]),
      films: (this.films ?? []).flatMap((g) => g.items).map((c) => [normalise(c.name), c]),
      series: (this.series ?? []).flatMap((g) => g.items).map((s) => [normalise(s.name), s]),
    };
    const find = <T>(list: [string, T][]) => {
      // Names that start with the query first, then any that contain it.
      const starts: T[] = [], contains: T[] = [];
      for (const [name, item] of list) {
        if (name.startsWith(q) || name.includes(` ${q}`)) starts.push(item);
        else if (name.includes(q)) contains.push(item);
        if (starts.length >= limit) break;
      }
      return [...starts, ...contains].slice(0, limit);
    };
    return { live: find(this.searchIndex.live), films: find(this.searchIndex.films), series: find(this.searchIndex.series) };
  }

  /** Newest first, across every category. */
  recentlyAdded<T extends { added?: number }>(groups: Group<T>[] | null, n = 24): T[] {
    const all = (groups ?? []).flatMap((g) => g.items);
    if (!all.some((i) => i.added)) return [];
    return all.filter((i) => i.added).sort((a, b) => (b.added ?? 0) - (a.added ?? 0)).slice(0, n);
  }

  // ---- My List ----

  isFavourite(kind: FavKind, id: string) {
    return this.favourites.includes(favKey(kind, id));
  }

  toggleFavourite(kind: FavKind, id: string) {
    const key = favKey(kind, id);
    this.favourites = this.favourites.includes(key) ? this.favourites.filter((k) => k !== key) : [key, ...this.favourites];
    backend.storeWrite("favourites", this.favourites, 0);
  }

  favouriteItems() {
    const live: Channel[] = [], films: Channel[] = [], series: Series[] = [];
    for (const key of this.favourites) {
      const [kind, ...rest] = key.split(":");
      const id = rest.join(":");
      if (kind === "live") { const c = this.liveById.get(id); if (c) live.push(c); }
      else if (kind === "film") { const c = this.filmById.get(id); if (c) films.push(c); }
      else if (kind === "series") { const s = this.seriesById.get(id); if (s) series.push(s); }
    }
    return { live, films, series };
  }

  // ---- Progress and history ----

  progressOf = (url: string): P.Progress | undefined => this.progress[P.progressKey(url)];

  saveProgress(url: string, pos: number, dur: number) {
    if (!(dur > 0) || !Number.isFinite(dur)) return;
    this.progress[P.progressKey(url)] = [Math.round(Math.min(Math.max(pos, 0), dur)), Math.round(dur)];
    backend.storeWrite("progress", this.progress, 2000);
  }

  /** The newest history entry for a series, to resume it from its page. */
  seriesHistory(seriesId: string) {
    return this.history.find((h) => h.seriesId === seriesId);
  }

  play(req: PlayRequest) {
    this.player = req;
    this.recordWatching(req, req.index);
  }

  /** Called when playback starts and on every episode change, so "pick up" always lands right. */
  recordWatching(req: PlayRequest, index: number) {
    this.history = P.remember(this.history, {
      heading: req.heading, live: req.live, index, items: req.items, seriesId: req.seriesId, art: req.art, at: Date.now(),
    });
    backend.storeWrite("history", this.history, 500);
  }

  /** Plays a history entry: the next episode if the last one reached its credits. */
  resume(h: P.LastWatched) {
    const index = P.continueIndex(h, this.progressOf);
    const aspectKey = h.live ? `live:${P.current(h).id}` : P.isFilm(h) ? `film:${P.current(h).id}` : `series:${h.seriesId ?? h.heading}`;
    this.play({ heading: h.heading, live: h.live, items: h.items, index, seriesId: h.seriesId, art: h.art, aspectKey });
  }

  removeFromHistory(h: P.LastWatched) {
    this.history = this.history.filter((x) => P.slot(x) !== P.slot(h));
    backend.storeWrite("history", this.history, 0);
  }

  // ---- Aspect ----

  aspectFor(key: string): P.Aspect {
    return P.decodeAspect(this.aspects[key]);
  }

  saveAspect(key: string, a: P.Aspect) {
    if (a.kind === "original") delete this.aspects[key];
    else this.aspects[key] = P.encodeAspect(a);
    backend.storeWrite("aspects", this.aspects);
  }

  saveSettings() {
    backend.storeWrite("settings", this.settings, 0);
  }

  // ---- Updates ----

  async checkForUpdate(manual: boolean) {
    this.update.checking = true;
    this.update.error = undefined;
    try {
      const r = await latestRelease();
      this.update.latest = r && isNewer(r.version, this.update.current) ? r : undefined;
      this.meta.updateCheckedAt = Date.now();
      backend.storeWrite("meta", this.meta);
    } catch (e) {
      if (manual) this.update.error = "Couldn't reach GitHub. Try again later.";
      console.warn("Update check failed", e);
    } finally {
      this.update.checking = false;
    }
  }
}

function parseProvider(text: string | null): Provider | null {
  if (!text) return null;
  try {
    const p = JSON.parse(text) as Provider;
    if (p.kind === "xtream" && p.server && p.username) return p;
    if (p.kind === "m3u" && p.url) return p;
  } catch { /* fall through */ }
  return null;
}

export const app = new App();

/** "2 hours ago" style, for "Updated …". */
export function ago(ms: number | undefined, now = Date.now()): string {
  if (!ms) return "never";
  const m = Math.round((now - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
