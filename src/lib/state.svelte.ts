import * as backend from "./backend";
import { syncIdentity, type Channel, type Group, type Provider, type Series } from "./model";
import * as P from "./playback";
import * as repo from "./repo";
import { syncOnce, leave as leaveRelay, SyncError } from "./sync/client";
import type { SharedLogin } from "./sync/bundle";
import { deriveKeys, hex, newCode, newDeviceId, normaliseCode, providerTag, randomBytes, type Keys } from "./sync/crypto";
import { apply as applySync, emptyLedger, toParcel, type Ledger, type Local } from "./sync/local";
import { TOMBSTONE_MS, type HistoryEntry } from "./sync/parcel";

export type Route =
  | { name: "home" | "search" | "live" | "series" | "films" | "mylist" | "settings" }
  | { name: "setup"; editing?: string; adding?: boolean }
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
}

interface Meta {
  updatedAt?: number;
  /** Sync is hidden until unlocked (seven clicks on the version in Settings). */
  syncUnlocked?: boolean;
  /** The saved provider in use, by id. */
  activeProvider?: string;
  /** Share provider logins with linked devices that do too (opt-in). */
  shareLogins?: boolean;
}

/** A provider saved on this TV. [changedAt] is when it was added or last changed (ms). */
export interface SavedProvider {
  id: string;
  provider: Provider;
  changedAt: number;
}

/** One provider's records, kept under its id. */
const RECORDS = ["favourites", "progress", "history", "sync-ledger"] as const;
const recordName = (name: (typeof RECORDS)[number], id: string) => `${name}-${id}`;

/** Kept in the Keychain: the link code is the household's only secret. */
export interface SyncConfig {
  code: string;
  device: string;
  relay: string;
}

/** The relay telly uses unless you run your own (see telly-sync). */
export const DEFAULT_RELAY = "https://telly-sync.tellyteam.workers.dev";

/** Never more often than this when the window regains focus. */
const SYNC_GAP_MS = 60_000;

export type FavKind = "live" | "film" | "series";
export const favKey = (kind: FavKind, id: string) => `${kind}:${id}`;

const normalise = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

class App {
  ready = $state(false);
  provider = $state<Provider | null>(null);
  providers = $state<SavedProvider[]>([]);
  activeId = $state<string | null>(null);
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
  settings = $state<Settings>({ autoNext: true });
  sync = $state<SyncConfig | null>(null);
  syncStatus = $state<{ busy: boolean; at?: number; error?: string }>({ busy: false });
  private ledger: Ledger = emptyLedger();

  route = $state<Route>({ name: "home" });
  private back: Route[] = [];
  player = $state<PlayRequest | null>(null);

  version = $state("");

  private liveById = new Map<string, Channel>();
  private filmById = new Map<string, Channel>();
  private seriesById = new Map<string, Series>();

  // ---- Start-up ----

  async start() {
    await backend.initBackend();
    const [asp, set, meta, version, savedSync] = await Promise.all([
      backend.storeRead<Record<string, string>>("aspects"),
      backend.storeRead<Settings>("settings"),
      backend.storeRead<Meta>("meta"),
      backend.appVersion(),
      backend.secretGet("sync").catch(() => null),
    ]);
    this.aspects = asp ?? {};
    this.settings = { ...this.settings, ...set };
    this.meta = meta ?? {};
    this.version = version;
    this.sync = parseSync(savedSync);
    this.removedLogins = (await backend.storeRead<Record<string, number>>("login-ledger")) ?? {};
    window.addEventListener("focus", () => {
      if (!this.player && Date.now() - (this.syncStatus.at ?? 0) > SYNC_GAP_MS) void this.syncNow();
    });

    this.providers = await this.loadProviders();
    const active = this.providers.find((p) => p.id === this.meta.activeProvider) ?? this.providers[0];
    if (!active) {
      this.route = { name: "setup" };
      this.ready = true;
      return;
    }
    await this.activate(active);
    this.ready = true;
  }

  // ---- Saved providers ----

  /**
   * The saved providers. Before there could be several, the one provider and its records were kept
   * unscoped: they become the first saved provider's. One saved without a time gets now: it's still
   * here, so for shared logins it's newer than any older removal of it on another device.
   */
  private async loadProviders(): Promise<SavedProvider[]> {
    const text = await backend.secretGet("providers").catch(() => null);
    if (text) {
      let list = parseProviders(text);
      if (list.some((p) => !p.changedAt)) {
        list = list.map((p) => (p.changedAt ? p : { ...p, changedAt: Date.now() }));
        await this.saveProviders(list);
      }
      return list;
    }
    const old = parseProvider(await backend.secretGet("provider").catch(() => null));
    if (!old) return [];
    const saved: SavedProvider = { id: newProviderId(), provider: old, changedAt: Date.now() };
    for (const name of RECORDS) {
      const value = await backend.storeRead<unknown>(name);
      if (value !== null) backend.storeWrite(recordName(name, saved.id), value, 0);
      await backend.storeDelete(name);
    }
    await this.saveProviders([saved]);
    await backend.secretDelete("provider");
    this.meta.activeProvider = saved.id;
    backend.storeWrite("meta", this.meta, 0);
    return [saved];
  }

  private async saveProviders(list: SavedProvider[]) {
    this.providers = list;
    await backend.secretSet("providers", JSON.stringify(list));
    // Adding, changing or removing a provider is news for devices sharing logins.
    if (this.meta.shareLogins) this.syncSoon();
  }

  private async readRecords(id: string): Promise<Local> {
    const [favourites, progress, history, ledger] = await Promise.all([
      backend.storeRead<string[]>(recordName("favourites", id)),
      backend.storeRead<Record<string, P.Progress>>(recordName("progress", id)),
      backend.storeRead<P.LastWatched[]>(recordName("history", id)),
      backend.storeRead<Ledger>(recordName("sync-ledger", id)),
    ]);
    return { favourites: favourites ?? [], progress: progress ?? {}, history: history ?? [], ledger: { ...emptyLedger(), ...ledger } };
  }

  private writeRecords(id: string, r: Local) {
    backend.storeWrite(recordName("favourites", id), r.favourites, 0);
    backend.storeWrite(recordName("progress", id), r.progress, 0);
    backend.storeWrite(recordName("history", id), r.history, 0);
    backend.storeWrite(recordName("sync-ledger", id), r.ledger, 0);
  }

  /** Makes [saved] the provider in use: its records, then its lists (saved ones straight away). */
  private async activate(saved: SavedProvider) {
    backend.flushWrites();
    const r = await this.readRecords(saved.id);
    this.favourites = r.favourites;
    this.progress = r.progress;
    this.history = r.history;
    this.ledger = r.ledger;
    this.activeId = saved.id;
    this.meta.activeProvider = saved.id;
    backend.storeWrite("meta", this.meta, 0);
    this.live = this.films = this.series = null;
    this.setCatalogues(null, null, null);
    await this.useProvider(saved.provider);
  }

  /** Switches to another saved provider. Not while something plays. */
  async switchProvider(id: string) {
    const saved = this.providers.find((p) => p.id === id);
    if (!saved || id === this.activeId || this.player) return;
    this.back = [];
    this.route = { name: "home" };
    await this.activate(saved);
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
    void this.refresh().then(() => this.syncNow());
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

  /**
   * Checks [p] with the provider, then saves it: in place of [editing], or as a new provider that
   * comes into use. Throws with a readable message.
   */
  async saveProvider(p: Provider, editing?: string) {
    if (this.providers.some((s) => s.id !== editing && syncIdentity(s.provider) === syncIdentity(p))) {
      throw new Error("You've already added this provider.");
    }
    backend.setAllowCleartext(p.allowCleartext);
    try {
      await repo.verify(p); // throws with a readable message
    } catch (e) {
      if (this.provider) backend.setAllowCleartext(this.provider.allowCleartext);
      throw e;
    }
    const list = [...this.providers];
    const i = editing ? list.findIndex((s) => s.id === editing) : -1;
    let saved: SavedProvider;
    if (i >= 0) {
      // A new server or login means new lists: the old ones go.
      if (syncIdentity(list[i].provider) !== syncIdentity(p)) {
        void repo.clearSavedCataloguesFor(list[i].provider);
        this.forgetLogin(list[i].provider);
      }
      saved = list[i] = { ...list[i], provider: p, changedAt: Date.now() };
    } else {
      saved = { id: newProviderId(), provider: p, changedAt: Date.now() };
      list.push(saved);
    }
    await this.saveProviders(list);
    this.back = [];
    this.route = { name: "home" };
    if (saved.id === this.activeId) {
      this.live = this.films = this.series = null;
      this.setCatalogues(null, null, null);
      await this.useProvider(p);
    } else {
      await this.activate(saved);
    }
  }

  /** Removes a provider from this TV, with its lists and everything watched with it. */
  async removeProvider(id: string, at = Date.now()) {
    const gone = this.providers.find((p) => p.id === id);
    if (!gone || this.player) return;
    await this.saveProviders(this.providers.filter((p) => p.id !== id));
    this.forgetLogin(gone.provider, at);
    // Its history holds stream URLs, which carry the login.
    for (const name of RECORDS) await backend.storeDelete(recordName(name, id));
    void repo.clearSavedCataloguesFor(gone.provider);
    if (id !== this.activeId) return;
    this.back = [];
    const next = this.providers[0];
    if (next) {
      this.route = { name: "home" };
      await this.activate(next);
      return;
    }
    this.favourites = [];
    this.progress = {};
    this.history = [];
    this.ledger = emptyLedger();
    this.activeId = null;
    this.meta.activeProvider = undefined;
    backend.storeWrite("meta", this.meta, 0);
    this.provider = null;
    this.live = this.films = this.series = null;
    this.route = { name: "setup" };
  }

  async setAllowCleartext(allow: boolean) {
    const i = this.providers.findIndex((p) => p.id === this.activeId);
    if (!this.provider || i < 0) return;
    const p = { ...this.provider, allowCleartext: allow };
    const list = [...this.providers];
    list[i] = { ...list[i], provider: p, changedAt: Date.now() };
    await this.saveProviders(list);
    this.provider = p;
    backend.setAllowCleartext(allow);
  }

  // ---- Shared logins (opt-in) ----

  /** Removed providers, by sync identity, and when: shared as removals while logins are shared. */
  private removedLogins: Record<string, number> = {};

  private forgetLogin(p: Provider, at = Date.now()) {
    const now = Date.now();
    this.removedLogins = Object.fromEntries(
      Object.entries({ ...this.removedLogins, [syncIdentity(p)]: at }).filter(([, t]) => now - t < TOMBSTONE_MS),
    );
    backend.storeWrite("login-ledger", this.removedLogins, 0);
  }

  /** Turns sharing provider logins with linked devices on or off, and syncs. */
  setShareLogins(on: boolean) {
    this.meta.shareLogins = on;
    backend.storeWrite("meta", this.meta, 0);
    void this.syncNow();
  }

  /** This TV's logins (and removals) to share, by tag. */
  private ownLogins(keys: Keys): Record<string, SharedLogin> {
    const out: Record<string, SharedLogin> = {};
    for (const [identity, at] of Object.entries(this.removedLogins)) out[providerTag(keys, identity)] = { at };
    for (const saved of this.providers) {
      const tag = providerTag(keys, syncIdentity(saved.provider));
      if ((out[tag]?.at ?? -1) <= saved.changedAt) out[tag] = { at: saved.changedAt, provider: saved.provider };
    }
    return out;
  }

  /** Takes in other devices' logins: new providers, newer logins, and removals. Returns whether anything changed. */
  private async applyLogins(logins: Record<string, SharedLogin>, keys: Keys): Promise<boolean> {
    let changed = false;
    for (const [tag, login] of Object.entries(logins)) {
      const mine = this.providers.find((s) => providerTag(keys, syncIdentity(s.provider)) === tag);
      if (mine && mine.changedAt >= login.at) continue;
      const p = login.provider;
      if (!p) {
        if (mine) { await this.removeProvider(mine.id, login.at); changed = true; }
      } else if (mine) {
        await this.saveProviders(this.providers.map((s) => (s.id === mine.id ? { ...s, provider: p, changedAt: login.at } : s)));
        if (mine.id === this.activeId) { this.provider = p; backend.setAllowCleartext(p.allowCleartext); }
        changed = true;
      } else if ((this.removedLogins[syncIdentity(p)] ?? -1) < login.at) {
        const saved: SavedProvider = { id: newProviderId(), provider: p, changedAt: login.at };
        await this.saveProviders([...this.providers, saved]);
        changed = true;
        // A TV with no provider yet starts with the first one shared with it.
        if (!this.activeId) {
          this.route = { name: "home" };
          await this.activate(saved);
        }
      }
    }
    return changed;
  }

  /**
   * A TV with no provider yet joins a household and takes the providers shared with it: links with
   * [code], turns on sharing logins, and signs in with the first one shared.
   */
  async joinForLogins(code: string) {
    this.meta.shareLogins = true;
    this.meta.syncUnlocked = true;
    backend.storeWrite("meta", this.meta, 0);
    await this.startSync(code);
    if (!this.providers.length) {
      throw new SyncError("Linked, but no providers were shared yet. On a device that has them, turn on Settings → Sync → Share provider logins, then try again here.");
    }
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
    const on = !this.favourites.includes(key);
    this.favourites = on ? [key, ...this.favourites] : this.favourites.filter((k) => k !== key);
    this.write("favourites", this.favourites, 0);
    this.ledger.list[key] = [Date.now(), on];
    this.saveLedger();
    this.syncSoon();
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
    this.progress[P.progressKey(url)] = [Math.round(Math.min(Math.max(pos, 0), dur)), Math.round(dur), Date.now()];
    this.write("progress", this.progress, 2000);
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
    this.write("history", this.history, 500);
  }

  /** Plays a history entry: the next episode if the last one reached its credits. */
  resume(h: P.LastWatched) {
    const index = P.continueIndex(h, this.progressOf);
    const aspectKey = h.live ? `live:${P.current(h).id}` : P.isFilm(h) ? `film:${P.current(h).id}` : `series:${h.seriesId ?? h.heading}`;
    this.play({ heading: h.heading, live: h.live, items: h.items, index, seriesId: h.seriesId, art: h.art, aspectKey });
  }

  removeFromHistory(h: P.LastWatched) {
    this.history = this.history.filter((x) => P.slot(x) !== P.slot(h));
    this.write("history", this.history, 0);
    this.ledger.removed[P.slot(h)] = Date.now();
    this.saveLedger();
    this.syncSoon();
  }

  /** Forgets every position and Continue watching (My List stays). With sync on, on every linked device too. */
  clearProgress() {
    this.progress = {};
    this.history = [];
    this.ledger = { ...this.ledger, removed: {}, cleared: Date.now() };
    this.write("progress", this.progress, 0);
    this.write("history", this.history, 0);
    this.saveLedger();
    void this.syncNow();
  }

  /** Leaving the player saves progress, then shares it. */
  closePlayer() {
    this.player = null;
    backend.flushWrites();
    void this.syncNow();
  }

  // ---- Sync ----

  /** Sync is a hidden feature for now: Settings shows it once unlocked, or while this TV is linked. */
  get syncShown() {
    return !!this.meta.syncUnlocked || !!this.sync;
  }

  /** Shows or hides Settings → Sync; returns whether it's now shown. Hiding never unlinks. */
  toggleSyncUnlocked(): boolean {
    this.meta.syncUnlocked = !this.syncShown || !!this.sync;
    backend.storeWrite("meta", this.meta, 0);
    return this.syncShown;
  }

  /** Starts a new household with a fresh code, or joins one with [code]. */
  async startSync(code?: string, relay = DEFAULT_RELAY) {
    const normal = code === undefined ? newCode() : normaliseCode(code);
    if (!normal) throw new SyncError("That code isn't right: it's 16 letters and numbers, like ABCD-EFGH-JKMN-PQRS.");
    if (!relay) throw new SyncError("No sync relay is set.");
    const config: SyncConfig = { code: normal, device: this.sync?.device ?? newDeviceId(), relay };
    await backend.secretSet("sync", JSON.stringify(config));
    this.sync = config;
    await this.syncNow();
    if (this.syncStatus.error) throw new SyncError(this.syncStatus.error);
  }

  /** Takes this computer out of sync: its copy leaves the relay; the other devices keep theirs. */
  async stopSync() {
    const config = this.sync;
    if (!config) return;
    try {
      await leaveRelay(backend.syncTransport, config.relay, deriveKeys(config.code), config.device);
    } catch (e) {
      console.warn("Couldn't remove this device from the relay", e);
    }
    await backend.secretDelete("sync");
    this.sync = null;
    this.syncStatus = { busy: false };
  }

  private syncTimer?: ReturnType<typeof setTimeout>;

  /** After small changes (My List, removals): soon, but once for a burst of them. */
  private syncSoon() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.syncNow(), 3000);
  }

  /**
   * Fetches the other devices' changes, takes in what's newer and shares the result. Never during
   * playback. Each saved provider's records travel in their own section, matched to other devices'
   * by provider tag. The provider in use takes in everything; the others take in progress, My List
   * and removals now, and Continue watching when they're next in use (resolving it needs their
   * lists). With sharing on, logins travel too, and other devices' providers come in.
   */
  async syncNow() {
    const config = this.sync;
    if (!config || this.syncStatus.busy || this.player) return;
    const sharing = !!this.meta.shareLogins;
    // Without a provider there's nothing to sync, except logins shared with this TV.
    if (!this.providers.length && !sharing) return;
    this.syncStatus = { ...this.syncStatus, busy: true, error: undefined };
    try {
      const now = Date.now();
      const keys = deriveKeys(config.code);
      const active = this.activeId;
      const locals = new Map<string, { id: string; local: Local }>();
      for (const saved of this.providers) {
        const local: Local = saved.id === active
          ? ($state.snapshot({ progress: this.progress, history: this.history, favourites: this.favourites, ledger: this.ledger }) as Local)
          : await this.readRecords(saved.id);
        locals.set(providerTag(keys, syncIdentity(saved.provider)), { id: saved.id, local });
      }
      // A version 1 parcel doesn't say whose it is, so it's read as this TV's provider only when
      // there's just the one. With several, it's ignored: taken as the provider in use, an older
      // device's My List would turn up under every provider switched to.
      const current = locals.size === 1 ? [...locals.keys()][0] : null;
      const own = {
        at: now,
        sections: Object.fromEntries([...locals].map(([tag, { local }]) => [tag, toParcel(local, now)])),
        ...(sharing ? { logins: this.ownLogins(keys) } : {}),
      };
      const merged = await syncOnce(backend.syncTransport, config.relay, keys, config.device, own, current, now);
      if (this.sync !== config) return;
      for (const [tag, { id, local }] of locals) {
        const section = merged.sections[tag];
        if (!section) continue;
        const isActive = id === this.activeId;
        const next = await applySync(local, section, (e) => (isActive ? this.resolve(e) : Promise.resolve(null)));
        if (!this.providers.some((p) => p.id === id)) continue;
        if (!isActive) {
          // Not in use (or no longer: a switch meanwhile loads its records afresh).
          if (id !== active) this.writeRecords(id, next);
          continue;
        }
        // Playback may have started meanwhile; its own saves win.
        if (this.player) continue;
        this.progress = next.progress;
        this.history = next.history;
        this.favourites = next.favourites;
        this.ledger = next.ledger;
        this.writeRecords(id, next);
      }
      this.syncStatus = { busy: false, at: Date.now() };
      // New or changed providers from other devices: their records come in on the next round.
      if (sharing && merged.logins && (await this.applyLogins(merged.logins, keys))) this.syncSoon();
    } catch (e) {
      this.syncStatus = { ...this.syncStatus, busy: false, error: e instanceof SyncError ? e.message : "Couldn't reach the sync relay." };
      console.warn("Sync failed", e);
    }
  }

  private saveLedger() {
    this.write("sync-ledger", this.ledger, 0);
  }

  /** Saves one of the active provider's records. */
  private write(name: (typeof RECORDS)[number], value: unknown, delayMs?: number) {
    if (this.activeId) backend.storeWrite(recordName(name, this.activeId), value, delayMs);
  }

  /** A shared history entry as one this computer can play, from its own lists and login. */
  private async resolve(e: HistoryEntry): Promise<P.LastWatched | null> {
    if (e.kind === "film") {
      const f = this.film(e.id);
      return f ? { heading: P.FILM, live: false, index: 0, items: [f], art: f.logo, at: e.at } : null;
    }
    if (e.kind === "live") {
      const c = this.liveChannel(e.id);
      if (!c) return null;
      const items = this.live?.find((g) => g.name === c.group)?.items ?? [c];
      return { heading: "Live TV", live: true, index: Math.max(0, items.findIndex((x) => x.id === c.id)), items, at: e.at };
    }
    const s = e.series ? this.seriesItem(e.series) : undefined;
    const p = this.provider;
    if (!s || !p) return null;
    const data = (await repo.seriesData(p, s, "cache").catch(() => undefined)) ?? (await repo.seriesData(p, s, "network"));
    for (const season of data?.seasons ?? []) {
      const index = season.episodes.findIndex((ep) => ep.id === e.id);
      if (index >= 0) return { heading: s.name, live: false, index, items: season.episodes, seriesId: s.id, art: s.cover, at: e.at };
    }
    return null;
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
}

function parseSync(text: string | null): SyncConfig | null {
  try {
    const c = text ? (JSON.parse(text) as SyncConfig) : null;
    return c && normaliseCode(c.code) && /^[0-9a-f]{16}$/.test(c.device) && c.relay ? c : null;
  } catch {
    return null;
  }
}

function validProvider(p: Provider | null | undefined): Provider | null {
  if (p?.kind === "xtream" && p.server && p.username) return p;
  if (p?.kind === "m3u" && p.url) return p;
  return null;
}

function parseProvider(text: string | null): Provider | null {
  try {
    return text ? validProvider(JSON.parse(text) as Provider) : null;
  } catch {
    return null;
  }
}

function parseProviders(text: string): SavedProvider[] {
  try {
    const list = JSON.parse(text) as SavedProvider[];
    return Array.isArray(list)
      ? list.filter((s) => typeof s?.id === "string" && validProvider(s.provider)).map((s) => ({ ...s, changedAt: Number(s.changedAt) || 0 }))
      : [];
  } catch {
    return [];
  }
}

const newProviderId = () => hex(randomBytes(6));

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
